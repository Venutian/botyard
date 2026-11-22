#!/usr/bin/env node
/**
 * Engram's immersive zoom, measured in a headless browser on the demo yard: how many neuron titles are on the
 * stage, whether the nearest note's excerpt stays inside it, whether any two titles overlap, and whether the
 * pooled title plates are really gone (computed display none) once the camera backs out again.
 *
 *   node tools/engram-zoom-probe.mjs                       measure at 1440x900 and 375x812, day and night
 *   node tools/engram-zoom-probe.mjs --url http://127.0.0.1:5275   a Botyard that is already running
 *   node tools/engram-zoom-probe.mjs --shots docs/images   also save the four zoom pictures there
 *
 * Before measuring it closes every open sheet of the deck (the first-run welcome among them), opens Engram,
 * and refuses to go on while a `.deck-col` lies over `.bm-stage`. It ends with status 1 when the bar is not met:
 * at distances 210 and 150 at least six titles fully inside the stage, the excerpt fully inside it, no two titles
 * overlapping, and no pooled plate drawn after zooming out.
 */
import fs from 'node:fs'
import path from 'node:path'
import { findBrowser, openPage, settled, startBrowser, startDemo } from './shots.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const args = process.argv.slice(2)
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : '' }
const SIZES = [[1440, 900], [375, 812]]
const DISTANCES = [210, 150]
const MIN_TITLES = 6
// Round the brain: several headings and heights, aimed at the middle and at each lobe.
const ANGLES = [[0, 0.25], [1.1, 0.1], [2.3, 0.35], [3.4, -0.15], [4.6, 0.2], [5.6, 0.05]]
const SHOT_FILES = { '1440-day': 'engram-zoom.png', '1440-night': 'engram-zoom-night.png', '375-day': 'engram-zoom-375.png', '375-night': 'engram-zoom-night-375.png' }

const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))))'

/** Close whatever sheet of the deck is open: its close buttons, then Escape. */
const CLOSE_DECK = `(() => {
  let n = 0
  for (const b of document.querySelectorAll('.deck-col [data-act="close-col"], .studio-sheet [data-act="close"]')) {
    const r = b.getBoundingClientRect(); if (r.width && r.height) { b.click(); n += 1 }
  }
  return n
})()`

/** The deck columns that are open and lie over the stage. */
const DECK_OVER = `(() => {
  const st = document.querySelector('.bm-stage'); if (!st) return ['no stage']
  const S = st.getBoundingClientRect()
  return [...document.querySelectorAll('.deck-col')].filter((e) => {
    if (e.hidden || getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.left < S.right && r.right > S.left && r.top < S.bottom && r.bottom > S.top
  }).map((e) => e.dataset.col || e.className)
})()`

const aim = (target, angle, dist) => `(() => {
  const f = document.querySelector('.bm-stage').brainField
  const t = ${JSON.stringify(target)}
  f.controls.target.set(t.x, t.y, t.z)
  const [a, e] = ${JSON.stringify(angle)}
  const d = new f.camera.position.constructor(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e))
  f.camera.position.copy(f.controls.target).addScaledVector(d, ${dist})
  f.controls.update(); f.request(); return true
})()`

