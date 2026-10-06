'use strict'

// Integration test for the MCP pipe server: lifecycle, token file, auth,
// framing and dispatch contract. Runs against a real named pipe — no
// Electron required. Skipped when a live BrightMon instance already owns
// the pipe/token file so it can never clobber a running app.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const net = require('net')

const { createMcpPipeServer } = require('../../src/mcp/mcpPipeServer.js')
const {
  ERRORS,
  getTokenFilePath,
  getPipeName,
  parseNdjsonBuffer,
  serializeMessage,
  buildRequest,
  PROTOCOL_VERSION
} = require('../../src/mcp/mcpCommon.js')

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}

// Open one connection, send the given frames, collect responses until we
// have `expected` of them, the server closes, or we time out.
function rpc(frames, expected, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const responses = []
    const state = { buf: '' }
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        try { sock.destroy() } catch (e) { /* ignore */ }
        resolve(responses)
      }
    }
    const sock = net.connect(getPipeName())
    sock.on('connect', () => {
      for (const frame of frames) sock.write(serializeMessage(frame))
    })
    sock.on('data', (chunk) => {
      const { frames: lines, error } = parseNdjsonBuffer(state, chunk)
      if (error) {
        responses.push({ ok: false, error })
        finish()
        return
      }
      for (const line of lines) responses.push(line)
      if (responses.length >= expected) finish()
    })
    sock.on('error', () => finish())
    sock.on('close', () => finish())
    setTimeout(finish, timeoutMs)
  })
}

function isPortLive() {
  return new Promise((resolve) => {
    const sock = net.connect(getPipeName())
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch (e) {} resolve(v) } }
    sock.on('connect', () => finish(true))
    sock.on('error', () => finish(false))
    setTimeout(() => finish(false), 500)
  })
}

test('mcp pipe server: lifecycle, auth, framing, dispatch contract', async (t) => {
  if (await isPortLive()) {
    t.skip('A live BrightMon MCP pipe already exists — not touching it')
    return
  }

  const tokenFile = getTokenFilePath()
  const preExisting = fs.existsSync(tokenFile)
  if (preExisting) {
    // Stale file from a crashed run; server start overwrites it anyway.
    fs.rmSync(tokenFile, { force: true })
  }

  const dispatched = []
  const statuses = []
  const server = createMcpPipeServer({
    dispatch: async (op, params) => {
      dispatched.push({ op, params })
      if (op === 'list_displays') return { displays: [] }
      if (params?.failWith) {
        const { makeError } = require('../../src/mcp/mcpCommon.js')
        throw makeError(params.failWith, 'dispatch failed on purpose')
      }
      if (params?.slow) await sleep(25)
      return { status: 'ok' }
    },
    onStatusChange: (state) => statuses.push(state.status),
    log: () => {}
  })

  try {
    // --- start / token file ---
    server.start()
    assert.strictEqual(await waitFor(() => server.getStatus().status === 'running'), true, 'server should reach running')
    assert.ok(fs.existsSync(tokenFile), 'token file written on start')
    const info = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    assert.strictEqual(info.pipe, getPipeName())
    assert.strictEqual(typeof info.token, 'string')
    assert.strictEqual(info.token.length, 64)
    assert.strictEqual(info.v, PROTOCOL_VERSION)

    const goodToken = info.token

    // --- ping with valid token ---
    const ping = buildRequest('ping', {}, goodToken)
    const pingResponses = await rpc([ping], 1)
    assert.strictEqual(pingResponses.length, 1)
    assert.strictEqual(pingResponses[0].ok, true)
    assert.strictEqual(pingResponses[0].id, ping.id)
    assert.strictEqual(pingResponses[0].result.pong, true)

    // --- allowlist: unknown op rejected before dispatch ---
    const bogus = buildRequest('set_vcp_raw', { code: '0x10' }, goodToken)
    const bogusResponses = await rpc([bogus], 1)
    assert.strictEqual(bogusResponses[0].ok, false)
    assert.strictEqual(bogusResponses[0].error.code, ERRORS.UNKNOWN_OP)
    assert.strictEqual(dispatched.some(d => d.op === 'set_vcp_raw'), false, 'unknown op must not reach dispatch')

    // --- bad token: unauthorized, dispatch untouched ---
    const bad = buildRequest('list_displays', {}, 'f'.repeat(64))
    const badResponses = await rpc([bad], 1)
    assert.strictEqual(badResponses[0].ok, false)
    assert.strictEqual(badResponses[0].error.code, ERRORS.UNAUTHORIZED)
    assert.strictEqual(dispatched.length, 0, 'no dispatch before auth')

    // --- malformed JSON: bad_request then server closes the connection ---
    const malformed = await new Promise((resolve) => {
      const responses = []
      const state = { buf: '' }
      const sock = net.connect(getPipeName())
      sock.on('connect', () => sock.write('{not json\n'))
      sock.on('data', (chunk) => {
        const { frames } = parseNdjsonBuffer(state, chunk)
        responses.push(...frames)
      })
      sock.on('close', () => resolve(responses))
      sock.on('error', () => resolve(responses))
      setTimeout(() => { try { sock.destroy() } catch (e) {} resolve(responses) }, 2000)
    })
    assert.strictEqual(malformed.length, 1)
    assert.strictEqual(malformed[0].ok, false)
    assert.strictEqual(malformed[0].error.code, ERRORS.BAD_REQUEST)

    // --- dispatch ok + params forwarded ---
    const list = buildRequest('list_displays', {}, goodToken)
    const listResponses = await rpc([list], 1)
    assert.strictEqual(listResponses[0].ok, true)
    assert.deepStrictEqual(listResponses[0].result, { displays: [] })

    // --- dispatch error surfaces as structured MCP error ---
    const fail = buildRequest('set_brightness', { failWith: ERRORS.DISPLAY_NOT_FOUND }, goodToken)
    const failResponses = await rpc([fail], 1)
    assert.strictEqual(failResponses[0].ok, false)
    assert.strictEqual(failResponses[0].error.code, ERRORS.DISPLAY_NOT_FOUND)
    assert.strictEqual(failResponses[0].id, fail.id)

    // --- multiple requests on one connection, ids echoed ---
    const r1 = buildRequest('ping', {}, goodToken)
    const r2 = buildRequest('ping', {}, goodToken)
    const multi = await rpc([r1, r2], 2)
    assert.deepStrictEqual(multi.map(r => r.id).sort(), [r1.id, r2.id].sort())
    assert.ok(dispatched.every(d => d.op !== 'ping'), 'ping handled server-side')

    // --- stop: token file removed, status stopped, pipe refuses new work ---
    server.stop()
    assert.strictEqual(server.getStatus().status, 'stopped')
    assert.strictEqual(fs.existsSync(tokenFile), false, 'token file removed on stop')
    let pipeGone = false
    const goneDeadline = Date.now() + 2000
    while (Date.now() < goneDeadline) {
      if (!(await isPortLive())) { pipeGone = true; break }
      await sleep(20)
    }
    assert.strictEqual(pipeGone, true, 'pipe gone after stop')
    assert.deepStrictEqual(statuses, ['starting', 'running', 'stopped'])
  } finally {
    try { server.stop() } catch (e) { /* ignore */ }
    if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile, { force: true })
  }
})
