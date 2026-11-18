/**
 * Marks on a live local page: the owner points at an element of a page running on this computer (a
 * game's web build, a site in development, the demo yard) and the mark carries the element, the page
 * address and a screenshot.
 *
 * Only pages on this computer: localhost, the loopback addresses and `*.localhost` names. Such a page is
 * opened through a small relay that listens on the loopback address only; it passes everything through
 * unchanged except that a page's HTML gets one script, the pointer, which outlines what is under the
 * mouse and, while the owner is pointing, tells the review sheet what was clicked. Nothing else is
 * changed, and the relay goes when it has not been used for half an hour.
 *
 * The screenshot is taken by a headless browser (any Chromium-family browser on this computer, or
 * `BOTYARD_BROWSER`) at the same size and scroll as the owner's view, so the element's box falls on
 * the same place; the engine then cuts it out like any picture.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EngineError } from './engine.mjs'

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i
const IDLE_MS = 30 * 60 * 1000
const KIT_PATH = '/__botyard-look.js'
const BROWSERS = [
  '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
export const findBrowser = (env = process.env, exists = fs.existsSync) => [env.BOTYARD_BROWSER, ...BROWSERS].find((file) => file && exists(file)) || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page address on this computer, made plain; anything else is refused. */
export function localPage(address) {
  let at
  try { at = new URL(String(address || '').trim()) } catch { throw new EngineError(400, 'Give a page address, such as http://localhost:5173/') }
  if (!/^https?:$/.test(at.protocol)) throw new EngineError(400, 'Only web pages (http) can be marked')
  if (!LOCAL_HOST.test(at.hostname)) throw new EngineError(400, 'Only pages on this computer can be marked: localhost or 127.0.0.1')
  if (at.username || at.password) throw new EngineError(400, 'A page address with a name and password in it is not taken')
  return at
}

/** The pointer the relay puts in a page's HTML. It does nothing until the review sheet asks it to point. */
export const KIT = `(() => {
  if (window.__botyardLook) return; window.__botyardLook = true
  let on = false, box = null
  const parentOrigin = '*'
  const outline = () => { if (!box) { box = document.createElement('div'); box.setAttribute('data-botyard-look', ''); Object.assign(box.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', border: '3px solid #ffc61a', outline: '2px solid #15181d', background: 'rgba(255,198,26,0.14)', borderRadius: '3px', display: 'none' }); document.documentElement.append(box) } return box }
  const nameOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id)
    const parts = []
    for (let n = el; n && n.nodeType === 1 && n !== document.body && parts.length < 4; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break }
      let part = n.tagName.toLowerCase()
      const cls = [...n.classList].filter((c) => !/^(is-|has-|active|hover|focus)/.test(c)).slice(0, 2)
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.')
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : []
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
      parts.unshift(part)
    }
    return parts.join(' > ')
  }
  const show = (el) => { const r = el.getBoundingClientRect(); Object.assign(outline().style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }) }
  addEventListener('message', (e) => { if (e.data && e.data.type === 'botyard-look') { on = Boolean(e.data.on); document.documentElement.style.cursor = on ? 'crosshair' : ''; if (!on && box) box.style.display = 'none' } })
  addEventListener('mousemove', (e) => { if (on && e.target !== box) show(e.target) }, true)
  addEventListener('click', (e) => {
    if (!on) return
    e.preventDefault(); e.stopPropagation()
    // The thing the owner means: the button, link, field or picture the click landed in, not a span inside it.
    const el = e.target.closest('button, a, input, select, textarea, label, img, canvas, video, svg, [role], [id], h1, h2, h3, h4, li, p') || e.target, r = el.getBoundingClientRect()
    parent.postMessage({ type: 'botyard-look-pick', element: nameOf(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.value || '').trim().slice(0, 300),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height }, view: { w: innerWidth, h: innerHeight }, scroll: { x: scrollX, y: scrollY }, path: location.pathname + location.search + location.hash, title: document.title }, parentOrigin)
  }, true)
})()`

