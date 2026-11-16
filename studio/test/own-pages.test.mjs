/**
 * Pages of the owner's own, from the home folder: only a valid folder becomes a page, nothing outside
 * the folder is ever served or run, the paths answer this computer's own page only, and the map adds
 * a rail entry and mounts the page's script on a box of its own.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ownPages, ownPagesDir, ownPagesRequest, readOwnPage } from '../server/lib/own-pages.mjs'
import { loadOwnPages, mountOwnPage, ownDock, ownId, ownName, ownTools } from '../src/ui/own-pages.js'

const SERVER = `export default async function handle({ method, path, query, body, home, runHelper }) {
  if (path === '/hello') return { body: { hello: query.to || 'you', method, home } }
  if (path === '/echo' && method === 'POST') return { status: 201, body: { got: body, ran: await runHelper('notes') } }
  if (path === '/file') return { type: 'text/html; charset=utf-8', text: '<p>kept</p>', download: 'my plan.html' }
  if (path === '/boom') throw new Error('it broke')
  return null
}
`

function yard() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-own-'))
  const env = { BOTYARD_HOME: home }
  const page = (name, manifest, files = {}) => {
    const dir = path.join(home, 'pages', name)
    fs.mkdirSync(dir, { recursive: true })
    if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'page.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    }
    return dir
  }
  return { home, env, page, done: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** The routes on a real listener, as api.mjs hands them on. */
