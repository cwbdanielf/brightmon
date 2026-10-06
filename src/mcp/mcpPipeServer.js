// Dedicated local named-pipe server for MCP control. Separate from the
// legacy always-on `\\.\pipe\twinkle-tray\cmds` server: this one has NDJSON
// framing, per-request ids, a session token, an op allowlist and timeouts.
// CommonJS, Node built-ins only — no Electron, no MCP SDK.
'use strict'

const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  PROTOCOL_VERSION,
  OPS,
  ERRORS,
  REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  getTokenFilePath,
  getPipeName,
  makeToken,
  makeError,
  parseNdjsonBuffer,
  serializeMessage
} = require('./mcpCommon.js')

function tokenMatches(expected, received) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  if (expected.length !== received.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
  } catch (e) {
    return false
  }
}

function removeTokenFile() {
  try {
    fs.rmSync(getTokenFilePath(), { force: true })
  } catch (e) { /* best effort */ }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(makeError(
      ERRORS.TIMEOUT,
      `BrightMon did not respond within ${Math.round(ms / 1000)}s — the command may still have been sent`
    )), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// dispatch(op, params) -> Promise<result>; may throw {code, message}.
function createMcpPipeServer({ dispatch, onStatusChange, log }) {
  const logger = typeof log === 'function' ? log : (...args) => console.log(...args)
  const connections = new Set()
  let server = false
  let token = false
  let pipeName = false
  let status = 'stopped'
  let statusError = null
  let since = Date.now()

  function getStatus() {
    return { status, error: statusError, since }
  }

  function setStatus(next, error = null) {
    status = next
    statusError = error
    since = Date.now()
    try { onStatusChange?.(getStatus()) } catch (e) { logger('[MCP] status listener failed', e) }
  }

  function writeTokenFile() {
    const file = getTokenFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      v: PROTOCOL_VERSION,
      pipe: pipeName,
      token,
      pid: process.pid,
      startedAt: Date.now()
    }, null, 2), 'utf8')
  }

  function send(stream, message) {
    if (!stream.destroyed) {
      try { stream.write(serializeMessage(message)) } catch (e) { /* peer gone */ }
    }
  }

  function sendError(stream, id, error) {
    send(stream, { v: PROTOCOL_VERSION, id: id ?? null, ok: false, error: { code: error.code, message: error.message } })
  }

  async function handleMessage(stream, msg, state) {
    // Shape checks before anything else.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) ||
        typeof msg.id !== 'string' || msg.id.length === 0 ||
        typeof msg.op !== 'string') {
      sendError(stream, typeof msg?.id === 'string' ? msg.id : null,
        makeError(ERRORS.BAD_REQUEST, 'Expected {v, id, token, op, params}'))
      stream.end()
      return
    }

    if (!tokenMatches(token, msg.token)) {
      state.authFailures++
      sendError(stream, msg.id, makeError(ERRORS.UNAUTHORIZED, 'Invalid or missing session token'))
      if (state.authFailures >= 3) stream.end()
      return
    }

    if (!OPS.includes(msg.op)) {
      sendError(stream, msg.id, makeError(ERRORS.UNKNOWN_OP, `Unknown operation "${msg.op}"`))
      return
    }

    if (msg.op === 'ping') {
      send(stream, { v: PROTOCOL_VERSION, id: msg.id, ok: true, result: { pong: true, pid: process.pid } })
      return
    }

    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)) ? msg.params : {}

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => dispatch(msg.op, params)),
        REQUEST_TIMEOUT_MS
      )
      send(stream, { v: PROTOCOL_VERSION, id: msg.id, ok: true, result })
    } catch (e) {
      const error = (e && typeof e.code === 'string' && typeof e.message === 'string')
        ? e
        : makeError(ERRORS.INTERNAL, e?.message || String(e))
      sendError(stream, msg.id, error)
    }
  }

  function handleConnection(stream) {
    const state = { buf: '', authFailures: 0 }
    connections.add(stream)
    stream.setTimeout(IDLE_TIMEOUT_MS, () => stream.destroy())
    stream.on('error', () => connections.delete(stream))
    stream.on('close', () => connections.delete(stream))
    stream.on('data', async (chunk) => {
      const { frames, error } = parseNdjsonBuffer(state, chunk)
      if (error) {
        sendError(stream, null, error)
        stream.end()
        return
      }
      // Sequential per connection keeps response order deterministic.
      for (const frame of frames) {
        await handleMessage(stream, frame, state)
        if (stream.destroyed) break
      }
    })
  }

  return {
    start() {
      if (server) return false
      setStatus('starting')
      token = makeToken()
      pipeName = getPipeName()
      const srv = net.createServer(handleConnection)

      srv.on('error', (err) => {
        logger(`[MCP] pipe server error: ${err.message}`)
        try { srv.close() } catch (e) { /* already closed */ }
        if (server === srv) server = false
        token = false
        pipeName = false
        removeTokenFile()
        // A listen failure (EADDRINUSE) or a mid-run fault surfaces as
        // "error"; a plain close after stop() is handled by stop() itself.
        if (status !== 'stopped') setStatus('error', err.message)
      })

      srv.on('listening', () => {
        try {
          writeTokenFile()
          setStatus('running')
          logger(`[MCP] pipe server listening at ${pipeName}`)
        } catch (e) {
          logger(`[MCP] could not write token file: ${e.message}`)
          try { srv.close() } catch (e2) { /* ignore */ }
          server = false
          token = false
          setStatus('error', `Could not write token file: ${e.message}`)
        }
      })

      server = srv
      srv.listen(pipeName)
      return true
    },

    stop() {
      if (!server) return false
      const srv = server
      server = false
      token = false
      pipeName = false
      try { srv.close() } catch (e) { /* ignore */ }
      for (const conn of connections) {
        try { conn.destroy() } catch (e) { /* ignore */ }
      }
      connections.clear()
      removeTokenFile()
      setStatus('stopped')
      logger('[MCP] pipe server stopped')
      return true
    },

    getStatus
  }
}

module.exports = { createMcpPipeServer }
