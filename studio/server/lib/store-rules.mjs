/**
 * Store rules before a release (docs/launch.md, "Store rules"): the App Store Compliance Playbook's guard scans the
 * built app for what Apple and Google reject, the same way on every release. The playbook is not copied into Botyard:
 * its licence (OpenRoots Agent License 2.3) is not Botyard's, so each yard fetches it once, at one pinned commit, into
 * its own home, and runs it there. A new pin is a Botyard change, reviewed like any other.
 *
 * What blocks: a critical or high finding that no waiver covers, and a scan that did not see the app. The crew may waive
 * a high finding it has proven false, with evidence and an expiry; never a critical one. What the law asks the owner to
 * state (the playbook's Ruling Register) and the console steps only the owner can do go on the owner's one release card.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { home } from './home.mjs'

export const RULES_PIN = {
  name: 'App Store Compliance Playbook',
  repo: 'https://github.com/mjmirza/app-store-compliance.git',
  tag: 'v2.5.1',
  commit: '54c2e33254448a545fa2bcb25b3adfef984cf9dc',
  licence: 'OpenRoots Agent License 2.3 (free under USD 20 million a year in revenue)',
}
/** Where a yard keeps its copy of the playbook. */
export const rulesFolder = (env = process.env) => path.join(home(env), 'tools', 'app-store-compliance')
/** The countries a release is checked for when its plan names none. */
export const DEFAULT_REGIONS = ['US', 'GB', 'DE', 'SE']
const BLOCKS = ['critical', 'high']
/** Folders that are never part of the app a store sees. */
const SKIP = new Set(['node_modules', '.git', '.botyard', '.gradle', '.cxx', 'build', 'Pods', 'DerivedData', '.expo', 'dist', 'web-build', 'tmp'])

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts })

/** The playbook at its pinned commit in `folder`, fetched when missing or at another commit. Returns '' or why not. */
export function ensureRules(folder = rulesFolder(), { exec = run } = {}) {
  const at = () => String(exec('git', ['-C', folder, 'rev-parse', 'HEAD']).stdout || '').trim()
  if (fs.existsSync(path.join(folder, '.git')) && at() === RULES_PIN.commit) return ''
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(folder), { recursive: true })
  const cloned = exec('git', ['clone', '--quiet', '--no-checkout', RULES_PIN.repo, folder])
  if (cloned.status !== 0) return `The ${RULES_PIN.name} could not be fetched: ${String(cloned.stderr || '').trim().slice(0, 300)}`
  const out = exec('git', ['-C', folder, 'checkout', '--quiet', '--detach', RULES_PIN.commit])
  if (out.status !== 0 || at() !== RULES_PIN.commit) return `The ${RULES_PIN.name} is not at its pinned commit ${RULES_PIN.commit.slice(0, 12)}`
  return ''
}

/** The app as a store sees it, copied without dependencies, build output, other worktrees or secrets' folders. */
export function scanCopy(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (f) => {
      const name = path.basename(f)
      return !SKIP.has(name) && !/\.(aab|apk|ipa)$/i.test(name)
    },
  })
  return dest
}

/** The console steps only the owner can do, per store: listed as open, so the card says them and the yes confirms them. */
export const CONSOLE_STEPS = {
  play: ['play_data_safety_matches_runtime', 'play_content_rating_current', 'play_target_audience_and_ads_declared'],
  appstore: ['apple_privacy_answers_match_runtime', 'apple_age_rating_current', 'apple_agreements_signed'],
}
const consoleSteps = (stores) => Object.fromEntries(stores.flatMap((s) => CONSOLE_STEPS[s] || []).map((k) => [k, false]))

/** The fleet file the playbook's sweep reads, for one app. */
export function fleetFor({ name, folder, stores, regions, features, attestations = {} }) {
  const platforms = [stores.includes('play') && 'android', stores.includes('appstore') && 'ios'].filter(Boolean)
  return {
    fleet_name: `Botyard release of ${name}`,
    apps: [{ name, path: folder, platforms, regions: regions?.length ? regions : DEFAULT_REGIONS, features: features || [], attestations, readiness: consoleSteps(stores) }],
  }
}

/** A waiver the crew wrote, kept only when it may stand: never on a critical finding, and with its evidence. */
export function usableWaivers(list, app) {
  const all = Array.isArray(list?.waivers) ? list.waivers : Array.isArray(list) ? list : []
  const kept = []
  const refused = []
  for (const w of all) {
    if (!w || typeof w !== 'object') continue
    if (String(w.severity).toLowerCase() === 'critical') { refused.push(`${w.finding_id}: a critical finding is fixed, never waived`); continue }
    if (!w.reason || !w.evidence || !w.reviewed_by || !w.expires) { refused.push(`${w.finding_id}: a waiver needs a reason, evidence, a reviewer and an expiry`); continue }
    kept.push({ ...w, app })
  }
  return { waivers: kept, refused }
}

/** The register's rules the owner is asked to state, from the sweep's blockers, in plain words with what each asks. */
export function asks(blockers, register) {
  const rows = new Map((register?.requirements || []).map((r) => [r.id, r]))
  return blockers.map((line) => {
    const id = String(line).split(' ')[0]
    const row = rows.get(id)
    return row ? { id, title: row.title, revision: row.revision, jurisdiction: row.jurisdiction, items: row.proof_items || [], check: row.check || '' } : { id, title: line, items: [] }
  }).filter((a) => /^RR-/.test(a.id))
}

