#!/usr/bin/env node
/**
 * Takes Botyard's own pictures, from the demo: one command, no hand on the mouse.
 *
 *   node tools/shots.mjs                    every picture into docs/images/
 *   node tools/shots.mjs map night          only these
 *   node tools/shots.mjs --out /tmp/shots   somewhere else
 *   node tools/shots.mjs --url http://127.0.0.1:5275   a Botyard that is already running (default: it starts the demo itself)
 *   node tools/shots.mjs --phone-url http://localhost:8099   also the phone app's picture, from `npm run web` in the top folder
 *
 * It starts `server/studio.mjs --demo` (the real Botyard on the made-up sample yard, with a made-up
 * Setup so a picture never shows what is installed on the computer that took it), opens it in a
 * headless browser at 1440×900, and for each picture goes to the view, waits until the page has
 * stopped changing and the view has something in it, checks that no help sheet or dialog is in
 * the way, and saves a PNG. A picture that could not be taken properly is not saved, and the run
 * ends with status 1 saying which and why.
 *
 * The browser is driven over its own DevTools protocol, so nothing has to be installed: any
 * Chromium-family browser will do (Brave, Chrome, Chromium, Edge). `BOTYARD_BROWSER` names one.
 * The map is 3D; where there is no graphics card the browser draws it in software, which is what
 * the three GL flags below ask for.
 *
 * How it finds its way on the page. If the page offers `window.botyard.show(view, what)` it is
 * used: `view` is one of the names in SHOTS, and it resolves when the view is up. Otherwise the
 * page's own controls are clicked, by the attributes in SHOTS (`[data-tab=…]`, `[data-line]`,
 * `[data-act=open-bot]`, `[data-act=bot-edit]`). Night is the page's own switch (`[data-act=shift]`,
 * or `show('night')`): the yard and the plates are one setting.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDTH = 1440
const HEIGHT = 900
const SETTLE_MS = 900
const VIEW_WAIT_MS = 25_000

/**
 * The pictures. `view` is the word given to the page's own `show`; `clicks` are the controls to
 * click in turn when it has none (each a list of selectors, the first that is there is used; a
 * selector may end in ` >> words` to mean the one whose text holds those words);
 * `atLeast` (with `fewer`) is how much text a view that shows little must say, 300 when not given;
 * `size` is the window, 1440 by 900 when not given; `needs` is how much more text the view must put on the page before it counts as filled.
 */