/** Put the pointer into a page's HTML: before the end of its head, or at the very start. */
export function withKit(html) {
  const tag = `<script src="${KIT_PATH}"></script>`
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : `${tag}${html}`
}

const relays = new Map()

/** A relay for one local origin, started on first use and closed when idle. @returns its address */
export async function relayFor(origin) {
  const known = relays.get(origin)
  if (known) { known.used = Date.now(); return known.address }
  const target = new URL(origin)
  const server = http.createServer((req, res) => {
    entry.used = Date.now()
    if (req.url === KIT_PATH) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(KIT) }
    const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
    delete headers.origin
    delete headers.referer
    const ask = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, path: req.url, method: req.method, headers }, (up) => {
      const out = { ...up.headers }
      // The page is shown inside the review sheet: rules that forbid a frame, or a script it did not name, are left out.
      for (const h of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'content-length']) delete out[h]
      if (!String(up.headers['content-type'] || '').includes('text/html')) { res.writeHead(up.statusCode || 502, out); return up.pipe(res) }
      const parts = []
      up.on('data', (d) => parts.push(d))
      delete out['transfer-encoding']
      up.on('end', () => { const body = Buffer.from(withKit(Buffer.concat(parts).toString('utf8'))); res.writeHead(up.statusCode || 200, { ...out, 'content-length': body.length }); res.end(body) })
    })
    ask.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('The page on this computer did not answer. Is it running?') })
    req.pipe(ask)
  })
  const entry = { server, used: Date.now(), address: '' }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  // A relay never keeps Botyard (or a test) running by itself.
  server.unref()
  entry.address = `http://127.0.0.1:${server.address().port}`
  relays.set(origin, entry)
  const timer = setInterval(() => { if (Date.now() - entry.used > IDLE_MS) { clearInterval(timer); server.close(); relays.delete(origin) } }, 60_000)
  timer.unref()
  return entry.address
}

/** Open a local page for marking: the relay's address for it, and the page's own. */
export async function openLook(address) {
  const at = localPage(address)
  const relay = await relayFor(at.origin)
  return { url: at.href, origin: at.origin, relay: `${relay}${at.pathname}${at.search}${at.hash}` }
}

/** A screenshot of a local page at a given size and scroll, by a headless browser. PNG bytes. */
export async function pageShot(address, { width = 1280, height = 800, scrollX = 0, scrollY = 0, browser = findBrowser(), waitMs = 1500 } = {}) {
  const at = localPage(address)
  if (!browser) throw new EngineError(501, 'No browser for screenshots on this computer: install Chrome, Chromium, Brave or Edge, or set BOTYARD_BROWSER')
  const w = Math.max(200, Math.min(3840, Math.round(width)))
  const h = Math.max(200, Math.min(2400, Math.round(height)))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-look-'))
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${w},${h}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const stop = () => { try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500) }
  try {
    let ws = ''
    for (let n = 0; n < 100 && !ws; n++) { ws = /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1] || ''; if (!ws) await sleep(100) }
    if (!ws) throw new EngineError(502, 'The browser for screenshots did not start')
    const socket = new WebSocket(ws)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let next = 0
    const waiting = new Map()
    const events = []
    socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result) } else events.push(m.method) })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const cdp = (m, p) => send(m, p, sessionId)
    await cdp('Page.enable')
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await cdp('Page.navigate', { url: at.href })
    for (let n = 0; n < 150 && !events.includes('Page.loadEventFired'); n++) await sleep(100)
    await sleep(waitMs)
    await cdp('Runtime.evaluate', { expression: `scrollTo(${Number(scrollX) || 0}, ${Number(scrollY) || 0})` })
    await sleep(300)
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    socket.close()
    return Buffer.from(data, 'base64')
  } finally {
    stop()
  }
}
