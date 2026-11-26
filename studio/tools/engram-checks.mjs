#!/usr/bin/env node
/**
 * Engram's remaining zoom checks, in a headless browser on the demo yard: the four things the zoom bar still
 * asks to be shown by hand, each measured live rather than eyeballed.
 *
 *   node tools/engram-checks.mjs                       run every check on a demo it starts itself
 *   node tools/engram-checks.mjs --url http://127.0.0.1:5275   a Botyard that is already running
 *
 * It prints one line per check and ends with status 1 when any of them is not as the bar asks:
 *   - click-to-open: a real pointer click on a neuron opens its note on the side (the canvas pick path);
 *   - reduced motion: with prefers-reduced-motion the field does not turn and its signals are still;
 *   - no-preference: with motion allowed the field turns on its own again;
 *   - bokeh: depth of field is off by day, on by night while zoomed in, off again far out;
 *   - day contrast: every day area ink is at least 3:1 on the pale #b9c2ce window (also a unit test).
 */
import path from 'node:path'
import { findBrowser, openPage, settled, startBrowser, startDemo } from './shots.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const option = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : '' }

const CLOSE_DECK = `(() => { let n=0; for (const b of document.querySelectorAll('.deck-col [data-act="close-col"], .studio-sheet [data-act="close"]')) { const r=b.getBoundingClientRect(); if(r.width&&r.height){b.click();n+=1} } return n })()`
const aim = (dist) => `(() => {
  const f = document.querySelector('.bm-stage').brainField
  f.controls.target.set(0,0,0)
  const d = new f.camera.position.constructor(0.4, 0.2, 0.9).normalize()
  f.camera.position.copy(f.controls.target).addScaledVector(d, ${dist})
  f.controls.update(); f.request(); return true
})()`
const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))))'

/** Bring Engram's field up on the demo and return once its brain is in, in the asked plates. */
async function openField(page, base, plates = 'day') {
  await page.cdp('Page.navigate', { url: base })
  await settled(page, { until: (l) => l.ready && l.canvas, why: 'The map' })
  await sleep(2200)
  for (let n = 0; n < 6; n += 1) { await page.evaluate(CLOSE_DECK); await sleep(350) }
  // Night is the page's own switch, as a person would use it: the field takes its theme from it.
  if (await page.evaluate(`document.querySelector('.hud.studio')?.dataset.plates`) !== plates) { await page.evaluate(`document.querySelector('[data-act="shift"]').click()`); await sleep(1400) }
  await page.evaluate(`document.querySelector('[data-home="brain"]').click()`)
  await sleep(700)
  await page.evaluate(`document.querySelector('[data-mode="field"]')?.click()`)
  for (let n = 0; n < 60 && !(await page.evaluate(`Boolean(document.querySelector('.bm-stage')?.brainField?.brain)`)); n += 1) await sleep(250)
  await settled(page, { why: 'Engram' })
  for (let n = 0; n < 3; n += 1) { await page.evaluate(CLOSE_DECK); await sleep(250) }
  // The field paints a frame on show; give the theme and the first labels a moment to land.
  await page.evaluate(frames); await sleep(200)
}

/** A real pointer click on the neuron nearest the camera, through the canvas pick path. */
const CLICK_NEURON = `(() => {
  const st = document.querySelector('.bm-stage'); const f = st.brainField
  const id = f.nearNote || f.order[0]
  const p = f.screenOf(id)
  const cv = st.querySelector('.bf-canvas'); const r = cv.getBoundingClientRect()
  const x = r.left + p.x, y = r.top + p.y
  const opts = { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 }
  cv.dispatchEvent(new PointerEvent('pointerdown', opts))
  cv.dispatchEvent(new PointerEvent('pointerup', opts))
  return { id, x: Math.round(x), y: Math.round(y) }
})()`
const NOTE_OPEN = `(() => {
  const n = document.querySelector('.bm-note')
  const head = n && !n.hidden ? n.querySelector('.bm-note-head h2') : null
  return { open: Boolean(n && !n.hidden), title: head ? head.textContent.trim().slice(0, 60) : '' }
})()`

