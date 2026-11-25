#!/usr/bin/env node
/**
 * Botyard's store scan from a terminal (docs/store-rules.md): one app, or every product in the launch plan at once.
 *
 *   node studio/tools/store-scan.mjs <app folder> [--stores play,appstore] [--regions SE,DE,US] [--features accounts,ai] [--json]
 *   node studio/tools/store-scan.mjs --plan [--json]      every product in the launch plan, with one verdict for all
 *
 * Exit 0 when nothing blocks, 2 when something does, 1 when it could not scan. Reads only; changes nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../server/lib/home.mjs'
import { scan, scanText, waiversIn } from '../server/lib/store-scan/index.mjs'
import { keptFor } from '../server/lib/store-scan/kept.mjs'
import { readPlan } from '../server/lib/launch.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? String(args[i + 1] || '') : '' }
const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean)
const asJson = args.includes('--json')

function one(name, folder, stores, regions, features, appId) {
  const r = scan(folder, { stores, regions: regions.length ? regions : ['US', 'GB', 'DE', 'SE'], features, waivers: waiversIn(folder), kept: keptFor(appId || name) })
  return { name, folder, ...r }
}

let results = []
if (args.includes('--plan')) {
  const plan = readPlan()
  if (!plan.products.length) { console.error('The launch plan has no products.'); process.exit(1) }
  for (const p of plan.products) {
    // The product's folder: the plan's own, else the project's folder beside Botyard (as the crew's projects sit).
    const beside = path.join(process.env.BOTYARD_PROJECTS || path.dirname(repoRoot()), String(p.project || p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    const folder = p.folder || p.path || (fs.existsSync(beside) ? beside : '')
    if (!folder) { results.push({ name: p.name, verdict: 'fail', why: 'No folder in the launch plan', blocking: [], notes: [], waived: [], refused: [], state: [], console: [], coming: [] }); continue }
    const stores = [p.channels?.play?.package && 'play', p.channels?.appstore?.bundle && 'appstore'].filter(Boolean)
    results.push(one(p.name, path.resolve(folder.replace(/^~/, process.env.HOME || '')), stores, p.regions || [], p.features || [], p.channels?.play?.package || p.channels?.appstore?.bundle))
  }
} else {
  const folder = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  if (!folder) { console.error('Name an app folder, or use --plan.'); process.exit(1) }
  const stores = list(opt('stores') || 'play,appstore')
  results = [one(path.basename(path.resolve(folder)), path.resolve(folder), stores, list(opt('regions')).map((r) => r.toUpperCase()), list(opt('features')))]
}

if (asJson) console.log(JSON.stringify(results.length === 1 ? results[0] : { verdict: results.every((r) => r.verdict === 'pass') ? 'pass' : 'fail', apps: results }, null, 1))
else {
  for (const r of results) console.log(`== ${r.name} ${r.verdict === 'pass' ? 'READY' : 'BLOCKED'}\n${scanText(r)}\n`)
  if (results.length > 1) console.log(`All ${results.length}: ${results.filter((r) => r.verdict === 'pass').length} ready, ${results.filter((r) => r.verdict !== 'pass').length} blocked.`)
}
process.exit(results.every((r) => r.verdict === 'pass') ? 0 : 2)