export const SHOTS = [
  { name: 'crewmap', file: 'crew-map.png', what: 'the crew map: who leads, who does what, who tells whom', view: 'crew', clicks: [], needs: 0 },
  { name: 'crewmap-night', file: 'crew-map-night.png', what: 'the crew map after dark', view: 'crew-night', clicks: [['[data-act="shift"]']], needs: 0, fewer: true, pause: 1500 },
  { name: 'map', file: 'map.png', what: 'the map: the yard with its crew at work', view: 'map', clicks: [['[data-home="yard"]']], needs: 0, fewer: true },
  { name: 'needs', file: 'needs-you.png', what: 'Needs you: what waits for the owner', view: 'needs', clicks: [['[data-tab="attention"]']], needs: 60 },
  { name: 'job', file: 'job.png', what: 'a job with a question from its bot', view: 'job', clicks: [['[data-tab="work"]'], ['[data-line] >> checkout', '.line[data-line]:not(.done)', '[data-line]']], needs: 200 },
  { name: 'run', file: 'run.png', what: 'one run: how it ended, what it used, what the bot did', view: 'run', clicks: [['[data-tab="runs"]'], ['[data-act="open-run"]:not(.failed)', '[data-act="open-run"]']], needs: 200 },
  { name: 'crew', file: 'crew-editor.png', what: 'the crew editor: one bot\'s settings', view: 'bot-edit', clicks: [['[data-tab="bots"]'], ['[data-act="open-bot"] >> Hands out the work', '[data-act="open-bot"]'], ['[data-act="bot-edit"]']], needs: 150 },
  { name: 'rules', file: 'instructions.png', what: 'a bot\'s instructions, with their earlier versions', view: 'bot-rules', clicks: [['[data-tab="bots"]'], ['[data-act="open-bot"] >> Hands out the work', '[data-act="open-bot"]'], ['[data-act="bot-rules"]']], needs: 150 },
  { name: 'setup', file: 'setup.png', what: 'Setup: what is signed in and how to fix what is not', view: 'setup', clicks: [['[data-tab="setup"]']], needs: 200 },
  // Engram, the Brain view, on the demo yard's made-up vault: at 1440 and at a phone's 375, day and night.
  { name: 'engram', file: 'engram.png', what: 'Engram: the notes vault as strata of areas over time', view: 'engram', clicks: [['[data-home="brain"]']], needs: 0, fewer: true, pause: 1200 },
  { name: 'engram-note', file: 'engram-note.png', what: 'Engram with a note open on the side', view: 'engram-note', clicks: [['[data-home="brain"]'], ['[data-mode="list"]'], ['[data-note*="release-when-green"]'], ['[data-mode="field"]']], needs: 0, fewer: true, pause: 1500 },
  { name: 'engram-night', file: 'engram-night.png', what: 'Engram after dark', view: 'engram-night', clicks: [['[data-act="shift"]'], ['[data-home="brain"]']], needs: 0, fewer: true, pause: 1800 },
  { name: 'engram-375', file: 'engram-phone.png', what: 'Engram at a phone\'s width', view: 'engram-375', clicks: [['[data-home="brain"]']], needs: 0, fewer: true, pause: 1200, size: [375, 812], atLeast: 200 },
  { name: 'engram-375-night', file: 'engram-phone-night.png', what: 'Engram at a phone\'s width after dark', view: 'engram-375-night', plates: 'night', clicks: [['[data-home="brain"]']], needs: 0, fewer: true, pause: 1800, size: [375, 812], atLeast: 200 },
  // Night is switched to on the page, as a person would: the map's light follows the switch.
  { name: 'night', file: 'map-night.png', what: 'the map at night, with the work in hand open', view: 'night', clicks: [['[data-act="shift"]'], ['[data-tab="work"]']], needs: 200, pause: 3500 },
  // The phone app is another program (`npm run web` in the top folder): taken only when its address is given.
  { name: 'phone', file: 'phone.png', what: 'the phone app', view: 'phone', clicks: [], needs: 0, phone: true },
]

const BROWSERS = [
  '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
export const findBrowser = (env = process.env, exists = fs.existsSync) => [env.BOTYARD_BROWSER, ...BROWSERS].find((file) => file && exists(file)) || ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

/** Start the demo and wait for its address. */
export async function startDemo(log) {
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(studio, 'server', 'studio.mjs'), '--demo'], { cwd: studio, env: { ...process.env, PORT: String(port), BOTYARD_SETUP: 'sample' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let code = null
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const exited = new Promise((resolve) => child.once('exit', (c) => { code = c ?? -1; resolve() }))
  for (let n = 0; n < 1800 && code === null && !out.includes('Botyard →'); n++) await sleep(100) // the first start builds the page
  if (!out.includes('Botyard →')) { child.kill('SIGTERM'); throw new Error(`The demo did not start:\n${out.trim().split('\n').slice(-6).join('\n')}`) }
  log(`The demo is up on port ${port}.`)
  return { url: `http://127.0.0.1:${port}`, stop: async () => { if (code === null) child.kill('SIGTERM'); await Promise.race([exited, sleep(20000)]); if (code === null) child.kill('SIGKILL') } }
}

/** Start a headless browser and talk to it. */
export async function startBrowser(file) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-shots-'))
  const child = spawn(file, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', 'about:blank',
  // Its own process group: the command is often a small launcher, and the browser it starts must go when this does.
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' })
  let err = ''
  let gone = false
  const exited = new Promise((resolve) => child.once('exit', () => { gone = true; resolve() }))
  child.stderr.on('data', (chunk) => { err += chunk })
  let address = ''
  for (let n = 0; n < 200 && !address; n++) { address = /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1] || ''; if (!address) await sleep(100) }
  const killAll = (signal) => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch { /* already gone */ } }
  const close = async () => {
    if (!gone) killAll('SIGTERM')
    await Promise.race([exited, sleep(4000)])
    killAll('SIGKILL') // whatever of its group is still there
    await sleep(200)
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  if (!address) { await close(); throw new Error(`${path.basename(file)} did not start as a headless browser:\n${err.trim().split('\n').slice(-4).join('\n')}`) }

  const socket = new WebSocket(address)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('The browser\'s DevTools did not answer')), { once: true }) })
  let next = 0
  const waiting = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const mine = waiting.get(message.id)
    if (!mine) return
    waiting.delete(message.id)
    if (message.error) mine.reject(new Error(message.error.message)); else mine.resolve(message.result)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) })
  // Asked to close itself first, which lets it put its own files away; then whatever is left is stopped.
  return { send, close: async () => { await Promise.race([send('Browser.close').catch(() => {}), sleep(2000)]); socket.close(); await close() } }
}

