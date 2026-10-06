'use strict'

// End-to-end test of the stdio MCP server against a real local pipe server:
// JSON-RPC initialize → tools/list → tools/call, exercising the exact code
// path Claude Desktop uses (spawn node, speak MCP over stdin/stdout), with
// the BrightMon-side dispatch faked at the pipe boundary.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const { spawn } = require('node:child_process')

const { createMcpPipeServer } = require('../../src/mcp/mcpPipeServer.js')
const common = require('../../src/mcp/mcpCommon.js')

const {
  ERRORS,
  getTokenFilePath,
  validateBrightness,
  resolveDisplay,
  isHidden,
  canAdjust,
  canTurnOff,
  buildDisplaySummary,
  sortUiOrder,
  makeError
} = common

const SERVER_PATH = require('node:path').join(__dirname, '..', '..', 'mcp', 'stdio-server.mjs')

const FIXTURE_SETTINGS = {
  hideDisplays: {},
  names: {},
  monitorFeatures: { AAA: { '0xD6': {} }, BBB: {} },
  monitorFeaturesSettings: {}
}
const FIXTURE_MONITORS = [
  {
    id: '\\\\?\\DISPLAY#AAA#5&111&0&UID0#{guid}',
    key: 'HID-A', name: 'DELL U2720Q', type: 'ddcci', order: 0, brightness: 65,
    hwid: ['DISPLAY', 'AAA', 'HID-A'], features: { '0xD6': [1, 4] }
  },
  {
    id: '\\\\?\\DISPLAY#BBB#5&222&0&UID1#{guid}',
    key: 'HID-B', name: 'LG HDR 4K', type: 'none', order: 1, brightness: 40,
    hwid: ['DISPLAY', 'BBB', 'HID-B'], features: {}
  }
]
const DEPS = { settings: FIXTURE_SETTINGS, usesGammaSlider: () => false }

// Mirror of the electron.js dispatch at the pipe boundary (electron itself
// cannot run in this test; the resolution/validation logic is the shared one).
async function fakeDispatch(op, params) {
  if (op === 'list_displays') {
    const sorted = sortUiOrder(FIXTURE_MONITORS)
    return {
      displays: sorted.map((m, i) => buildDisplaySummary(m, i + 1, DEPS)),
      notes: ['test inventory']
    }
  }
  if (op === 'set_brightness') {
    if (!validateBrightness(params.brightness)) {
      throw makeError(ERRORS.INVALID_PARAMS, 'brightness must be a JSON number between 0 and 100')
    }
    const resolved = resolveDisplay(FIXTURE_MONITORS, params.id, DEPS)
    if (resolved.error) throw resolved.error
    if (isHidden(resolved.monitor, FIXTURE_SETTINGS)) throw makeError(ERRORS.DISPLAY_HIDDEN, 'hidden')
    if (!canAdjust(resolved.monitor, DEPS)) throw makeError(ERRORS.NOT_ADJUSTABLE, 'no control')
    return { status: 'accepted', id: resolved.monitor.id, requestedBrightness: params.brightness, verified: false }
  }
  if (op === 'turn_off_display') {
    const resolved = resolveDisplay(FIXTURE_MONITORS, params.id, DEPS)
    if (resolved.error) throw resolved.error
    if (!canTurnOff(resolved.monitor, FIXTURE_SETTINGS)) {
      throw makeError(ERRORS.NO_POWER_CAPABILITY, 'no VCP 0xD6')
    }
    return { status: 'command_sent', id: resolved.monitor.id, verified: false }
  }
  throw makeError(ERRORS.UNKNOWN_OP, op)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// Never touch a live pipe: a running BrightMon (or a parallel test file)
// owns the pipe name + token file.
function isPortLive() {
  return new Promise((resolve) => {
    const net = require('node:net')
    const sock = net.connect(common.getPipeName())
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch (e) { /* ignore */ } resolve(v) } }
    sock.on('connect', () => finish(true))
    sock.on('error', () => finish(false))
    setTimeout(() => finish(false), 500)
  })
}

// Minimal MCP stdio client: initialize, initialized, then request/response.
function createStdioClient() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: require('node:path').join(__dirname, '..', '..')
  })
  const pending = new Map()
  let buffer = ''
  let nextId = 1

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  child.stderr.on('data', () => { /* diagnostics only */ })

  function request(method, params) {
    const id = nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, 8000)
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      child.stdin.write(JSON.stringify(message) + '\n')
    })
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async function initialize() {
    const res = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '0.0.0' }
    })
    notify('notifications/initialized', {})
    return res
  }

  function close() {
    try { child.stdin.end() } catch (e) { /* ignore */ }
    try { child.kill() } catch (e) { /* ignore */ }
  }

  return { request, notify, initialize, close, child }
}

