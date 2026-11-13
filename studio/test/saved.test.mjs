/**
 * What the page keeps between visits, and who may call the page's API. Pinned: a save from an old
 * version is not written, a save that changes nothing is not written, the document is the page's
 * own to shape, and only the page this service served is answered.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { SAVED_MAX_BYTES, savedStore } from '../server/lib/saved.mjs'
import { fromOwnPage, hostOf, readJson } from '../server/lib/page-guard.mjs'

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saved-')), 'deep', 'map.json')

test('a first save is kept whole and stamped; reading gives it back', async () => {
  let clock = 1000
  const store = savedStore(file(), { now: () => clock })
  assert.deepEqual(store.read(), { updatedAt: 0 })
  const first = await store.save({ bays: { shop: [1, 2] }, night: true, baseUpdatedAt: 0 })
  assert.deepEqual(first, { status: 200, body: { bays: { shop: [1, 2] }, night: true, updatedAt: 1000 } })
  assert.deepEqual(store.read(), first.body)
})

test('a save from an older version is not written, and gets what is on disk', async () => {
  let clock = 1000
  const at = file()
  const store = savedStore(at, { now: () => clock })
  await store.save({ night: false })
  clock = 2000
  const mine = await store.save({ night: true, baseUpdatedAt: 1000 })
  assert.equal(mine.body.updatedAt, 2000)
  const stale = await store.save({ night: false, bays: { x: 1 }, baseUpdatedAt: 1000 })
  assert.deepEqual(stale, { status: 409, body: { night: true, updatedAt: 2000 } })
  assert.deepEqual(JSON.parse(fs.readFileSync(at, 'utf8')), { night: true, updatedAt: 2000 })
  // With the version it was given, the same page's next save goes in.
  clock = 3000
  assert.equal((await store.save({ night: false, bays: { x: 1 }, baseUpdatedAt: 2000 })).status, 200)
})

test('a save that changes nothing writes nothing, whatever order its keys came in', async () => {
  let clock = 1000
  const store = savedStore(file(), { now: () => clock })
  await store.save({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })
  clock = 5000
  const same = await store.save({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1, baseUpdatedAt: 999 })
  assert.deepEqual([same.status, same.body.updatedAt], [200, 1000], 'even from an old version: there is nothing to lose')
})

test('two saves at once are taken one after the other: one wins, the other is told', async () => {
  let clock = 1000
  const store = savedStore(file(), { now: () => clock++ })
  await store.save({ n: 0 })
  const base = store.read().updatedAt
  const out = await Promise.all([store.save({ n: 1, baseUpdatedAt: base }), store.save({ n: 2, baseUpdatedAt: base })])
  assert.deepEqual(out.map((o) => o.status), [200, 409])
  assert.equal(store.read().n, 1)
  assert.ok(store.read().updatedAt > base, 'every written save has a later stamp')
})

test('what is not a document, or is too much, is refused; a file broken by hand starts afresh', async () => {
  const at = file()
  const store = savedStore(at)
  assert.equal((await store.save([1, 2])).status, 400)
  assert.equal((await store.save('text')).status, 400)
  assert.equal((await store.save({ big: 'x'.repeat(SAVED_MAX_BYTES) })).status, 413)
  assert.equal(fs.existsSync(at), false)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.writeFileSync(at, '{ not json')
  assert.deepEqual(store.read(), { updatedAt: 0 })
  assert.equal((await store.save({ ok: true })).status, 200)
  assert.deepEqual(fs.readdirSync(path.dirname(at)), ['map.json'], 'no half-written file is left')
})

test('only the page this service served is answered', () => {
  const names = new Set(['localhost', '127.0.0.1', '::1', '192.168.1.20'])
  const req = (method, host, origin) => ({ method, headers: { host, ...(origin === undefined ? {} : { origin }) } })
  assert.equal(fromOwnPage(req('GET', 'localhost:5274'), names), true)
  assert.equal(fromOwnPage(req('GET', '[::1]:5274'), names), true)
  assert.equal(fromOwnPage(req('GET', '192.168.1.20:5274'), names), true, 'this computer\'s own address on the network')
  assert.equal(fromOwnPage(req('PUT', '127.0.0.1:5274', 'http://127.0.0.1:5274'), names), true)
  // Another site's name pointed at this computer.
  assert.equal(fromOwnPage(req('GET', 'evil.example:5274'), names), false)
  // Another site's page sending a change here.
  assert.equal(fromOwnPage(req('POST', 'localhost:5274', 'https://evil.example'), names), false)
  assert.equal(fromOwnPage(req('GET', 'localhost:5274', 'https://evil.example'), names), false)
  // A change that does not say where it came from is not from a page.
  assert.equal(fromOwnPage(req('POST', 'localhost:5274'), names), false)
  assert.equal(fromOwnPage(req('DELETE', 'localhost:5274', 'null'), names), false)
  assert.equal(fromOwnPage(req('GET', ''), names), false)
  assert.equal(hostOf('HTTP://LocalHost:5274/x'), 'localhost')
  assert.equal(hostOf('not a host at all'), '')
})

test('what a request sends is read up to a size, and refused in words past it or when it is not JSON', async (t) => {
  const server = http.createServer(async (req, res) => {
    try { res.end(JSON.stringify(await readJson(req, 64))) } catch (err) { res.statusCode = err.status || 500; res.end(err.message) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const send = (body) => fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body }).then(async (r) => [r.status, await r.text()], () => [0, 'cut off'])
  assert.deepEqual(await send('{"a":1}'), [200, '{"a":1}'])
  assert.deepEqual(await send(''), [200, '{}'])
  assert.deepEqual(await send('{oops'), [400, 'That was not JSON'])
  const big = await send(JSON.stringify({ a: 'x'.repeat(500) }))
  assert.ok(big[0] === 413 || big[0] === 0, 'too much is refused, or the line is cut')
})
