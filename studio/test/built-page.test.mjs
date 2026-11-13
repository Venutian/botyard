/**
 * Handing out the built page. Pinned: only files of the build are ever sent, anything else gets
 * the page, hashed files may be kept by the browser for good, and an unchanged file costs nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { builtPage } from '../server/lib/built-page.mjs'

async function serving(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'built-page-'))
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text) }
  fs.writeFileSync(path.join(root, '..', 'outside-secret.txt'), 'not part of the build')
  const server = http.createServer(builtPage(root))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.join(root, '..', 'outside-secret.txt'), { force: true }) })
  const at = `http://127.0.0.1:${server.address().port}`
  const ask = (address, options = {}) => new Promise((resolve, reject) => {
    // Sent as written: a browser's own tidying of `..` must not be what keeps a file safe.
    const req = http.request(`${at}/`, { path: address, method: options.method || 'GET', headers: options.headers || {} }, (res) => { let body = ''; res.on('data', (c) => { body += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })) })
    req.on('error', reject); req.end()
  })
  return { root, ask }
}

test('a file of the build is sent as what it is, and anything else gets the page', async (t) => {
  const { ask } = await serving(t, { 'index.html': '<!doctype html><title>the page</title>', 'assets/app-Dk3f9aQ1.js': 'console.log(1)', 'assets/type-B81kd02x.woff2': 'font', 'icon.svg': '<svg/>', 'docs/index.html': 'docs' })
  const home = await ask('/')
  assert.deepEqual([home.status, home.headers['content-type'], home.body], [200, 'text/html; charset=utf-8', '<!doctype html><title>the page</title>'])
  assert.equal((await ask('/assets/app-Dk3f9aQ1.js')).headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal((await ask('/assets/type-B81kd02x.woff2')).headers['content-type'], 'font/woff2')
  assert.equal((await ask('/icon.svg?v=2')).body, '<svg/>')
  assert.equal((await ask('/docs/')).body, 'docs')
  for (const view of ['/jobs/LH-12', '/some/page/of/the/map', '/assets/gone-00000000.js']) assert.match((await ask(view)).body, /the page/, view)
})

test('no address reaches a file outside the build', async (t) => {
  const { ask } = await serving(t, { 'index.html': 'the page' })
  for (const address of ['/../outside-secret.txt', '/..%2Foutside-secret.txt', '/%2e%2e/outside-secret.txt', '/assets/../../outside-secret.txt', '//etc/passwd', '/%00', '/%E0%A4%A']) {
    const out = await ask(address)
    assert.equal(out.status, 200, address)
    assert.equal(out.body, 'the page', `${address} got the page, not a file`)
  }
})

test('hashed files may be kept for good; the rest is checked each time and costs nothing when unchanged', async (t) => {
  const { ask, root } = await serving(t, { 'index.html': 'the page', 'assets/app-Dk3f9aQ1.js': 'one' })
  assert.equal((await ask('/assets/app-Dk3f9aQ1.js')).headers['cache-control'], 'public, max-age=31536000, immutable')
  const first = await ask('/')
  assert.equal(first.headers['cache-control'], 'no-cache')
  const again = await ask('/', { headers: { 'If-None-Match': first.headers.etag } })
  assert.deepEqual([again.status, again.body], [304, ''])
  const head = await ask('/', { method: 'HEAD' })
  assert.deepEqual([head.status, head.body, head.headers['content-length']], [200, '', '8'])
  assert.equal((await ask('/', { method: 'POST' })).status, 405)
  // A new build while the service runs is handed out without a restart.
  fs.writeFileSync(path.join(root, 'assets', 'app-Zz9y8x7w.js'), 'two')
  fs.writeFileSync(path.join(root, 'index.html'), 'the page, built again')
  fs.utimesSync(path.join(root, 'index.html'), new Date(), new Date(Date.now() + 5000))
  assert.equal((await ask('/assets/app-Zz9y8x7w.js')).body, 'two')
  assert.equal((await ask('/', { headers: { 'If-None-Match': first.headers.etag } })).body, 'the page, built again')
})

test('with no build it says what to run', async (t) => {
  const { ask, root } = await serving(t, { 'readme.txt': 'no page here' })
  const out = await ask('/')
  assert.equal(out.status, 503)
  assert.match(out.body, /npm run build/)
  fs.writeFileSync(path.join(root, 'index.html'), 'built now')
  assert.equal((await ask('/')).body, 'built now')
})