async function served(env, run, options = {}) {
  const server = http.createServer((req, res) => ownPagesRequest(req, res, new URL(req.url, 'http://localhost'), { env, ...options }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const at = `http://127.0.0.1:${server.address().port}`
  try { return await run((p, opts) => fetch(at + p, opts)) } finally { server.close() }
}

test('a yard with no pages folder has no own pages, and nothing is made', () => {
  const y = yard()
  try {
    assert.deepEqual(ownPages(y.env), { pages: [], problems: [] })
    assert.equal(fs.existsSync(ownPagesDir(y.env)), false, 'reading the list does not make the folder')
  } finally { y.done() }
})

test('a folder is a page only with a valid name and manifest, and every file it names inside it', () => {
  const y = yard()
  try {
    y.page('notes', { title: 'Notes', does: 'What I keep', script: 'page.js', style: 'page.css', server: 'server.mjs' }, { 'page.js': '', 'page.css': '', 'server.mjs': SERVER })
    y.page('bare', { title: 'Bare', script: 'page.js' }, { 'page.js': '' })
    y.page('no-manifest', undefined, { 'page.js': '' })
    y.page('bad-json', '{ title:', { 'page.js': '' })
    y.page('no-title', { script: 'page.js' }, { 'page.js': '' })
    y.page('no-script', { title: 'X', script: 'gone.js' })
    y.page('climbs', { title: 'X', script: '../notes/page.js' })
    y.page('hidden', { title: 'X', script: '.secret.js' }, { '.secret.js': '' })
    y.page('wrong-server', { title: 'X', script: 'page.js', server: 'server.js' }, { 'page.js': '', 'server.js': '' })
    y.page('Bad_Name', { title: 'X', script: 'page.js' }, { 'page.js': '' })
    // A script that is a link to a file outside the folder is outside the folder.
    const out = y.page('links-out', { title: 'X', script: 'page.js' })
    fs.writeFileSync(path.join(y.home, 'elsewhere.js'), '')
    fs.symlinkSync(path.join(y.home, 'elsewhere.js'), path.join(out, 'page.js'))
    fs.writeFileSync(path.join(y.home, 'pages', 'a-file'), 'not a folder')

    const { pages, problems } = ownPages(y.env)
    assert.deepEqual(pages.map((p) => p.name), ['bare', 'notes'])
    assert.deepEqual(problems.map((p) => p.name).sort(), ['Bad_Name', 'bad-json', 'climbs', 'hidden', 'links-out', 'no-manifest', 'no-script', 'no-title', 'wrong-server'])
    for (const p of problems) assert.ok(p.why.length > 10, `${p.name} says why`)
    const notes = pages.find((p) => p.name === 'notes')
    assert.equal(notes.title, 'Notes')
    assert.equal(notes.does, 'What I keep')
    assert.equal(pages.find((p) => p.name === 'bare').server, '')
  } finally { y.done() }
})

test('a page kept elsewhere and linked into the pages folder is a page, read where the link leads', () => {
  const y = yard()
  try {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-kept-'))
    fs.writeFileSync(path.join(kept, 'page.json'), JSON.stringify({ title: 'Linked', script: 'page.js' }))
    fs.writeFileSync(path.join(kept, 'page.js'), 'export const mount = () => {}')
    fs.mkdirSync(path.join(y.home, 'pages'))
    fs.symlinkSync(kept, path.join(y.home, 'pages', 'linked'))
    const { page } = readOwnPage(path.join(y.home, 'pages'), 'linked')
    assert.equal(page.folder, fs.realpathSync(kept))
    fs.rmSync(kept, { recursive: true, force: true })
  } finally { y.done() }
})

test('the list tells the map where to load a page from and never where it is on the disk', async () => {
  const y = yard()
  try {
    y.page('notes', { title: 'Notes', script: 'ui/page.js', style: 'page.css', server: 'server.mjs' }, { 'ui/page.js': 'export const mount = () => {}', 'page.css': '.x{}', 'server.mjs': SERVER })
    y.page('broken', { title: 'X', script: 'gone.js' })
    await served(y.env, async (get) => {
      const list = await (await get('/api/studio/own')).json()
      assert.deepEqual(list.pages, [{ name: 'notes', title: 'Notes', does: '', wide: true, script: '/api/studio/own/notes/files/ui/page.js', style: '/api/studio/own/notes/files/page.css' }])
      assert.equal(list.problems[0].name, 'broken')
      assert.ok(!JSON.stringify(list).includes(y.home))
      assert.equal((await get('/api/studio/own', { method: 'POST', body: '{}' })).status, 405)
    })
  } finally { y.done() }
})

test('a page\'s files are served from inside its folder only, and its server file and manifest are not', async () => {
  const y = yard()
  try {
    y.page('notes', { title: 'Notes', script: 'page.js', style: 'page.css', server: 'server.mjs' }, { 'page.js': 'export const mount = () => {}', 'page.css': '.x{}', 'server.mjs': SERVER, 'art/pic.svg': '<svg/>', 'notes.txt': 'private', '.env': 'KEY=1' })
    fs.writeFileSync(path.join(y.home, 'secret.json'), '{"key":1}')
    await served(y.env, async (get) => {
      const js = await get('/api/studio/own/notes/files/page.js')
      assert.equal(js.status, 200)
      assert.match(js.headers.get('content-type'), /javascript/)
      assert.equal(js.headers.get('x-content-type-options'), 'nosniff')
      assert.equal((await get('/api/studio/own/notes/files/art/pic.svg')).status, 200)
      for (const not of ['server.mjs', 'page.json', 'notes.txt', '.env', '..%2Fsecret.json', '%2e%2e/%2e%2e/secret.json', 'art', 'nothing.js']) {
        assert.equal((await get(`/api/studio/own/notes/files/${not}`)).status, 404, not)
      }
      assert.equal((await get('/api/studio/own/other/files/page.js')).status, 404, 'a page that is not there')
    })
  } finally { y.done() }
})

test('a page\'s own calls reach its server file: JSON, a file to save, a failure said plainly', async () => {
  const y = yard()
  try {
    y.page('notes', { title: 'Notes', script: 'page.js', server: 'server.mjs' }, { 'page.js': '', 'server.mjs': SERVER })
    y.page('bare', { title: 'Bare', script: 'page.js' }, { 'page.js': '' })
    const asked = []
    await served(y.env, async (get) => {
      assert.deepEqual(await (await get('/api/studio/own/notes/api/hello?to=me')).json(), { hello: 'me', method: 'GET', home: y.home })
      const posted = await get('/api/studio/own/notes/api/echo', { method: 'POST', body: JSON.stringify({ a: 1 }) })
      assert.equal(posted.status, 201)
      assert.deepEqual(await posted.json(), { got: { a: 1 }, ran: true })
      assert.deepEqual(asked, ['notes'])
      const file = await get('/api/studio/own/notes/api/file')
      assert.match(file.headers.get('content-type'), /text\/html/)
      assert.equal(file.headers.get('content-disposition'), 'attachment; filename="my-plan.html"')
      assert.equal(await file.text(), '<p>kept</p>')
      const boom = await get('/api/studio/own/notes/api/boom')
      assert.equal(boom.status, 500)
      assert.match((await boom.json()).error, /The page "Notes" failed: it broke/)
      assert.equal((await get('/api/studio/own/notes/api/unknown')).status, 404)
      assert.equal((await get('/api/studio/own/notes/api/hello', { method: 'DELETE' })).status, 405)
      assert.equal((await get('/api/studio/own/bare/api/hello')).status, 404, 'a page with no server file')
      assert.equal((await get('/api/studio/own/notes/api/echo', { method: 'POST', body: 'x'.repeat(300 * 1024) })).status, 413)
      assert.equal((await get('/api/studio/own/notes/api/echo', { method: 'POST', body: 'not json' })).status, 400)
    }, { runHelper: async (name) => { asked.push(name); return true } })
  } finally { y.done() }
})

test('a changed server file is the one that answers next', async () => {
  const y = yard()
  try {
    const dir = y.page('notes', { title: 'Notes', script: 'page.js', server: 'server.mjs' }, { 'page.js': '', 'server.mjs': 'export default () => ({ body: { v: 1 } })' })
    await served(y.env, async (get) => {
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 1 })
      fs.writeFileSync(path.join(dir, 'server.mjs'), 'export default () => ({ body: { v: 2 } })')
      fs.utimesSync(path.join(dir, 'server.mjs'), new Date(), new Date(Date.now() + 5000))
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 2 })
    })
  } finally { y.done() }
})

