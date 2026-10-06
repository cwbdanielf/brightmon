#!/usr/bin/env node
// BrightMon local MCP server (stdio). Spawned by Claude Desktop; never
// loaded into Electron. Each tool call opens one NDJSON connection to the
// BrightMon named pipe, sends a single request and returns the result.
// 100% local: no network, no HTTP, nothing leaves this machine.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import net from 'node:net'

import common from '../src/mcp/mcpCommon.js'

const {
  ERRORS,
  REQUEST_TIMEOUT_MS,
  getTokenFilePath,
  buildRequest,
  parseNdjsonBuffer,
  serializeMessage
} = common

const VERSION = typeof __BRIGHTMON_VERSION__ !== 'undefined' ? __BRIGHTMON_VERSION__ : 'dev'

// Read the session token + pipe name written by the running BrightMon
// instance. A missing/stale file means the app is off or MCP is disabled —
// reported before any connection attempt.
function readAuth() {
  let raw
  try {
    raw = readFileSync(getTokenFilePath(), 'utf8')
  } catch (e) {
    const err = new Error('BrightMon is not running or "MCP local" is disabled in its settings.')
    err.code = ERRORS.APP_NOT_RUNNING
    throw err
  }
  let info
  try {
    info = JSON.parse(raw)
  } catch (e) {
    const err = new Error('BrightMon MCP session file is corrupt — toggle "MCP local" off and on in BrightMon.')
    err.code = ERRORS.APP_NOT_RUNNING
    throw err
  }
  if (!info?.pipe || !info?.token) {
    const err = new Error('BrightMon is not running or "MCP local" is disabled in its settings.')
    err.code = ERRORS.APP_NOT_RUNNING
    throw err
  }
  return info
}

// One request per connection: simple, naturally concurrency-safe, and the
// pipe server keeps responses tied to request ids anyway.
function pipeCall(op, params) {
  return new Promise((resolve, reject) => {
    let auth
    try {
      auth = readAuth()
    } catch (e) {
      reject(e)
      return
    }

    const request = buildRequest(op, params, auth.token)
    const state = { buf: '' }
    let settled = false
    let sock

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock?.destroy() } catch (e) { /* ignore */ }
      fn(value)
    }

    const timer = setTimeout(() => {
      const err = new Error(`BrightMon did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s — the command may still have been sent.`)
      err.code = ERRORS.TIMEOUT
      finish(reject, err)
    }, REQUEST_TIMEOUT_MS)

    try {
      sock = net.connect(auth.pipe)
    } catch (e) {
      const err = new Error(`Could not reach BrightMon's local pipe: ${e.message}`)
      err.code = ERRORS.APP_NOT_RUNNING
      finish(reject, err)
      return
    }

    sock.on('connect', () => sock.write(serializeMessage(request)))

    sock.on('data', (chunk) => {
      const { frames, error } = parseNdjsonBuffer(state, chunk)
      if (error) {
        finish(reject, new Error(error.message))
        return
      }
      for (const frame of frames) {
        if (!frame || frame.id !== request.id) continue
        if (frame.ok) {
          finish(resolve, frame.result)
        } else {
          const err = new Error(frame.error?.message || 'Unknown BrightMon error')
          err.code = frame.error?.code || ERRORS.INTERNAL
          finish(reject, err)
        }
      }
    })

    sock.on('error', (e) => {
      const err = new Error('Could not reach BrightMon — it may have just closed or "MCP local" may be off.')
      err.code = ERRORS.APP_NOT_RUNNING
      err.cause = e
      finish(reject, err)
    })

    sock.on('close', () => {
      const err = new Error('Connection to BrightMon closed before a response arrived.')
      err.code = ERRORS.APP_NOT_RUNNING
      finish(reject, err)
    })
  })
}

function ok(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  }
}

function fail(e) {
  const code = typeof e?.code === 'string' ? e.code : ERRORS.INTERNAL
  return {
    content: [{ type: 'text', text: `[${code}] ${e?.message || String(e)}` }],
    isError: true
  }
}

const server = new McpServer({ name: 'brightmon', version: VERSION })

server.registerTool(
  'list_displays',
  {
    title: 'List displays',
    description:
      'List the monitors BrightMon can control: opaque id, display name, current UI position, last-known brightness and capabilities (brightness adjustable, power controllable, hidden). ' +
      'Use the exact `id` in other tools. `uiIndex` follows the current panel order and can change after displays are re-enumerated.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    try {
      return ok(await pipeCall('list_displays', {}))
    } catch (e) {
      return fail(e)
    }
  }
)

server.registerTool(
  'set_brightness',
  {
    title: 'Set display brightness',
    description:
      'Set one display brightness to a percentage (0-100, JSON number — strings rejected). Pass the exact `id` from list_displays. ' +
      'The value is queued through BrightMon\'s pipeline (calibration, HDR/SDR, gamma, WMI or DDC/CI as configured). The response confirms the command was accepted, not that the hardware verified it.',
    inputSchema: {
      id: z.string().describe('Exact display id from list_displays (pass it back unchanged)'),
      brightness: z.number().min(0).max(100).describe('Brightness percentage 0-100 as a JSON number')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  async ({ id, brightness }) => {
    try {
      return ok(await pipeCall('set_brightness', { id, brightness }))
    } catch (e) {
      return fail(e)
    }
  }
)

server.registerTool(
  'turn_off_display',
  {
    title: 'Turn off display',
    description:
      'Send a DDC/CI power-off command to ONE display (requires the display to expose VCP 0xD6 power control and have it enabled in BrightMon). ' +
      'This is an explicit off — it never toggles a display back on and never affects other displays. ' +
      'The response reports command_sent: the monitor powering off is NOT confirmed. Ask the user before using this on a display they may be actively using.',
    inputSchema: {
      id: z.string().describe('Exact display id from list_displays (pass it back unchanged)')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  async ({ id }) => {
    try {
      return ok(await pipeCall('turn_off_display', { id }))
    } catch (e) {
      return fail(e)
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdout is the MCP protocol channel — never log there. stderr is safe.
  console.error(`[brightmon-mcp] connected (v${VERSION})`)
}

main().catch((e) => {
  console.error('[brightmon-mcp] fatal:', e)
  process.exit(1)
})
