/**
 * Pages of your own on the map, kept in your home folder and never in the repository.
 *
 * A folder `$BOTYARD_HOME/pages/<name>/` with a `page.json` is a page: the map gets one more entry on
 * its rail, loads the page's script and stylesheet when the entry is opened, and answers the page's
 * own calls under `/api/studio/own/<name>/api/...` with the folder's server file.
 *
 *   page.json   { "title": "Notes", "does": "one line under the title", "script": "page.js",
 *                 "style": "page.css", "server": "server.mjs", "wide": true, "phone": false }
 *   page.js     export function mount(el, tools) { ... }      (in the browser, see src/ui/own-pages.js)
 *   server.mjs  export default async function handle({ method, path, query, body, home, runHelper })
 *               returns { status?, body } for JSON, or { status?, type, text, download? } for a file
 *
 * An own page is code the person at this computer chose to run: its server file runs inside Botyard with
 * everything Botyard may do, and its script runs in the map's page. So nothing here loads unless the
 * folder exists, its name and its manifest are valid and every file it names is inside the folder; and
 * the paths are the map's own, which answer this computer only (api.mjs, isLocalRequest). The phone's
 * door does not pass them on.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { places } from './home.mjs'

export const OWN_PATH = '/api/studio/own'
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const FILE = /^[\w][\w.-]*(\/[\w][\w.-]*)*$/
const MAX_PAGES = 12
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_BODY = 256 * 1024
/** What a page's folder may serve to the browser. Its server file and its manifest are not on the list's way out. */
const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2',
}

export const ownPagesDir = (env = process.env) => path.join(places(env).home, 'pages')

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A file the manifest names, as a path inside the page's real folder, or '' when it is not one. */
function inside(folder, rel) {
  if (typeof rel !== 'string' || !FILE.test(rel) || rel.split('/').some((part) => part.startsWith('.'))) return ''
  let real
  try { real = fs.realpathSync(path.join(folder, rel)) } catch { return '' }
  return real.startsWith(folder + path.sep) && fs.statSync(real).isFile() ? real : ''
}

/**
 * One page from its folder: `{ page }` when it may be loaded, `{ why }` when it may not.
 * The folder may be a link (a page kept in a folder of your own elsewhere); what it names must be inside
 * where the link leads.
 */
export function readOwnPage(dir, name) {
  if (!NAME.test(name)) return { why: 'its folder\'s name must be lower-case letters, digits and dashes, at most 32' }
  let folder
  try { folder = fs.realpathSync(path.join(dir, name)) } catch { return { why: 'its folder cannot be read' } }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'page.json'), 'utf8')) } catch { return { why: 'it has no page.json that is valid JSON' } }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { why: 'its page.json is not an object' }
  const title = text(manifest.title, 24)
  if (!title) return { why: 'its page.json has no "title"' }
  const script = inside(folder, manifest.script)
  if (!script || !/\.m?js$/.test(script)) return { why: 'its "script" must name a .js file inside the folder' }
  const style = manifest.style == null ? '' : inside(folder, manifest.style)
  if (manifest.style != null && !/\.css$/.test(style)) return { why: 'its "style" must name a .css file inside the folder' }
  const server = manifest.server == null ? '' : inside(folder, manifest.server)
  if (manifest.server != null && !/\.mjs$/.test(server)) return { why: 'its "server" must name a .mjs file inside the folder' }
  // "phone": true says the server file answers GET /phone with a view the phone app draws (docs: "A page on the phone").
  if (manifest.phone != null && manifest.phone !== true && manifest.phone !== false) return { why: 'its "phone" must be true or false' }
  if (manifest.phone === true && !server) return { why: 'its "phone" needs a "server" file to answer GET /phone' }
  return { page: { name, title, does: text(manifest.does, 120), wide: manifest.wide !== false, phone: manifest.phone === true, folder, script, style, server } }
}

