// Pure logic shared by the BrightMon main process (pipe server) and the
// standalone stdio MCP server. Must stay free of Electron imports so it can
// be unit-tested with `node --test` and bundled by esbuild for the .mcpb.
'use strict'

const crypto = require('crypto')
const os = require('os')
const path = require('path')

const PROTOCOL_VERSION = 1
const PIPE_NAME_PREFIX = 'BrightMon-MCP-'
const OPS = ['ping', 'list_displays', 'set_brightness', 'turn_off_display']
const REQUEST_TIMEOUT_MS = 15000
const IDLE_TIMEOUT_MS = 60000
const MAX_FRAME_BYTES = 64 * 1024

const ERRORS = {
  UNAUTHORIZED: 'unauthorized',
  BAD_REQUEST: 'bad_request',
  UNKNOWN_OP: 'unknown_op',
  INVALID_PARAMS: 'invalid_params',
  DISPLAY_NOT_FOUND: 'display_not_found',
  AMBIGUOUS_DISPLAY: 'ambiguous_display',
  DISPLAY_HIDDEN: 'display_hidden',
  NOT_ADJUSTABLE: 'not_adjustable',
  NO_POWER_CAPABILITY: 'no_power_capability',
  REJECTED: 'rejected',
  TIMEOUT: 'timeout',
  INTERNAL: 'internal',
  APP_NOT_RUNNING: 'app_not_running',
  DISABLED: 'disabled'
}

// The token file lives under LOCALAPPDATA (fixed path that works for dev,
// portable and packaged runs alike — app userData differs between them). It
// doubles as the liveness signal: the server deletes it on stop/quit, so a
// stale file from a crashed run is cleaned up on next start and clients can
// detect "not running" before ever connecting.
function getTokenFilePath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'BrightMon', 'mcp.json')
}