/** One page of the browser, at the picture's size. */
export async function openPage(browser, { plates, phone, size, motion = false }) {
  const [width, height] = size || (phone ? [390, 844] : [WIDTH, HEIGHT])
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => browser.send(method, params, sessionId)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: Boolean(phone) })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: plates === 'night' ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: motion ? 'no-preference' : 'reduce' }] })
  // Before the page's own code runs: the help sheet has been seen, and day or night is chosen.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('botyard.seen-help', '1'); localStorage.setItem('botyard.plates', ${JSON.stringify(plates || 'day')}) } catch {}` })
  const evaluate = async (expression) => {
    const out = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text)
    return out.result.value
  }
  return { cdp, evaluate, close: () => browser.send('Target.closeTarget', { targetId }) }
}

/** What the page looks like to a reader right now: how much it says, and whether something is in the way. */
const LOOK = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 40 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 }
  const inTheWay = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .help, .help-sheet, #help')].filter(shown)
    .filter((el) => /help|shortcut|keys|welcome|got it/i.test((el.id || '') + ' ' + el.className + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '').slice(0, 300)))
  const busy = [...document.querySelectorAll('.loading, .spinner, [aria-busy="true"]')].filter(shown).length
  const canvas = document.querySelector('canvas')
  return { text: document.body ? document.body.innerText.length : 0, inTheWay: inTheWay.length ? (inTheWay[0].innerText || '').trim().slice(0, 60) : '', busy, canvas: Boolean(canvas && canvas.width > 300), ready: Boolean(window.botyard) && document.querySelectorAll('[data-tab], nav button').length > 0 }
})()`

/** Wait until the page has stopped changing; gives what it looks like then. */
export async function settled(page, { until = () => true, ms = VIEW_WAIT_MS, why = 'the page' } = {}) {
  const end = Date.now() + ms
  let last = null
  let same = 0
  while (Date.now() < end) {
    const look = await page.evaluate(LOOK)
    same = last && look.text === last.text && !look.busy ? same + 1 : 0
    last = look
    if (same >= Math.ceil(SETTLE_MS / 300) && until(look)) return look
    await sleep(300)
  }
  throw new Error(`${why} was not ready after ${ms / 1000} seconds${last ? ` (it says ${last.text} characters${last.busy ? ', and is still loading' : ''})` : ''}`)
}

const CLICK = (selectors) => `(() => {
  for (const selector of ${JSON.stringify(selectors)}) {
    const [css, words] = selector.split(' >> ')
    const el = [...document.querySelectorAll(css)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!words || (e.innerText || '').toLowerCase().includes(words.toLowerCase())) })
    if (el) { el.scrollIntoView({ block: 'center' }); if (el.click) el.click(); else el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return selector }
  }
  return ''
})()`

/** Take one picture. Throws, saving nothing, when the view is not properly up. */
async function take(browser, base, shot, outDir) {
  const page = await openPage(browser, shot)
  try {
    await page.cdp('Page.navigate', { url: base })
    if (shot.phone) {
      // The app shows sample data in a plain browser: wait until it has drawn its first screen.
      const look = await settled(page, { until: (now) => now.text > 80, why: 'The phone app' })
      if (look.inTheWay) throw new Error(`a sheet is in the way ("${look.inTheWay}…")`)
      const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, shot.file), Buffer.from(data, 'base64'))
      return { file: path.join(outDir, shot.file), kb: Math.round(Buffer.from(data, 'base64').length / 1024) }
    }
    await settled(page, { until: (look) => look.ready && look.canvas, why: 'The map' })
    // The map draws when something changes: give its models and its first frames time to land.
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 2500))))')
    const before = (await page.evaluate(LOOK)).text
    const hasShow = await page.evaluate('typeof window.botyard?.show === "function"')
    // The page says false for a view its `show` does not know: that one is reached by clicking.
    const shown = hasShow ? await page.evaluate(`Promise.resolve(window.botyard.show(${JSON.stringify(shot.view)})).then(Boolean)`) : false
    if (!shown) {
      for (const selectors of shot.clicks) {
        let clicked = ''
        for (let n = 0; n < 40 && !clicked; n++) { clicked = await page.evaluate(CLICK(selectors)); if (!clicked) await sleep(250) }
        if (!clicked) throw new Error(`nothing on the page matches ${selectors.join(' or ')}: the page has changed, and SHOTS in tools/shots.mjs has to follow`)
        await settled(page, { why: `The view after ${clicked}` })
      }
    }
    if (shot.pause) await sleep(shot.pause)
    // A view that replaces the home's own words (the yard after the crew map) says less, not more: it only has to say something.
    const look = await settled(page, { until: (now) => (shot.fewer ? now.text > (shot.atLeast ?? 300) : now.text >= before + shot.needs), why: `"${shot.what}"` }).catch((err) => { throw new Error(`${err.message}: the view is empty or still loading`) })
    if (look.inTheWay) throw new Error(`a sheet is in the way ("${look.inTheWay}…")`)
    const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const bytes = Buffer.from(data, 'base64')
    // A picture of one flat colour is a map that never drew.
    if (bytes.length < 40_000) throw new Error(`the picture is only ${Math.round(bytes.length / 1024)} KB: the page did not draw`)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, shot.file), bytes)
    return { file: path.join(outDir, shot.file), kb: Math.round(bytes.length / 1024) }
  } finally { await page.close().catch(() => {}) }
}

/** Take the named pictures (all of them when none is named). @returns {{ taken: object[], failed: object[] }} */
export async function takeShots({ names = [], outDir = path.join(studio, 'docs', 'images'), url = '', phoneUrl = '', browser: file = findBrowser(), log = console.log } = {}) {
  const asked = names.length ? SHOTS.filter((shot) => names.includes(shot.name)) : SHOTS
  const wanted = asked.filter((shot) => !shot.phone || phoneUrl)
  for (const shot of asked.filter((one) => one.phone && !phoneUrl)) log(`skip ${shot.name.padEnd(6)} ${shot.what}: start it with \`npm run web\` in the top folder and give its address as --phone-url`)
  const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name))
  if (unknown.length) throw new Error(`No picture is called ${unknown.join(', ')}. There are: ${SHOTS.map((shot) => shot.name).join(', ')}`)
  if (!file) throw new Error('No browser was found. Install Brave, Chrome, Chromium or Edge, or set BOTYARD_BROWSER to one.')
  const demo = url || wanted.every((shot) => shot.phone) ? null : await startDemo(log)
  const taken = []
  const failed = []
  let browser
  try {
    browser = await startBrowser(file)
    for (const shot of wanted) {
      try {
        const out = await take(browser, shot.phone ? phoneUrl : url || demo.url, shot, outDir)
        taken.push({ name: shot.name, ...out })
        log(`ok   ${shot.name.padEnd(6)} ${path.relative(process.cwd(), out.file)} (${out.kb} KB): ${shot.what}`)
      } catch (err) {
        failed.push({ name: shot.name, why: err.message })
        log(`FAIL ${shot.name.padEnd(6)} ${shot.what}: ${err.message}`)
      }
    }
  } finally {
    await browser?.close().catch(() => {})
    await demo?.stop()
  }
  return { taken, failed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : '' }
  const outDir = option('--out')
  const url = option('--url')
  const phoneUrl = option('--phone-url')
  try {
    const { taken, failed } = await takeShots({ names: args, ...(outDir ? { outDir: path.resolve(outDir) } : {}), url, phoneUrl })
    console.log(`\n${taken.length} pictures taken, ${failed.length} not. Look at each before it is published: a script cannot see what a picture shows.`)
    process.exit(failed.length ? 1 : 0)
  } catch (err) { console.error(err.message); process.exit(1) }
}