/** Every own page of this yard, by name, and the folders that are not pages with why. No folder: none. */
export function ownPages(env = process.env) {
  const dir = ownPagesDir(env)
  let names
  try { names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort() } catch { return { pages: [], problems: [] } }
  const pages = []
  const problems = []
  for (const name of names) {
    let isDir = false
    try { isDir = fs.statSync(path.join(dir, name)).isDirectory() } catch { /* a broken link */ }
    if (!isDir) continue
    const { page, why } = readOwnPage(dir, name)
    if (page && pages.length < MAX_PAGES) pages.push(page)
    else problems.push({ name, why: why || `only ${MAX_PAGES} own pages are loaded` })
  }
  return { pages, problems }
}

/** What the map is told of a page: where to load it from, never where it is on the disk. */
const forMap = (p) => ({
  name: p.name, title: p.title, does: p.does, wide: p.wide, phone: p.phone,
  script: `${OWN_PATH}/${p.name}/files/${path.relative(p.folder, p.script).split(path.sep).join('/')}`,
  style: p.style ? `${OWN_PATH}/${p.name}/files/${path.relative(p.folder, p.style).split(path.sep).join('/')}` : '',
})

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** The JSON a page was sent. Too much is read to its end and refused, so the caller hears why. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('That is too much to send to a page'), { status: 413 }))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('The body is not JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/** Newest change in a folder (its files, however deep) with the number of files, so a deleted file counts too. */
function folderStamp(dir, depth = 0) {
  let newest = 0, count = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.isSymbolicLink()) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth >= 6) continue
      const sub = folderStamp(full, depth + 1)
      newest = Math.max(newest, sub.newest); count += sub.count
    } else if (e.isFile()) {
      newest = Math.max(newest, Math.round(fs.statSync(full).mtimeMs)); count += 1
    }
  }
  return { newest, count }
}

const COPIES = path.join(os.tmpdir(), `botyard-own-pages-${process.pid}`)

/**
 * The page's server file, loaded again, with every file it imports, when anything in the folder changed.
 * Node keeps each imported file for good, so the folder is copied under a name that holds its newest
 * change and loaded from there; older copies are deleted.
 */
async function handlerOf(page) {
  const { newest, count } = folderStamp(page.folder)
  const key = `${page.name}-${newest}-${count}`
  const copy = path.join(COPIES, key)
  if (!fs.existsSync(copy)) {
    fs.mkdirSync(COPIES, { recursive: true })
    const part = `${copy}.part-${process.hrtime.bigint()}`
    await fsp.cp(page.folder, part, { recursive: true, filter: (f) => path.basename(f) !== 'node_modules' })
    try { await fsp.rename(part, copy) } catch { await fsp.rm(part, { recursive: true, force: true }) }
    for (const old of fs.readdirSync(COPIES)) {
      if (old.startsWith(`${page.name}-`) && /^\d+-\d+$/.test(old.slice(page.name.length + 1)) && old !== key) {
        await fsp.rm(path.join(COPIES, old), { recursive: true, force: true })
      }
    }
  }
  const file = path.join(copy, path.relative(page.folder, page.server))
  const mod = await import(pathToFileURL(file).href)
  const handle = mod.default || mod.handle
  if (typeof handle !== 'function') throw new Error(`${page.name}'s server file exports no function`)
  return handle
}

/**
 * Answer a call under /api/studio/own. The caller is already known to be this computer's own page
 * (api.mjs checks before it hands on). `runHelper(name)` starts one of the timetable's helpers now.
 */
/**
 * A provider's return to a page of the owner's own (an OAuth-style callback), reached from outside without a device key.
 * Only a page whose page.json names a `callback` route gets one, only GET, only the usual return fields, and the answer is
 * the page's own `ok`, never its text: the caller shows a fixed page. The page itself must check the state it started.
 */
const CALLBACK_FIELDS = { code: /^[\w.~+/=-]{1,1024}$/, state: /^[\w.~-]{1,256}$/, error: /^[\w.~ -]{1,128}$/, error_description: /^[^<>\u0000-\u001f]{1,300}$/ }

