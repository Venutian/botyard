#!/usr/bin/env node
/**
 * Renders the Launch design's pictures headless, with no package to install: any Chromium-family browser
 * (BOTYARD_BROWSER names one) driven over its DevTools protocol.
 *
 *   node docs/design/launch/render.mjs mocks            every mock-up, at 1920x1080, 1440x900 and 390x844, day and night
 *   node docs/design/launch/render.mjs before URL        today's Launch page in a running demo (npm run demo), same sizes
 *
 * A mock-up takes its theme from `?theme=day|night`. It prints, per picture, the page's sideways overflow
 * (scrollWidth - clientWidth of the page and of every scroll box) so "no sideways scroll" is measured, not eyeballed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findBrowser } from '../../../studio/tools/shots.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SIZES = [[1920, 1080], [1440, 900], [390, 844]]
const THEMES = ['day', 'night']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browser() {
  const file = findBrowser()
  if (!file) throw new Error('No Chromium-family browser found; set BOTYARD_BROWSER')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-design-'))
  const child = spawn(file, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let err = ''
  child.stderr.on('data', (c) => { err += c })
  let address = ''
  for (let n = 0; n < 200 && !address; n++) { address = /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1] || ''; if (!address) await sleep(100) }
  if (!address) throw new Error(`The browser did not start: ${err.slice(-300)}`)
  const socket = new WebSocket(address)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let next = 0
  const waiting = new Map()
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result) })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) })
  return {
    async page([width, height]) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      const s = (m, p) => send(m, p, sessionId)
      await s('Page.enable'); await s('Runtime.enable')
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
      const evaluate = async (expr) => (await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value
      return {
        evaluate,
        async go(url) { await s('Page.navigate', { url }); for (let n = 0; n < 100; n++) { if (await evaluate('document.readyState') === 'complete') break; await sleep(100) } },
        async shot(file, full = false) {
          let clip
          if (full) { const h = await evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'); clip = { x: 0, y: 0, width, height: Math.max(h, height), scale: 1 } }
          const { data } = await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) })
          fs.writeFileSync(file, Buffer.from(data, 'base64'))
        },
        close: () => send('Target.closeTarget', { targetId }),
      }
    },
    close: async () => { await send('Browser.close').catch(() => {}); socket.close(); try { process.kill(-child.pid, 'SIGKILL') } catch {} fs.rmSync(profile, { recursive: true, force: true }) },
  }
}

// Sideways overflow of the page and of any box that scrolls sideways: 0 means none.
const OVERFLOW = `(() => { const d = document.documentElement; const boxes = [...document.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return /auto|scroll/.test(cs.overflowX) && e.scrollWidth - e.clientWidth > 1 && e.clientWidth > 0 }); return { page: d.scrollWidth - d.clientWidth, boxes: boxes.map((e) => (e.className || e.tagName) + ':' + (e.scrollWidth - e.clientWidth)) } })()`

async function mocks() {
  const out = path.join(here, 'renders')
  fs.mkdirSync(out, { recursive: true })
  const files = fs.readdirSync(path.join(here, 'mock')).filter((f) => /^direction-.*\.html$/.test(f))
  const b = await browser()
  try {
    for (const f of files) for (const size of SIZES) for (const theme of THEMES) {
      const p = await b.page(size)
      await p.go(`${pathToFileURL(path.join(here, 'mock', f)).href}?theme=${theme}`)
      await sleep(250)
      const name = `${f.replace('.html', '')}-${size[0]}-${theme}.png`
      await p.shot(path.join(out, name))
      console.log(name, JSON.stringify(await p.evaluate(OVERFLOW)))
      // The whole page on a phone: the sheet's own scroll is let out so the picture holds everything.
      if (size[0] === 390) { await p.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>html,body{height:auto}.sheet{position:relative;top:52px}.sheet-body{overflow:visible}</style>')`); await sleep(150); await p.shot(path.join(out, name.replace('.png', '-full.png')), true) }
      await p.close()
    }
    // The chosen direction's other states, at 1440 and on a phone, day and night.
    for (const st of ['checking', 'clear', 'empty', 'focus']) for (const size of [[1440, 900], [390, 844]]) for (const theme of THEMES) {
      if (st === 'focus' && size[0] === 390) continue
      const p = await b.page(size)
      await p.go(`${pathToFileURL(path.join(here, 'mock', 'direction-a-yours-first.html')).href}?theme=${theme}&state=${st}`)
      await sleep(250)
      const name = `chosen-state-${st}-${size[0]}-${theme}.png`
      await p.shot(path.join(out, name))
      console.log(name, JSON.stringify(await p.evaluate(OVERFLOW)))
      await p.close()
    }
  } finally { await b.close() }
}

async function before(url) {
  const out = path.join(here, 'before')
  fs.mkdirSync(out, { recursive: true })
  const b = await browser()
  try {
    for (const size of SIZES) for (const theme of THEMES) {
      const p = await b.page(size)
      await p.go(url)
      await sleep(4000)
      if ((await p.evaluate(`document.querySelector('.hud.studio')?.dataset.plates || 'day'`)) !== theme) { await p.evaluate(`document.querySelector('[data-act="shift"]')?.click()`); await sleep(1500) }
      await p.evaluate(`(document.querySelector('[data-tab="launch"]') || [...document.querySelectorAll('button')].find((e) => /Launch/.test(e.textContent)))?.click()`)
      await sleep(2500)
      const name = `before-${size[0]}-${theme}.png`
      await p.shot(path.join(out, name))
      console.log(name, JSON.stringify(await p.evaluate(OVERFLOW)))
      await p.close()
    }
  } finally { await b.close() }
}

const [what, url] = process.argv.slice(2)
if (what === 'before') await before(url || 'http://127.0.0.1:5275')
else await mocks()