test('a changed helper module is loaded fresh with its page, without a restart', async () => {
  const y = yard()
  try {
    const dir = y.page('notes', { title: 'Notes', script: 'page.js', server: 'server.mjs' }, {
      'page.js': '',
      'server.mjs': "import { one } from './lib/helper.mjs'\nexport default () => ({ body: { v: one() } })",
      'lib/helper.mjs': 'export const one = () => 1',
    })
    await served(y.env, async (get) => {
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 1 })
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 1 }, 'unchanged stays as it was')
      fs.writeFileSync(path.join(dir, 'server.mjs'), "import { two } from './lib/helper.mjs'\nexport default () => ({ body: { v: two() } })")
      fs.writeFileSync(path.join(dir, 'lib/helper.mjs'), 'export const two = () => 2')
      const later = new Date(Date.now() + 5000)
      fs.utimesSync(path.join(dir, 'lib/helper.mjs'), later, later)
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 2 })
      // Only the helper changes: the page's own file is untouched.
      fs.writeFileSync(path.join(dir, 'lib/helper.mjs'), 'export const two = () => 3')
      const later2 = new Date(Date.now() + 10000)
      fs.utimesSync(path.join(dir, 'lib/helper.mjs'), later2, later2)
      assert.deepEqual(await (await get('/api/studio/own/notes/api/')).json(), { v: 3 })
    })
  } finally { y.done() }
})

test('the sample yard shows none of this computer\'s own pages', async () => {
  const y = yard()
  try {
    y.page('notes', { title: 'Notes', script: 'page.js', server: 'server.mjs' }, { 'page.js': '', 'server.mjs': SERVER })
    await served(y.env, async (get) => {
      assert.deepEqual(await (await get('/api/studio/own')).json(), { pages: [], problems: [] })
      assert.equal((await get('/api/studio/own/notes/api/hello')).status, 404)
    }, { demo: true })
  } finally { y.done() }
})