export async function ownCallback(name, params, { env = process.env } = {}) {
  const { pages } = ownPages(env)
  const page = pages.find((p) => p.name === name)
  if (!page || !page.server) return { found: false }
  let route = ''
  try { route = String(JSON.parse(fs.readFileSync(path.join(page.folder, 'page.json'), 'utf8')).callback || '') } catch { route = '' }
  if (!/^\/[a-z0-9/-]{1,64}$/.test(route)) return { found: false }
  const query = {}
  for (const [key, value] of params) {
    const rule = CALLBACK_FIELDS[key]
    if (!rule || !rule.test(value) || key in query) return { found: true, ok: false }
    query[key] = value
  }
  if (!query.state || !(query.code || query.error)) return { found: true, ok: false }
  try {
    const out = await (await handlerOf(page))({ method: 'GET', path: route, query, body: {}, home: places(env).home, folder: page.folder })
    return { found: true, ok: out?.ok === true }
  } catch (err) {
    console.log(`[own page ${page.name} callback] ${err?.message || err}`)
    return { found: true, ok: false }
  }
}

export async function ownPagesRequest(req, res, url, { env = process.env, demo = false, runHelper = async () => false } = {}) {
  const rest = url.pathname.slice(OWN_PATH.length).split('/').filter(Boolean)
  // The sample yard is somebody's first look: it shows Botyard, and none of this computer's own pages.
  const { pages, problems } = demo ? { pages: [], problems: [] } : ownPages(env)
  if (!rest.length) {
    if (req.method !== 'GET') return json(res, 405, { error: 'Use GET' })
    return json(res, 200, { pages: pages.map(forMap), problems })
  }
  const page = pages.find((p) => p.name === rest[0])
  if (!page) return json(res, 404, { error: 'This yard has no own page by that name' })

  if (rest[1] === 'files' && req.method === 'GET') {
    const file = inside(page.folder, rest.slice(2).map((part) => { try { return decodeURIComponent(part) } catch { return '\0' } }).join('/'))
    const type = TYPES[path.extname(file)]
    // The server file and the manifest stay on the disk: the browser has no use for either.
    if (!file || !type || file === page.server || path.basename(file) === 'page.json') return json(res, 404, { error: 'The page has no such file' })
    const stat = await fsp.stat(file)
    if (stat.size > MAX_FILE_BYTES) return json(res, 413, { error: 'That file is too big for a page' })
    const body = await fsp.readFile(file)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    return res.end(body)
  }

  if (rest[1] === 'api') {
    if (!page.server) return json(res, 404, { error: 'This page has no server file' })
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Use GET or POST' })
    let body = {}
    try { if (req.method === 'POST') body = await readBody(req) } catch (err) { return json(res, err.status || 400, { error: err.message }) }
    try {
      const handle = await handlerOf(page)
      const out = await handle({
        method: req.method, path: `/${rest.slice(2).join('/')}`, query: Object.fromEntries(url.searchParams),
        body, home: places(env).home, folder: page.folder, runHelper,
      }) || { status: 404, body: { error: 'The page did not answer that' } }
      const status = Number.isInteger(out.status) && out.status >= 200 && out.status < 600 ? out.status : 200
      if (typeof out.text === 'string') {
        const name = text(out.download, 120).replace(/[^\w.-]+/g, '-')
        res.writeHead(status, {
          'Content-Type': text(out.type, 80) || 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(out.text), 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', ...(name ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
        })
        return res.end(out.text)
      }
      return json(res, status, out.body ?? {})
    } catch (err) {
      console.log(`[own page ${page.name}] ${err?.stack || err}`)
      return json(res, 500, { error: `The page "${page.title}" failed: ${String(err?.message || err).slice(0, 200)}` })
    }
  }
  return json(res, 404, { error: 'Not found' })
}
