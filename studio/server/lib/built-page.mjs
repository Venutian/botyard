/**
 * Hands out the built page: the files `npm run build` leaves in `dist/`.
 *
 * What a browser may ask for is decided once, by listing the folder: a request is answered from
 * that list or with the page itself, so no address typed into a browser is ever turned into a
 * place on disk. The list is read again when the folder changes (a new build while the service runs).
 *
 *   - a file of the build      → that file
 *   - anything else            → `index.html` (the page works out its own views from the address)
 *   - files with the build's hash in their name never change, so a browser may keep them for good;
 *     everything else is checked with the server each time, and costs nothing when it is unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'

const KINDS = new Map(Object.entries({
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', glb: 'model/gltf-binary', wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
}))
/** Vite puts a hash in the name of everything under assets/: `name-AbC123xy.ext`. */
const HASHED = /^assets\/.+-[\w-]{8,}\.\w+$/

/** Every file under a folder, as the address a browser asks for it by → what is needed to send it. */
function listBuild(root) {
  const found = new Map()
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const address = prefix + entry.name
      if (entry.isDirectory()) { visit(path.join(dir, entry.name), `${address}/`); continue }
      if (!entry.isFile()) continue
      const file = path.join(dir, entry.name)
      const { size, mtimeMs } = fs.statSync(file)
      found.set(address, {
        file, size, kind: KINDS.get(entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()) || 'application/octet-stream',
        tag: `"${size.toString(36)}-${Math.round(mtimeMs).toString(36)}"`, keep: HASHED.test(address),
      })
    }
  }
  visit(root, '')
  return found
}

/**
 * The answerer for a build folder: `(req, res) => void`. With no build there it says so in words.
 * @param {string} root  the build folder
 */
export function builtPage(root) {
  let listed = null
  let stamp = -1
  const build = () => {
    // The folder's own time changes when a build replaces its files: only then is it listed again.
    let now
    try { now = fs.statSync(path.join(root, 'index.html')).mtimeMs } catch { listed = null; stamp = -1; return null }
    if (!listed || now !== stamp) { listed = listBuild(root); stamp = now }
    return listed
  }

  return function answer(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
    const files = build()
    if (!files) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The page has not been built yet. Run `npm run build` in the studio folder.'); return }
    let asked = ''
    try { asked = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') } catch { /* an address that cannot be read gets the page */ }
    const entry = files.get(asked) || files.get(asked ? `${asked.replace(/\/+$/, '')}/index.html` : 'index.html') || files.get('index.html')
    const headers = { 'Content-Type': entry.kind, ETag: entry.tag, 'Cache-Control': entry.keep ? 'public, max-age=31536000, immutable' : 'no-cache' }
    if (req.headers['if-none-match'] === entry.tag) { res.writeHead(304, headers).end(); return }
    res.writeHead(200, { ...headers, 'Content-Length': entry.size })
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(entry.file).on('error', () => res.destroy()).pipe(res)
  }
}

const stamps = new Map()
/**
 * Which build of the page is being handed out: the hashed name of its entry script in `index.html`
 * (Vite gives it a new name whenever the code changes), or '' with no build. An open page compares it
 * with its own and reloads when they differ, so a window left open (the desktop app, a browser tab)
 * shows the new page after a restart. Read again only when index.html changes.
 */
export function pageBuild(root) {
  const file = path.join(root, 'index.html')
  let mtime = 0
  try { mtime = fs.statSync(file).mtimeMs } catch { return '' }
  const seen = stamps.get(file)
  if (seen && seen.mtime === mtime) return seen.build
  let build = ''
  try { build = /<script[^>]*type="module"[^>]*src="\/?(assets\/[^"]+\.js)"/.exec(fs.readFileSync(file, 'utf8'))?.[1] || '' } catch { /* unreadable: no build */ }
  stamps.set(file, { mtime, build })
  return build
}