test('through the map\'s API the pages answer this computer\'s own page and nobody else', async () => {
  const y = yard()
  const saved = { home: process.env.BOTYARD_HOME, data: process.env.BOTYARD_DATA }
  try {
    y.page('notes', { title: 'Notes', script: 'page.js', server: 'server.mjs' }, { 'page.js': '', 'server.mjs': SERVER })
    process.env.BOTYARD_HOME = y.home
    delete process.env.BOTYARD_DATA
    const { apiMiddleware } = await import(`../server/api.mjs?own-pages-${Date.now()}`)
    const server = http.createServer((req, res) => apiMiddleware(req, res, null))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    try {
      const mine = { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' }
      const list = await (await fetch(`http://127.0.0.1:${port}/api/studio/own`, { headers: mine })).json()
      assert.deepEqual(list.pages.map((p) => p.name), ['notes'])
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/own/notes/api/hello`, { headers: mine })).status, 200)
      // Another site's page, and a post that names no origin at all, are refused before any page's code runs.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/own/notes/api/hello`, { headers: { Origin: 'https://elsewhere.example' } })).status, 403)
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/studio/own/notes/api/echo`, { method: 'POST', body: '{}' })).status, 403)
      // Asked for by another name (a site that points its name at this computer): fetch cannot set Host, so by hand.
      const named = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/studio/own', headers: { Host: 'yard.example' } }, (r) => { r.resume(); resolve(r.statusCode) }).on('error', reject))
      assert.equal(named, 403)
    } finally { server.close() }
  } finally {
    for (const [key, name] of [['home', 'BOTYARD_HOME'], ['data', 'BOTYARD_DATA']]) { if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key] }
    y.done()
  }
})

// ── the map's side ──────────────────────────────────────────────────────────────────

test('the rail gets one entry for each page, named by the page, under an id no screen of the map has', () => {
  assert.deepEqual(ownDock([{ name: 'notes', title: 'Notes', does: 'What I keep' }, { name: 'b', title: 'B', does: '' }]), [
    { id: 'own:notes', name: 'Notes', icon: 'page', screen: true, group: 'own', title: 'What I keep' },
    { id: 'own:b', name: 'B', icon: 'page', screen: true, group: 'own', title: 'B' },
  ])
  assert.equal(ownName(ownId('notes')), 'notes')
  assert.equal(ownName('library'), '')
  assert.equal(ownName(null), '')
})

test('the map takes only pages whose script is the page\'s own file, and none when the server has none', async () => {
  const answer = (body, ok = true) => async () => ({ ok, json: async () => body })
  const good = { name: 'notes', title: 'Notes', script: '/api/studio/own/notes/files/page.js', style: '' }
  assert.deepEqual(await loadOwnPages(answer({ pages: [good, { name: 'x', script: 'https://elsewhere.example/x.js' }, { name: 'Bad', script: '/api/studio/own/Bad/files/p.js' }, null] })), [good])
  assert.deepEqual(await loadOwnPages(answer({}, false)), [])
  assert.deepEqual(await loadOwnPages(answer({ pages: 'no' })), [])
  assert.deepEqual(await loadOwnPages(async () => { throw new Error('down') }), [])
})

/** Just enough of a document for mountOwnPage. */
function fakeDoc() {
  const links = []
  const el = { isConnected: true, innerHTML: '' }
  return {
    links, el,
    doc: {
      head: { append: (l) => links.push(l) },
      querySelector: (q) => links.find((l) => q.includes(`"${l.dataset.ownPage}"`)) || null,
      createElement: () => ({ dataset: {} }),
    },
    body: { set innerHTML(v) { this._html = v }, get innerHTML() { return this._html }, firstElementChild: el },
  }
}

test('a page is mounted on a box of its own, its stylesheet linked once, and its tidy-up handed back', async () => {
  const page = { name: 'notes', title: 'Notes', script: '/api/studio/own/notes/files/page.js', style: '/api/studio/own/notes/files/page.css' }
  const f = fakeDoc()
  const seen = []
  let tidied = 0
  const load = async (src) => ({ mount: (el, tools) => { seen.push([src, el, tools.name]); el.innerHTML = 'drawn'; return () => { tidied += 1 } } })
  const tidy = await mountOwnPage(page, f.body, { name: 'notes' }, { doc: f.doc, load })
  assert.match(f.body.innerHTML, /class="own-page" data-own-page="notes"/)
  assert.deepEqual(seen, [[page.script, f.el, 'notes']])
  assert.equal(f.el.innerHTML, 'drawn')
  tidy()
  assert.equal(tidied, 1)
  await mountOwnPage(page, f.body, {}, { doc: f.doc, load })
  assert.equal(f.links.length, 1, 'the stylesheet is linked once')
  assert.equal(f.links[0].href, page.style)
})

test('a page whose script fails says so in its own box and breaks nothing else', async () => {
  const page = { name: 'notes', title: 'My <notes>', script: '/api/studio/own/notes/files/page.js', style: '' }
  for (const load of [async () => { throw new Error('no such <file>') }, async () => ({}), async () => ({ mount: () => { throw new Error('bad') } })]) {
    const f = fakeDoc()
    const tidy = await mountOwnPage(page, f.body, {}, { doc: f.doc, load })
    assert.match(f.el.innerHTML, /The page "My &lt;notes&gt;" could not be shown/)
    assert.ok(!f.el.innerHTML.includes('<file>'))
    assert.equal(typeof tidy, 'function')
    assert.equal(f.links.length, 0)
  }
})

test('a page\'s calls go to its own server file and nowhere else, and a refusal is said in the server\'s words', async () => {
  const asked = []
  const fetcher = async (url, opts) => { asked.push([url, opts?.method || 'GET', opts?.body]); return url.endsWith('/no') ? { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'Nothing by that name' }) } : { ok: true, json: async () => ({ fine: true }) } }
  const tools = ownTools({ name: 'notes' }, { markdown: (t) => t, toast: () => {}, fetcher })
  assert.deepEqual(await tools.call('/list?x=1'), { fine: true })
  assert.deepEqual(await tools.call('save', { a: 1 }), { fine: true })
  assert.deepEqual(asked, [['/api/studio/own/notes/api/list?x=1', 'GET', undefined], ['/api/studio/own/notes/api/save', 'POST', '{"a":1}']])
  await assert.rejects(tools.call('/no'), /Nothing by that name/)
  assert.equal(tools.url('/file?name=a'), '/api/studio/own/notes/api/file?name=a')
  assert.equal(tools.esc('<b>'), '&lt;b&gt;')
})