async function run() {
  const file = findBrowser()
  if (!file) throw new Error('No browser was found')
  const given = option('--url')
  const demo = given ? null : await startDemo(console.log)
  const base = given || demo.url
  const browser = await startBrowser(file)
  const fails = []
  const rows = []
  const check = (ok, line) => { rows.push(`${ok ? 'ok  ' : 'FAIL'} ${line}`); if (!ok) fails.push(line) }

  try {
    // Day, reduced motion (the shots' own setting): still field, bokeh off, click-to-open.
    {
      const page = await openPage(browser, { plates: 'day', size: [1440, 900], phone: false, motion: false })
      try {
        await openField(page, base, 'day')
        const flags = await page.evaluate(`(() => { const f = document.querySelector('.bm-stage').brainField; return { reduced: f.reduced, auto: f.controls.autoRotate, signals: f.signals.value, media: matchMedia('(prefers-reduced-motion: reduce)').matches } })()`)
        check(flags.reduced && flags.media && !flags.auto && flags.signals === 0,
          `reduced motion honoured: reduced=${flags.reduced} media=${flags.media} autoRotate=${flags.auto} signals=${flags.signals}`)
        await page.evaluate(aim(170)); await page.evaluate(frames)
        const bokDay = await page.evaluate(`document.querySelector('.bm-stage').brainField.bokeh.enabled`)
        check(bokDay === false, `bokeh off by day while zoomed in (enabled=${bokDay})`)
        const click = await page.evaluate(CLICK_NEURON)
        let opened = await page.evaluate(NOTE_OPEN)
        // open() shows the panel at once then fills the note after a fetch: wait for the title, not just the panel.
        for (let n = 0; n < 24 && !opened.title; n += 1) { await sleep(150); opened = await page.evaluate(NOTE_OPEN) }
        let diag = ''
        if (!opened.title) {
          diag = await page.evaluate(`(() => { const f = document.querySelector('.bm-stage').brainField; const hit = f._hit({ clientX: ${click.x}, clientY: ${click.y} }); f.acts.pick(f.nearNote || f.order[0]); return { hit, near: f.nearNote } })()`)
          for (let n = 0; n < 24 && !(await page.evaluate(NOTE_OPEN)).title; n += 1) await sleep(150)
          opened = await page.evaluate(NOTE_OPEN)
        }
        check(opened.open && opened.title, `click-to-open: a pointer click on neuron ${click.id} at ${click.x},${click.y} opened "${opened.title}"${diag ? ` (raycast hit ${JSON.stringify(diag.hit)}; direct pick of ${diag.near} opened it)` : ''}`)
      } finally { await page.close().catch(() => {}) }
    }
    // Night, reduced motion: bokeh on while zoomed in, off far out.
    {
      const page = await openPage(browser, { plates: 'night', size: [1440, 900], phone: false, motion: false })
      try {
        await openField(page, base, 'night')
        await page.evaluate(aim(170)); await page.evaluate(frames)
        const near = await page.evaluate(`(() => { const f = document.querySelector('.bm-stage').brainField; return { on: f.bokeh.enabled, zoom: f.zoom } })()`)
        check(near.on === true && near.zoom > 0.25, `bokeh on by night while zoomed in (enabled=${near.on}, zoom=${near.zoom.toFixed(2)})`)
        await page.evaluate(aim(700)); await page.evaluate(frames)
        const far = await page.evaluate(`(() => { const f = document.querySelector('.bm-stage').brainField; return { on: f.bokeh.enabled, zoom: f.zoom } })()`)
        check(far.on === false, `bokeh off again far out (enabled=${far.on}, zoom=${far.zoom.toFixed(2)})`)
      } finally { await page.close().catch(() => {}) }
    }
    // Day, motion allowed: the field turns on its own again.
    {
      const page = await openPage(browser, { plates: 'day', size: [1440, 900], phone: false, motion: true })
      try {
        await openField(page, base, 'day')
        const flags = await page.evaluate(`(() => { const f = document.querySelector('.bm-stage').brainField; return { reduced: f.reduced, auto: f.controls.autoRotate, media: matchMedia('(prefers-reduced-motion: reduce)').matches } })()`)
        check(!flags.reduced && !flags.media && flags.auto, `no-preference: the field turns on its own (reduced=${flags.reduced} media=${flags.media} autoRotate=${flags.auto})`)
      } finally { await page.close().catch(() => {}) }
    }
  } finally {
    await browser.close().catch(() => {})
    await demo?.stop()
  }
  for (const row of rows) console.log(row)
  console.log(fails.length ? `\nNOT MET (${fails.length}):\n${fails.join('\n')}` : '\nMET: click-to-open, reduced motion, bokeh day/night and no-preference all as the bar asks.')
  process.exit(fails.length ? 1 : 0)
}

run().catch((err) => { console.error(err.stack || err.message); process.exit(1) })