const MEASURE = `(() => {
  const st = document.querySelector('.bm-stage')
  const f = st.brainField
  const S = st.getBoundingClientRect()
  const inside = (r) => r.left >= S.left - 0.5 && r.right <= S.right + 0.5 && r.top >= S.top - 0.5 && r.bottom <= S.bottom + 0.5
  const drawn = [...st.querySelectorAll('.bf-node-label')].filter((e) => getComputedStyle(e).display !== 'none')
  const rects = drawn.map((e) => e.getBoundingClientRect())
  let overlaps = 0
  for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
    const a = rects[i]; const b = rects[j]
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) { overlaps += 1; window.__overlap = [drawn[i], drawn[j]].map((e) => [e.dataset.note, e.style.transform, e.style.width, e.className, JSON.stringify(e.getBoundingClientRect())]) }
  }
  const x = st.querySelector('.bf-excerpt')
  const xr = x.getBoundingClientRect()
  const shown = getComputedStyle(x).display !== 'none'
  const rel = (r) => ({ l: Math.round(r.left - S.left), t: Math.round(r.top - S.top), r: Math.round(S.right - r.right), b: Math.round(S.bottom - r.bottom) })
  return {
    dist: Math.round(f.camera.position.distanceTo(f.controls.target)),
    drawn: drawn.length, edge: drawn.filter((e) => e.classList.contains('edge')).length, inside: rects.filter((r) => r.width > 0 && inside(r)).length, overlaps,
    excerpt: shown ? { inside: inside(xr), gap: rel(xr) } : null,
    hiddenDisplay: [...new Set([...st.querySelectorAll('.bf-node-label[hidden]')].map((e) => getComputedStyle(e).display))],
    stage: [Math.round(S.width), Math.round(S.height)],
  }
})()`