/** The owner's yes as attestations the sweep accepts: one per rule, covering its items and the release's regions. */
export function attestationsFrom(list, { by, on, regions, ref }) {
  return Object.fromEntries(list.filter((a) => a.revision != null).map((a) => [a.id, {
    attested_by: by, attested_on: on, outcome: 'compliant', revision: a.revision, covers: a.items.map((i) => i.id), regions,
    evidence: `The owner's yes on the release card ${ref}, which listed: ${a.items.map((i) => i.what).join('; ') || a.title}`,
  }]))
}

/**
 * The sweep's answer as Botyard reads it: pass or fail, the findings that block, the ones waived, what the owner states on
 * the card (register), the console steps only the owner can do, and the rest as notes.
 */
export function judge(result, register) {
  const app = result?.apps?.[0]
  if (!app) return { verdict: 'fail', why: 'The store-rules scan gave no answer for the app', blocking: [], waived: [], notes: [], owner: [], attest: [] }
  const blocking = (app.findings || []).filter((f) => BLOCKS.includes(String(f.severity).toLowerCase()))
  const notes = (app.findings || []).filter((f) => !BLOCKS.includes(String(f.severity).toLowerCase()))
  const seen = app.coverage?.state === 'complete' && app.guard_exit !== 1
  const why = !seen ? `The scan did not see the whole app${app.coverage?.reason ? `: ${app.coverage.reason}` : app.note ? `: ${app.note}` : ''}` : ''
  return {
    verdict: !seen || blocking.length ? 'fail' : 'pass',
    why,
    blocking,
    waived: app.waived || [],
    waiverProblems: app.waiver_problems || [],
    notes,
    owner: app.owner_actions || [],
    attest: asks(app.register_blockers || [], register),
  }
}

const line = (f) => `[${String(f.severity).toUpperCase()}] ${f.id}: ${f.title}${f.file ? ` (${f.file})` : ''}${f.fix ? `\n    Fix: ${f.fix}` : ''}`
const ACTION_WORDS = {
  play_data_safety_matches_runtime: 'Play Data safety answers match what the app collects',
  play_content_rating_current: 'Play content rating questionnaire is current',
  play_target_audience_and_ads_declared: 'Play target audience and ads declaration are current',
  apple_privacy_answers_match_runtime: 'App Store privacy answers match what the app collects',
  apple_age_rating_current: 'App Store age rating answers are current',
  apple_agreements_signed: 'App Store agreements, tax and banking are signed',
  tested_on_a_physical_device: 'Tried on a real phone',
}

/** What the card and the trip page say about the store rules: short, plain, every item the owner must know. */
export function rulesText(j) {
  const out = [`Store rules (${RULES_PIN.name} ${RULES_PIN.tag}): ${j.verdict === 'pass' ? 'nothing blocks' : 'blocked'}.`]
  if (j.why) out.push(j.why)
  if (j.blocking.length) out.push(`Must be fixed:\n${j.blocking.map(line).join('\n')}`)
  if (j.waived.length) out.push(`Waived by the crew, with evidence:\n${j.waived.map((w) => `${w.finding_id || w.id} (${w.reason || 'reviewed'}, until ${w.expires || '?'})`).join('\n')}`)
  if (j.waiverProblems.length) out.push(`Waivers not accepted:\n${j.waiverProblems.join('\n')}`)
  if (j.attest.length) out.push(`Your yes also states that each of these is true:\n${j.attest.map((a) => `- ${a.title}${a.items.length ? `: ${a.items.map((i) => i.what).join('; ')}` : ''}`).join('\n')}`)
  const steps = j.owner.filter((o) => !/not tracked/.test(o))
  if (steps.length) out.push(`Your yes also confirms these are done in the store consoles (only you can fill them; the crew drafts the answers):\n${steps.map((o) => `- ${ACTION_WORDS[o] || o.replace(/_/g, ' ')}`).join('\n')}`)
  if (j.notes.length) out.push(`To look at, not blocking: ${j.notes.map((f) => `${f.id}${f.file ? ` (${f.file})` : ''}`).join(', ')}`)
  return out.join('\n\n')
}

/** Runs the sweep on one app. Returns { result, register } or { error }. */
export function sweep({ rules = rulesFolder(), app, waivers = [], exec = run }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-store-rules-'))
  try {
    const fleet = path.join(work, 'fleet.json')
    const out = path.join(work, 'out.json')
    fs.writeFileSync(fleet, JSON.stringify(app))
    const args = [path.join(rules, 'scripts', 'fleet-sweep.py'), fleet, '--json', out]
    if (waivers.length) {
      fs.writeFileSync(path.join(work, 'waivers.json'), JSON.stringify({ waivers }))
      args.push('--waivers', path.join(work, 'waivers.json'))
    }
    const ran = exec('python3', args, { cwd: rules })
    if (!fs.existsSync(out)) return { error: `The store-rules scan did not finish: ${String(ran.stdout || ran.stderr || ran.error || '').trim().slice(-400)}` }
    let register = null
    try { register = JSON.parse(fs.readFileSync(path.join(rules, 'data', 'ruling-register.json'), 'utf8')) } catch { /* the card says the ids */ }
    return { result: JSON.parse(fs.readFileSync(out, 'utf8')), register }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
