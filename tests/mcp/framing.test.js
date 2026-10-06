'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  ERRORS,
  MAX_FRAME_BYTES,
  parseNdjsonBuffer,
  serializeMessage,
  buildRequest
} = require('../../src/mcp/mcpCommon.js')

test('parseNdjsonBuffer: single complete frame', () => {
  const state = {}
  const r = parseNdjsonBuffer(state, '{"a":1}\n')
  assert.strictEqual(r.error, null)
  assert.deepStrictEqual(r.frames, [{ a: 1 }])
  assert.strictEqual(state.buf, '')
})

test('parseNdjsonBuffer: frame split across chunk boundaries', () => {
  const state = {}
  const first = parseNdjsonBuffer(state, '{"op":"list_')
  assert.strictEqual(first.error, null)
  assert.deepStrictEqual(first.frames, [])
  const second = parseNdjsonBuffer(state, 'displays"}\n{"op":"ping"}\n')
  assert.strictEqual(second.error, null)
  assert.deepStrictEqual(second.frames, [{ op: 'list_displays' }, { op: 'ping' }])
  assert.strictEqual(state.buf, '')
})

test('parseNdjsonBuffer: multiple frames in one chunk', () => {
  const state = {}
  const r = parseNdjsonBuffer(state, '{"n":1}\n{"n":2}\n{"n":3}\n')
  assert.deepStrictEqual(r.frames.map(f => f.n), [1, 2, 3])
})

test('parseNdjsonBuffer: CRLF and blank lines tolerated', () => {
  const state = {}
  const r = parseNdjsonBuffer(state, '{"n":1}\r\n\r\n{"n":2}\n')
  assert.strictEqual(r.error, null)
  assert.deepStrictEqual(r.frames.map(f => f.n), [1, 2])
})

test('parseNdjsonBuffer: invalid JSON is fatal bad_request', () => {
  const state = {}
  const r = parseNdjsonBuffer(state, '{"broken":\n')
  assert.strictEqual(r.error.code, ERRORS.BAD_REQUEST)
  assert.deepStrictEqual(r.frames, [])
})

test('parseNdjsonBuffer: oversized frame is fatal bad_request', () => {
  const state = {}
  const big = '{"pad":"' + 'x'.repeat(MAX_FRAME_BYTES) + '"}'
  const r = parseNdjsonBuffer(state, big + '\n')
  assert.strictEqual(r.error.code, ERRORS.BAD_REQUEST)

  // ...and also when the newline never arrives
  const state2 = {}
  const r2 = parseNdjsonBuffer(state2, big)
  assert.strictEqual(r2.error.code, ERRORS.BAD_REQUEST)
})

test('parseNdjsonBuffer: frame at the size limit still passes', () => {
  const state = {}
  // Build a frame just under the byte limit.
  const padding = MAX_FRAME_BYTES - '{"pad":""}'.length - 1 // -1 for \n
  const frame = '{"pad":"' + 'x'.repeat(padding) + '"}\n'
  assert.ok(Buffer.byteLength(frame, 'utf8') <= MAX_FRAME_BYTES + 1)
  const r = parseNdjsonBuffer(state, frame)
  assert.strictEqual(r.error, null)
  assert.strictEqual(r.frames.length, 1)
})

test('serializeMessage ends with a newline', () => {
  const out = serializeMessage({ ok: true })
  assert.ok(out.endsWith('\n'))
  assert.deepStrictEqual(JSON.parse(out), { ok: true })
})

test('buildRequest carries protocol version, id, token and op', () => {
  const req = buildRequest('ping', { x: 1 }, 'tok')
  assert.strictEqual(req.v, 1)
  assert.strictEqual(typeof req.id, 'string')
  assert.strictEqual(req.id.length > 0, true)
  assert.strictEqual(req.token, 'tok')
  assert.strictEqual(req.op, 'ping')
  assert.deepStrictEqual(req.params, { x: 1 })
  const noParams = buildRequest('list_displays', undefined, 'tok')
  assert.deepStrictEqual(noParams.params, {})
})
