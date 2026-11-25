// A provider's return to an own page, reached without a device key: only a page that names a callback, only the usual
// fields, and only the page's own yes or no comes back (never its text).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ownCallback } from '../server/lib/own-pages.mjs'

function yard({ callback = '/callback' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'own-cb-'))
  const page = path.join(home, 'pages', 'link')
  fs.mkdirSync(page, { recursive: true })
  fs.writeFileSync(path.join(page, 'page.json'), JSON.stringify({ title: 'Link', script: 'page.js', server: 'server.mjs', ...(callback ? { callback } : {}) }))
  fs.writeFileSync(path.join(page, 'page.js'), 'export function mount() {}\n')
  fs.writeFileSync(path.join(page, 'server.mjs'), `const used = new Set()
export default async function handle({ path, query }) {
  if (path !== '/callback') return { status: 404, body: {} }
  const ok = query.state === 'started-here' && !used.has(query.state)
  used.add(query.state)
  return { ok, text: 'secret account data', type: 'text/html' }
}
`)
  return { BOTYARD_HOME: home }
}

const q = (o) => new URLSearchParams(o)

test('the page it started says yes once; a state it did not start, or a second use, says no', async () => {
  const env = yard()
  assert.deepEqual(await ownCallback('link', q({ code: 'abc', state: 'not-ours' }), { env }), { found: true, ok: false })
  assert.deepEqual(await ownCallback('link', q({ code: 'abc', state: 'started-here' }), { env }), { found: true, ok: true })
  assert.deepEqual(await ownCallback('link', q({ code: 'abc', state: 'started-here' }), { env }), { found: true, ok: false })
})

test('anything but the callback is refused: other fields, no state, a page without a callback, an unknown page', async () => {
  const env = yard()
  assert.equal((await ownCallback('link', q({ code: 'abc', state: 'started-here', extra: '1' }), { env })).ok, false)
  assert.equal((await ownCallback('link', q({ code: '<script>', state: 'started-here' }), { env })).ok, false)
  assert.equal((await ownCallback('link', q({ code: 'abc' }), { env })).ok, false)
  assert.equal((await ownCallback('nope', q({ code: 'abc', state: 'x' }), { env })).found, false)
  assert.equal((await ownCallback('link', q({ code: 'abc', state: 'x' }), { env: yard({ callback: '' }) })).found, false)
})
