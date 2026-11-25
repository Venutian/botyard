/**
 * Botyard's store scan (docs/store-rules.md): reads an app, runs the store rules for the stores it ships to, applies
 * the crew's waivers, and says what the owner states and does, in one result the release step, the scan-all tool and
 * the release card share. Its own rules and words; it calls nothing outside this folder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readApp } from './app.mjs'
import { rulesFor } from './rules.mjs'
import { ownerPart } from './owner.mjs'

/** The longest a waiver may stand before it is looked at again. */
export const WAIVER_DAYS = 180
const BLOCKS = ['stop', 'fix']

/**
 * The crew's waivers for an app (its `store/waivers.json`): `[{ rule, file, why, proof, by, until }]`. A waiver covers
 * one rule at one file. Returns the ones that may stand and why each other one may not.
 */
export function readWaivers(list, today) {
  const all = Array.isArray(list) ? list : Array.isArray(list?.waivers) ? list.waivers : []
  const kept = []
  const refused = []
  const latest = new Date(Date.parse(today) + WAIVER_DAYS * 86400_000).toISOString().slice(0, 10)
  for (const w of all) {
    if (!w || typeof w !== 'object' || !w.rule) continue
    const missing = ['why', 'proof', 'by', 'until'].filter((k) => !String(w[k] || '').trim())
    if (missing.length) refused.push(`${w.rule}: a waiver needs ${missing.join(', ')}`)
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(w.until) || w.until < today) refused.push(`${w.rule}: its date ${w.until} has passed`)
    else if (w.until > latest) refused.push(`${w.rule}: it stands until ${w.until}, more than ${WAIVER_DAYS} days away`)
    else kept.push(w)
  }
  return { kept, refused }
}

/**
 * Scans the app in `folder` for a release to `stores` ('play', 'appstore'). `features` are what the app does that the
 * rules and laws name (accounts, personal_data, kids, ugc, ai, commerce, subscriptions); `kept` the owner's statements
 * already made for this app.
 */
export function scan(folder, { stores = [], regions = [], features = [], today = new Date().toISOString().slice(0, 10), waivers = [], kept = {} } = {}) {
  const app = { ...readApp(folder), features }
  const seen = (stores.includes('play') ? app.platforms.android : true) && (stores.includes('appstore') ? app.platforms.ios : true) && app.files.length > 0
  const why = !app.files.length ? 'The folder holds no app' : !seen ? `The folder has no ${stores.includes('play') && !app.platforms.android ? 'Android' : 'iOS'} app to scan (an Expo app is scanned after its native folders are made)` : ''
  const { kept: good, refused } = readWaivers(waivers, today)
  const findings = []
  const waived = []
  for (const rule of rulesFor(stores)) {
    let hit
    try { hit = rule.test(app, { today, stores }) } catch (err) { hit = { file: '', line: 0, detail: `the rule could not read the app: ${err.message}` } }
    if (!hit) continue
    const f = { rule: rule.id, level: rule.level, area: rule.area, title: rule.title, fix: rule.fix, source: rule.source, file: hit.file || '', line: hit.line || 0, detail: hit.detail || hit.text || '' }
    const w = rule.level !== 'stop' && good.find((x) => x.rule === rule.id && (!x.file || x.file === f.file))
    if (w) waived.push({ ...f, why: w.why, proof: w.proof, by: w.by, until: w.until })
    else findings.push(f)
  }
  const stopWaivers = good.filter((w) => findings.some((f) => f.rule === w.rule && f.level === 'stop'))
  for (const w of stopWaivers) refused.push(`${w.rule}: a stop is fixed, never waived`)
  const blocking = findings.filter((f) => BLOCKS.includes(f.level))
  const owner = ownerPart({ regions, features, stores, today, kept })
  return {
    verdict: !seen || blocking.length ? 'fail' : 'pass', why, appDir: app.appDir,
    platforms: app.platforms, blocking, notes: findings.filter((f) => f.level === 'look'), waived, refused,
    state: owner.state, standing: owner.standing, console: owner.console, coming: owner.coming,
  }
}

/** The waivers written in an app's folder, or none. */
export function waiversIn(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, 'store', 'waivers.json'), 'utf8')) } catch { return [] }
}

const where = (f) => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '')
const LEVEL = { stop: 'STOP', fix: 'FIX', look: 'LOOK' }

/** The result as the release card and the trip page say it: short, plain, every item the owner must know. */
export function scanText(r) {
  const out = [`Store rules: ${r.verdict === 'pass' ? 'nothing blocks' : 'blocked'}.${r.appDir ? ` App folder: ${r.appDir}.` : ''}`]
  if (r.why) out.push(r.why)
  if (r.blocking.length) out.push(`Must be fixed:\n${r.blocking.map((f) => `[${LEVEL[f.level]}] ${f.title}${where(f)}${f.detail ? `: ${f.detail}` : ''}\n    Fix: ${f.fix}`).join('\n')}`)
  if (r.waived.length) out.push(`Waived by the crew, with proof:\n${r.waived.map((w) => `- ${w.title}${where(w)}: ${w.why} (proof: ${w.proof}; ${w.by}, until ${w.until})`).join('\n')}`)
  if (r.refused.length) out.push(`Waivers not accepted:\n${r.refused.map((x) => `- ${x}`).join('\n')}`)
  if (r.state.length) out.push(`Your yes also states that each of these is true:\n${r.state.map((s) => `- ${s.title}: ${s.says}`).join('\n')}`)
  if (r.console.length) out.push(`Your yes also confirms these are done in the store consoles (only you can fill them; the crew drafts the answers):\n${r.console.map((c) => `- ${c.says}`).join('\n')}`)
  if (r.notes.length) out.push(`To look at, not blocking:\n${r.notes.map((f) => `- ${f.title}${where(f)}`).join('\n')}`)
  if (r.coming.length) out.push(`Coming up:\n${r.coming.map((c) => `- ${c.on}: ${c.says}`).join('\n')}`)
  return out.join('\n\n')
}
