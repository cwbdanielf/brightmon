'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  ERRORS,
  validateBrightness,
  sortUiOrder,
  resolveDisplay,
  canAdjust,
  canTurnOff,
  buildDisplaySummary,
  getDisplayLabel
} = require('../../src/mcp/mcpCommon.js')

// --- fixtures -------------------------------------------------------------

function makeMonitor(overrides = {}) {
  return Object.assign({
    id: '\\\\?\\DISPLAY#DELL1234#5&1234abcd&0&UID0#{guid}',
    key: '5&1234abcd&0&UID0',
    name: 'DELL U2720Q',
    type: 'ddcci',
    order: 0,
    num: 1,
    brightness: 65,
    hwid: ['DISPLAY', 'DELL1234', '5&1234abcd&0&UID0'],
    features: { '0xD6': [1, 4] }
  }, overrides)
}

const powerSettings = {
  monitorFeatures: { DELL1234: { '0xD6': {} } },
  monitorFeaturesSettings: {},
  hideDisplays: {},
  names: {}
}

const deps = { settings: powerSettings, usesGammaSlider: () => false }

// --- validateBrightness ---------------------------------------------------

test('validateBrightness accepts finite numbers 0-100', () => {
  for (const v of [0, 50, 100, 50.5, 0.1]) {
    assert.strictEqual(validateBrightness(v), true, `expected accept ${v}`)
  }
})

test('validateBrightness rejects strings, junk, booleans and out-of-range', () => {
  for (const v of ['50', '50abc', '', true, false, null, undefined, [], {}, -1, 101, NaN, Infinity, -Infinity]) {
    assert.strictEqual(validateBrightness(v), false, `expected reject ${JSON.stringify(v)}`)
  }
})

// --- sortUiOrder ----------------------------------------------------------

test('sortUiOrder mirrors panel: ascending order, undefined last, stable', () => {
  const list = [
    { name: 'c', order: undefined },
    { name: 'a', order: 1 },
    { name: 'd', order: undefined },
    { name: 'b', order: 0 }
  ]
  const result = sortUiOrder(list)
  assert.deepStrictEqual(result.map(m => m.name), ['b', 'a', 'c', 'd'])
  // input not mutated
  assert.strictEqual(list[0].name, 'c')
})

// --- resolveDisplay -------------------------------------------------------

test('resolveDisplay: exact id matches, never substring', () => {
  const m1 = makeMonitor({ id: 'AAA-111-XYZ' })
  const m2 = makeMonitor({ id: 'AAA-111-XYZ-2', key: 'k2', name: 'SECOND' })
  const list = [m1, m2]

  const exact = resolveDisplay(list, 'AAA-111-XYZ-2', deps)
  assert.strictEqual(exact.monitor, m2)
  assert.strictEqual(exact.uiIndex, 2)

  // A prefix shared by both ids is a substring, not an exact id — it must
  // NOT resolve (legacy dispatcher semantics would match it).
  const substring = resolveDisplay(list, 'AAA-111', deps)
  assert.strictEqual(substring.monitor, undefined)
  assert.strictEqual(substring.error.code, ERRORS.DISPLAY_NOT_FOUND)
})

test('resolveDisplay: "2" and "monitor 2" resolve by UI order', () => {
  const m1 = makeMonitor({ id: 'A', order: 1 })
  const m2 = makeMonitor({ id: 'B', order: 0, key: 'k2', name: 'MSI' })
  const list = [m1, m2] // UI order: B first (order 0), A second

  for (const q of ['2', 'monitor 2', 'Monitor 2', 'MONITOR  2'.replace(/\s+/g, ' ')]) {
    const r = resolveDisplay(list, q, deps)
    assert.strictEqual(r.monitor?.id, 'A', `query ${q}`)
    assert.strictEqual(r.uiIndex, 2)
  }
  const first = resolveDisplay(list, 'monitor 1', deps)
  assert.strictEqual(first.monitor?.id, 'B')

  const missing = resolveDisplay(list, 'monitor 5', deps)
  assert.strictEqual(missing.error.code, ERRORS.DISPLAY_NOT_FOUND)
})

test('resolveDisplay: unique name resolves; duplicate names are ambiguous', () => {
  const a = makeMonitor({ id: 'A', name: 'HDMI-1' })
  const b = makeMonitor({ id: 'B', key: 'k2', name: 'HDMI-1' })
  const c = makeMonitor({ id: 'C', key: 'k3', name: 'DP-1' })

  const unique = resolveDisplay([a, b, c], 'dp-1', deps) // case-insensitive
  assert.strictEqual(unique.monitor.id, 'C')

  const dup = resolveDisplay([a, b, c], 'HDMI-1', deps)
  assert.strictEqual(dup.error.code, ERRORS.AMBIGUOUS_DISPLAY)
})