// Per-user pipe namespace hint (the token is the real gate). Both sides can
// compute this, but clients should prefer the name from the token file.
function getPipeName() {
  const seed = process.env.USERPROFILE || os.userInfo().username || 'default'
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\${PIPE_NAME_PREFIX}${hash}`
}

function makeId() {
  return crypto.randomUUID()
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex')
}

function makeError(code, message) {
  return { code, message }
}

// --- Framing -------------------------------------------------------------
// UTF-8 NDJSON with a per-connection buffer. Returns parsed frames plus an
// optional fatal error (bad_request); on error the caller must respond once
// and close the connection.
function parseNdjsonBuffer(state, chunk) {
  state.buf = (state.buf || '') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
  const frames = []
  let index
  while ((index = state.buf.indexOf('\n')) >= 0) {
    const line = state.buf.slice(0, index).replace(/\r$/, '')
    state.buf = state.buf.slice(index + 1)
    if (!line.trim()) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      return { frames, error: makeError(ERRORS.BAD_REQUEST, 'Frame exceeds size limit') }
    }
    try {
      frames.push(JSON.parse(line))
    } catch (e) {
      return { frames, error: makeError(ERRORS.BAD_REQUEST, 'Frame is not valid JSON') }
    }
  }
  if (Buffer.byteLength(state.buf, 'utf8') > MAX_FRAME_BYTES) {
    return { frames, error: makeError(ERRORS.BAD_REQUEST, 'Frame exceeds size limit') }
  }
  return { frames, error: null }
}

function serializeMessage(message) {
  return JSON.stringify(message) + '\n'
}

function buildRequest(op, params, token) {
  return { v: PROTOCOL_VERSION, id: makeId(), token, op, params: params || {} }
}

// --- Validation ----------------------------------------------------------
// Strict: JSON number only. Strings ("50", "50abc"), booleans, null and
// non-finite values are all rejected — the main process must never coerce.
function validateBrightness(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

// --- Ordering / identity -------------------------------------------------
// Mirrors the panel sort (src/components/BrightnessPanel.jsx:236-240):
// ascending `order`, missing order sorts last.
function sortUiOrder(list) {
  return list.slice(0).sort((a, b) => {
    const aSort = (a?.order === undefined ? 999 : a.order * 1)
    const bSort = (b?.order === undefined ? 999 : b.order * 1)
    return aSort - bSort
  })
}

// Mirrors getMonitorName (src/components/utilts/monitor.util.js:1-7).
function getDisplayLabel(monitor, settings) {
  const rename = settings?.names?.[monitor?.id]
  if (rename !== undefined && rename !== null && rename !== '') {
    return `${rename} (${monitor.name})`
  }
  return monitor.name
}

function isHidden(monitor, settings) {
  return settings?.hideDisplays?.[monitor?.key] === true
}

// Mirrors isAdjustableDisplay (src/components/utilts/monitor.util.js:27-29)
// plus the HDR-active case the panel also renders a slider for
// (BrightnessPanel.jsx:263). `deps.usesGammaSlider` is injected by the main
// process so the gamma check uses Electron's canUseGammaRamp variant.
function canAdjust(monitor, deps) {
  if (!monitor) return false
  if (monitor.type !== 'none') return true
  if (monitor.hdr === 'active') return true
  if (deps?.usesGammaSlider && deps.usesGammaSlider(monitor)) return true
  return false
}

// Mirrors showPowerButton (src/components/BrightnessPanel.jsx:296-301):
// the user must have enabled VCP 0xD6 for the monitor AND the monitor must
// report the feature (or the custom-feature override must exist).
function canTurnOff(monitor, settings) {
  if (!monitor?.hwid) return false
  const hwidKey = monitor.hwid[1]
  const monitorFeatures = settings?.monitorFeatures?.[hwidKey]
  const customFeatureEnabled = settings?.monitorFeaturesSettings?.[hwidKey]?.['0xD6']
  if (monitorFeatures?.['0xD6'] && (monitor.features?.['0xD6'] || customFeatureEnabled)) {
    return true
  }
  return false
}

// Resolve a tool query against the CURRENT inventory.
//  1. Exact opaque id equality (never substring — the legacy dispatcher
//     matches substrings at src/electron.js:5860-5868 and is unsafe here).
//  2. Human forms resolved against the UI order: "2"/"monitor 2" → 1-based
//     index in sorted order; unique display name (original or label).
// Returns { monitor, uiIndex } or { error }.
function resolveDisplay(monitors, query, deps) {
  const settings = deps?.settings
  const sorted = sortUiOrder(Array.isArray(monitors) ? monitors : Object.values(monitors || {}))
  if (typeof query !== 'string' || query.trim() === '') {
    return { error: makeError(ERRORS.INVALID_PARAMS, 'Display id must be a non-empty string') }
  }
  const wanted = query.trim()

  // 1. Exact opaque id.
  const byId = sorted.find(m => m.id === wanted)
  if (byId) {
    return { monitor: byId, uiIndex: sorted.indexOf(byId) + 1 }
  }

  // 2a. "2" / "monitor 2" / "Monitor 2" → 1-based UI index.
  const numberMatch = wanted.match(/^(?:monitor\s*)?(\d+)$/i)
  if (numberMatch) {
    const wantedIndex = parseInt(numberMatch[1], 10)
    const monitor = sorted[wantedIndex - 1]
    if (monitor) {
      return { monitor, uiIndex: wantedIndex }
    }
    return {
      error: makeError(ERRORS.DISPLAY_NOT_FOUND,
        `No display at position ${wantedIndex} (current list has ${sorted.length})`)
    }
  }

  // 2b. Unique display name — original name or UI label (rename included).
  const wantedLower = wanted.toLowerCase()
  const matches = sorted.filter(m => {
    const label = getDisplayLabel(m, settings)
    return (typeof m.name === 'string' && m.name.toLowerCase() === wantedLower) ||
      (typeof label === 'string' && label.toLowerCase() === wantedLower)
  })
  if (matches.length === 1) {
    return { monitor: matches[0], uiIndex: sorted.indexOf(matches[0]) + 1 }
  }
  if (matches.length > 1) {
    return {
      error: makeError(ERRORS.AMBIGUOUS_DISPLAY,
        `Name "${wanted}" matches ${matches.length} displays — use the exact id from list_displays`)
    }
  }
  return { error: makeError(ERRORS.DISPLAY_NOT_FOUND, `No display matches "${wanted}"`) }
}

// Minimal display summary. Never include serial, hwid, connector or path —
// the id alone is the handle clients may use (and only as given).
function buildDisplaySummary(monitor, uiIndex, deps) {
  const settings = deps?.settings
  const brightness = Number(monitor?.brightness)
  return {
    id: monitor?.id,
    name: getDisplayLabel(monitor, settings),
    uiIndex,
    brightness: Number.isFinite(brightness) ? Math.round(brightness) : null,
    adjustable: canAdjust(monitor, deps),
    powerControllable: !isHidden(monitor, settings) && canTurnOff(monitor, settings),
    hidden: isHidden(monitor, settings)
  }
}

module.exports = {
  PROTOCOL_VERSION,
  PIPE_NAME_PREFIX,
  OPS,
  ERRORS,
  REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  getTokenFilePath,
  getPipeName,
  makeId,
  makeToken,
  makeError,
  parseNdjsonBuffer,
  serializeMessage,
  buildRequest,
  validateBrightness,
  sortUiOrder,
  getDisplayLabel,
  isHidden,
  canAdjust,
  canTurnOff,
  resolveDisplay,
  buildDisplaySummary
}