async function run() {
  const file = findBrowser()
  if (!file) throw new Error('No browser was found')
  const given = option('--url')
  const demo = given ? null : await startDemo(console.log)
  const base = given || demo.url
  const shotsDir = option('--shots')
  const browser = await startBrowser(file)
  const fails = []
  const rows = []
  try {
    for (const plates of ['day', 'night']) {
      for (const size of SIZES) {
        const tag = `${size[0]}-${plates}`
        const page = await openPage(browser, { plates, size, phone: size[0] < 600 })
        try {
          await page.cdp('Page.navigate', { url: base })
          await settled(page, { until: (look) => look.ready && look.canvas, why: 'The map' })
          await sleep(2500)
          // The first-run welcome opens on its own once the page has asked for it: let it, then close it.
          for (let n = 0; n < 6; n += 1) { await page.evaluate(CLOSE_DECK); await sleep(400) }
          // Night is the page's own switch, as a person would use it: the yard and the plates are one setting.
          if (await page.evaluate(`document.querySelector('.hud.studio')?.dataset.plates`) !== plates) { await page.evaluate(`document.querySelector('[data-act="shift"]').click()`); await sleep(1500) }
          const platesNow = await page.evaluate(`document.querySelector('.hud.studio')?.dataset.plates`)
          if (platesNow !== plates) { fails.push(`${tag}: the page shows ${platesNow} plates`); continue }
          await page.evaluate(`document.querySelector('[data-home="brain"]').click()`)
          await sleep(800)
          await page.evaluate(`document.querySelector('[data-mode="field"]')?.click()`)
          for (let n = 0; n < 60 && !(await page.evaluate(`Boolean(document.querySelector('.bm-stage')?.brainField?.brain)`)); n += 1) await sleep(250)
          await settled(page, { why: 'Engram' })
          for (let n = 0; n < 3; n += 1) { await page.evaluate(CLOSE_DECK); await sleep(300) }
          const over = await page.evaluate(DECK_OVER)
          if (over.length) { fails.push(`${tag}: the deck lies over the stage (${over.join(', ')})`); continue }
          const vp = await page.evaluate('[innerWidth, innerHeight]')
          if (vp[0] !== size[0] || vp[1] !== size[1]) fails.push(`${tag}: viewport is ${vp.join('x')}`)
          const centres = await page.evaluate(`[...document.querySelector('.bm-stage').brainField.centres.values()].map((c) => ({ x: c.x, y: c.y, z: c.z }))`)
          const targets = [{ x: 0, y: 0, z: 0 }, ...centres]
          for (const dist of DISTANCES) {
            let least = Infinity
            let worstExcerpt = null
            let overlaps = 0
            let views = 0
            let edges = 0
            for (const target of targets) for (const angle of ANGLES) {
              await page.evaluate(aim(target, angle, dist))
              await page.evaluate(frames)
              const m = await page.evaluate(MEASURE)
              views += 1
              edges = Math.max(edges, m.edge)
              least = Math.min(least, m.inside)
              overlaps += m.overlaps
              if (m.inside !== m.drawn) fails.push(`${tag} d${dist}: ${m.drawn - m.inside} titles drawn outside the stage`)
              if (!m.excerpt) fails.push(`${tag} d${dist}: no excerpt shown`)
              else if (!m.excerpt.inside) { worstExcerpt = m.excerpt.gap; fails.push(`${tag} d${dist}: excerpt leaves the stage ${JSON.stringify(m.excerpt.gap)}`) }
              if (m.inside < MIN_TITLES) fails.push(`${tag} d${dist} target ${JSON.stringify(target)} angle ${angle}: only ${m.inside} titles on the stage`)
            }
            rows.push(`${tag.padEnd(11)} d${dist}: ${views} views, fewest titles on stage ${least} (at most ${edges} of them pinned to the edge), overlapping pairs ${overlaps}, excerpt ${worstExcerpt ? 'OUT' : 'inside every time'}`)
            if (overlaps) fails.push(`${tag} d${dist}: ${overlaps} overlapping title pairs, e.g. ${JSON.stringify(await page.evaluate('window.__overlap'))}`)
          }
          // Back out: every pooled plate must be gone, not just marked hidden.
          await page.evaluate(aim({ x: 0, y: 0, z: 0 }, [0.4, 0.2], 700))
          await page.evaluate(frames)
          const out = await page.evaluate(MEASURE)
          rows.push(`${tag.padEnd(11)} d${out.dist}: titles drawn ${out.drawn}, hidden plates compute display ${out.hiddenDisplay.join('/')}, excerpt ${out.excerpt ? 'SHOWN' : 'gone'}`)
          if (out.drawn || out.excerpt || out.hiddenDisplay.some((d) => d !== 'none')) fails.push(`${tag}: plates still drawn after zooming out`)
          if (shotsDir) {
            const shotTag = `${size[0]}-${plates}`
            // The picture: of the views round the brain at 170, the one with the most neurons really in frame.
            let best = null
            for (const target of targets) for (const angle of ANGLES) {
              await page.evaluate(aim(target, angle, 170))
              await page.evaluate(frames)
              const m = await page.evaluate(MEASURE)
              const score = m.inside - m.edge
              if (m.excerpt?.inside && (!best || score > best.score)) best = { target, angle, score }
            }
            await page.evaluate(aim(best.target, best.angle, 170))
            await page.evaluate(frames)
            await sleep(400)
            const over2 = await page.evaluate(DECK_OVER)
            const m = await page.evaluate(MEASURE)
            if (over2.length || m.inside < MIN_TITLES || !m.excerpt?.inside) { fails.push(`${shotTag}: not captured (deck ${over2.join(',') || 'closed'}, ${m.inside} titles, excerpt ${m.excerpt?.inside})`); continue }
            const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
            const to = path.join(shotsDir, SHOT_FILES[shotTag])
            fs.writeFileSync(to, Buffer.from(data, 'base64'))
            rows.push(`${tag.padEnd(11)} shot ${to}: d${m.dist}, ${m.inside} titles on stage, excerpt inside, deck closed, viewport ${vp.join('x')}`)
          }
        } finally { await page.close().catch(() => {}) }
      }
    }
  } finally {
    await browser.close().catch(() => {})
    await demo?.stop()
  }
  for (const row of rows) console.log(row)
  const unique = [...new Set(fails)]
  console.log(unique.length ? `\nNOT MET (${unique.length}):\n${unique.slice(0, 40).join('\n')}` : '\nMET: every view keeps six or more titles and the excerpt on the stage; zoomed out, no plate is drawn.')
  process.exit(unique.length ? 1 : 0)
}

run().catch((err) => { console.error(err.message); process.exit(1) })