test('resolveDisplay: renamed display matches UI label, stale id not found', () => {
  const settings = Object.assign({}, powerSettings, { names: { 'A': 'TV da sala' } })
  const m = makeMonitor({ id: 'A' })
  const r = resolveDisplay([m], 'TV da sala (DELL U2720Q)', { settings, usesGammaSlider: () => false })
  assert.strictEqual(r.monitor.id, 'A')

  const stale = resolveDisplay([m], 'GONE-ID', { settings })
  assert.strictEqual(stale.error.code, ERRORS.DISPLAY_NOT_FOUND)
})

test('resolveDisplay: invalid query and empty inventory', () => {
  const empty = resolveDisplay([], 'monitor 1', deps)
  assert.strictEqual(empty.error.code, ERRORS.DISPLAY_NOT_FOUND)
  for (const q of ['', '   ', null, 42]) {
    const r = resolveDisplay([makeMonitor()], q, deps)
    assert.strictEqual(r.error.code, ERRORS.INVALID_PARAMS)
  }
})

// --- canAdjust ------------------------------------------------------------

test('canAdjust: typed displays yes; type none only via HDR active or gamma', () => {
  assert.strictEqual(canAdjust(makeMonitor({ type: 'wmi' }), deps), true)
  assert.strictEqual(canAdjust(makeMonitor({ type: 'software' }), deps), true)
  assert.strictEqual(canAdjust(makeMonitor({ type: 'none' }), deps), false)
  assert.strictEqual(canAdjust(makeMonitor({ type: 'none', hdr: 'active' }), deps), true)
  const gammaDeps = { settings: powerSettings, usesGammaSlider: m => m.gammaBrightness >= 0 }
  assert.strictEqual(canAdjust(makeMonitor({ type: 'none', gammaBrightness: 50 }), gammaDeps), true)
})

// --- canTurnOff -----------------------------------------------------------

test('canTurnOff: truth table mirrors panel power button', () => {
  const on = makeMonitor()
  assert.strictEqual(canTurnOff(on, powerSettings), true)

  // user disabled 0xD6 in monitorFeatures → no
  const featureOff = { monitorFeatures: { DELL1234: {} }, monitorFeaturesSettings: {} }
  assert.strictEqual(canTurnOff(on, featureOff), false)

  // no settings at all
  assert.strictEqual(canTurnOff(on, {}), false)

  // feature enabled but monitor does not report 0xD6 and no custom override (e.g. featuresPending) → no
  const noFeature = makeMonitor({ features: {} })
  assert.strictEqual(canTurnOff(noFeature, powerSettings), false)

  // custom override present → yes (panel shows button)
  const custom = Object.assign({}, powerSettings, {
    monitorFeaturesSettings: { DELL1234: { '0xD6': { enabled: true } } }
  })
  assert.strictEqual(canTurnOff(makeMonitor({ features: {} }), custom), true)

  // monitor without hwid
  assert.strictEqual(canTurnOff({ id: 'x' }, powerSettings), false)
})

// --- buildDisplaySummary / getDisplayLabel --------------------------------

test('summary exposes only safe fields', () => {
  const m = makeMonitor({ serial: 'SECRET-SN', connector: 'HDMI', path: '/dev/secret' })
  const summary = buildDisplaySummary(m, 1, deps)
  assert.deepStrictEqual(Object.keys(summary).sort(),
    ['adjustable', 'brightness', 'hidden', 'id', 'name', 'powerControllable', 'uiIndex'])
  assert.strictEqual(summary.brightness, 65)
  assert.strictEqual(summary.powerControllable, true)
  assert.strictEqual(JSON.stringify(summary).includes('SECRET-SN'), false)
})

test('summary rounds fractional brightness and flags hidden displays', () => {
  const m = makeMonitor({ brightness: 42.7 })
  const hiddenSettings = Object.assign({}, powerSettings, { hideDisplays: { '5&1234abcd&0&UID0': true } })
  const s = buildDisplaySummary(m, 1, { settings: hiddenSettings, usesGammaSlider: () => false })
  assert.strictEqual(s.brightness, 43)
  assert.strictEqual(s.hidden, true)
  assert.strictEqual(s.powerControllable, false)
})

test('getDisplayLabel mirrors panel rename format', () => {
  const m = makeMonitor()
  assert.strictEqual(getDisplayLabel(m, powerSettings), 'DELL U2720Q')
  const renamed = Object.assign({}, powerSettings, { names: { [m.id]: 'Principal' } })
  assert.strictEqual(getDisplayLabel(m, renamed), 'Principal (DELL U2720Q)')
})