test('stdio MCP server E2E over a real pipe', async (t) => {
  if (await isPortLive()) {
    t.skip('A live BrightMon MCP pipe already exists — not touching it')
    return
  }
  if (fs.existsSync(getTokenFilePath())) {
    // Only reachable when no pipe is live: stale file from a crashed run.
    try { fs.rmSync(getTokenFilePath(), { force: true }) } catch (e) { /* ignore */ }
  }

  const pipeServer = createMcpPipeServer({
    dispatch: fakeDispatch,
    onStatusChange: () => {},
    log: () => {}
  })
  pipeServer.start()
  const deadline = Date.now() + 3000
  while (pipeServer.getStatus().status !== 'running' && Date.now() < deadline) await sleep(20)
  assert.strictEqual(pipeServer.getStatus().status, 'running')

  const client = createStdioClient()
  try {
    // --- initialize ---
    const init = await client.initialize()
    assert.strictEqual(init.result?.serverInfo?.name, 'brightmon')

    // --- tools/list: exactly our three tools, schema for set_brightness ---
    const tools = await client.request('tools/list', {})
    const names = tools.result.tools.map(t => t.name).sort()
    assert.deepStrictEqual(names, ['list_displays', 'set_brightness', 'turn_off_display'])
    const setTool = tools.result.tools.find(t => t.name === 'set_brightness')
    assert.ok(setTool.inputSchema, 'set_brightness exposes an input schema')
    assert.strictEqual(setTool.inputSchema.type, 'object')
    assert.ok(setTool.inputSchema.properties.brightness)

    // --- list_displays ---
    const list = await client.request('tools/call', { name: 'list_displays', arguments: {} })
    assert.ok(!list.result.isError, JSON.stringify(list.result))
    const payload = JSON.parse(list.result.content[0].text)
    assert.strictEqual(payload.displays.length, 2)
    assert.strictEqual(payload.displays[0].name, 'DELL U2720Q') // order 0 first
    assert.strictEqual(payload.displays[0].powerControllable, true)
    assert.strictEqual(payload.displays[1].powerControllable, false)
    assert.ok(!JSON.stringify(payload).includes('HID-A'), 'no raw hwid keys leaked')
    assert.ok(!JSON.stringify(payload).includes('serial'), 'no serials leaked')

    // --- set_brightness: happy path ---
    const okSet = await client.request('tools/call', {
      name: 'set_brightness',
      arguments: { id: FIXTURE_MONITORS[0].id, brightness: 30 }
    })
    assert.ok(!okSet.result.isError, JSON.stringify(okSet.result))
    const setResult = JSON.parse(okSet.result.content[0].text)
    assert.strictEqual(setResult.status, 'accepted')
    assert.strictEqual(setResult.verified, false)

    // --- set_brightness: string rejected at the SCHEMA layer ---
    const badType = await client.request('tools/call', {
      name: 'set_brightness',
      arguments: { id: FIXTURE_MONITORS[0].id, brightness: '30' }
    })
    assert.strictEqual(badType.result.isError, true, JSON.stringify(badType.result))

    // --- set_brightness: out of range rejected at schema layer ---
    const badRange = await client.request('tools/call', {
      name: 'set_brightness',
      arguments: { id: FIXTURE_MONITORS[0].id, brightness: 150 }
    })
    assert.strictEqual(badRange.result.isError, true)

    // --- set_brightness: unknown id → display_not_found (structured) ---
    const badId = await client.request('tools/call', {
      name: 'set_brightness',
      arguments: { id: 'NOPE', brightness: 50 }
    })
    assert.strictEqual(badId.result.isError, true)
    assert.ok(badId.result.content[0].text.includes(ERRORS.DISPLAY_NOT_FOUND),
      badId.result.content[0].text)

    // --- set_brightness: type "none" display → not_adjustable ---
    const noControl = await client.request('tools/call', {
      name: 'set_brightness',
      arguments: { id: FIXTURE_MONITORS[1].id, brightness: 50 }
    })
    assert.strictEqual(noControl.result.isError, true)
    assert.ok(noControl.result.content[0].text.includes(ERRORS.NOT_ADJUSTABLE))

    // --- turn_off_display: capable → command_sent (honest) ---
    const off = await client.request('tools/call', {
      name: 'turn_off_display',
      arguments: { id: FIXTURE_MONITORS[0].id }
    })
    assert.ok(!off.result.isError, JSON.stringify(off.result))
    const offResult = JSON.parse(off.result.content[0].text)
    assert.strictEqual(offResult.status, 'command_sent')
    assert.strictEqual(offResult.verified, false)

    // --- turn_off_display: incapable → no_power_capability ---
    const offNo = await client.request('tools/call', {
      name: 'turn_off_display',
      arguments: { id: FIXTURE_MONITORS[1].id }
    })
    assert.strictEqual(offNo.result.isError, true)
    assert.ok(offNo.result.content[0].text.includes(ERRORS.NO_POWER_CAPABILITY))

    // --- pipe gone → friendly app_not_running error (stop server first) ---
    pipeServer.stop()
    const afterStop = await client.request('tools/call', { name: 'list_displays', arguments: {} })
    assert.strictEqual(afterStop.result.isError, true)
    assert.ok(afterStop.result.content[0].text.includes(ERRORS.APP_NOT_RUNNING),
      afterStop.result.content[0].text)
  } finally {
    client.close()
    try { pipeServer.stop() } catch (e) { /* ignore */ }
    if (fs.existsSync(getTokenFilePath())) fs.rmSync(getTokenFilePath(), { force: true })
  }
})
