/**
 * The Launch page (docs/launch.md): every product on every channel it is released on, each cell read from the
 * channel itself, with the next step and who it waits on. The checks only read. A cell is "read" (from the store's
 * API or the live thing), "told" (typed by a person, with its age) or "not known" (no key, no id, or no API), and
 * is never shown as live when it was not read.
 *
 * The plan (which products, which channels, their ids) is `launch-plan.json` in Botyard's data folder; what the
 * checks found, and the history of every change, is `launch-state.json` beside it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { BUILTINS } from './store-apis.mjs'
import { readStore } from './connectors.mjs'
import { places } from './home.mjs'
import { EngineError, call, companyId } from './engine.mjs'

const AGE_MS = 10 * 60_000
const TOLD_OLD_MS = 7 * 24 * 60 * 60_000
const HISTORY = 400
const TIME_LIMIT_MS = 20_000

export const CHANNELS = [
  { id: 'play', name: 'Google Play', key: 'google-play' },
  { id: 'appstore', name: 'App Store', key: 'app-store-connect' },
  { id: 'web', name: 'Web' },
  { id: 'github', name: 'GitHub release' },
  { id: 'itch', name: 'itch.io' },
  { id: 'steam', name: 'Steam' },
  { id: 'crazygames', name: 'CrazyGames' },
  { id: 'poki', name: 'Poki' },
]
const CHANNEL = new Map(CHANNELS.map((c) => [c.id, c]))

const dataDir = () => places().data
export const planFile = () => process.env.BOTYARD_LAUNCH_PLAN || path.join(dataDir(), 'launch-plan.json')
export const stateFile = () => process.env.BOTYARD_LAUNCH_STATE || path.join(dataDir(), 'launch-state.json')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 1))
  fs.renameSync(temp, file)
}

export const readPlan = (file = planFile()) => {
  const plan = readJson(file, null)
  // `release.inputs` names the studio's own bots for the release track (builder, writer, artist, reviewer).
  const release = plan?.release && typeof plan.release === 'object' ? { track: String(plan.release.track || 'release-app'), inputs: plan.release.inputs && typeof plan.release.inputs === 'object' ? plan.release.inputs : {} } : { track: 'release-app', inputs: {} }
  return { products: Array.isArray(plan?.products) ? plan.products.filter((p) => p?.name) : [], found: Boolean(plan), release }
}
export const readState = (file = stateFile()) => {
  const s = readJson(file, null)
  return { cells: s?.cells || {}, told: s?.told || {}, releases: s?.releases || {}, history: Array.isArray(s?.history) ? s.history : [], checkedAt: s?.checkedAt || 0 }
}

const keyOf = (product, channel) => `${product}|${channel}`
const cell = (state, more = {}) => ({ state, tone: 'wait', version: '', detail: '', how: 'read', waits: '', next: '', ...more })

// ── how each channel is read ─────────────────────────────────────────────────────────────

async function getJson(fetcher, url, init = {}) {
  const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  if (!res.ok) throw new Error(`answered ${res.status}`)
  return res.json()
}

const PLAY_TRACKS = ['production', 'beta', 'alpha', 'internal']
const PLAY_NAMES = { production: 'Production', beta: 'Open testing', alpha: 'Closed testing', internal: 'Internal testing' }

/** Google Play's tracks as one state: what is live, rolling out, halted or waiting as a draft. */
export function playState(tracks = []) {
  const byName = new Map(tracks.map((t) => [t.track, t.releases || []]))
  const prod = byName.get('production') || []
  // A release's name often holds its version code already ("44 (1.0.0)"); the code is said once.
  const named = (r) => {
    const name = String(r.name || '')
    const codes = (r.versionCodes || []).filter((c) => !new RegExp(`(^|\\D)${c}(\\D|$)`).test(name))
    return `${name}${codes.length ? ` (${codes.join(', ')})` : ''}`.trim()
  }
  const draft = prod.find((r) => r.status === 'draft')
  if (draft) return cell(`Production draft ${named(draft)}`, { tone: 'look', version: draft.name || '', waits: 'owner', next: 'Your yes to release it' })
  const halted = prod.find((r) => r.status === 'halted')
  if (halted) return cell(`Halted ${named(halted)}`, { tone: 'bad', version: halted.name || '', waits: 'owner', next: 'Decide: resume the rollout, or ship a fix' })
  const rolling = prod.find((r) => r.status === 'inProgress')
  if (rolling) return cell(`Rolling out ${named(rolling)} to ${Math.round((Number(rolling.userFraction) || 0) * 100)}%`, { tone: 'go', version: rolling.name || '', waits: 'store', next: 'A release made on the Launch page is raised by itself while crashes stay under Google\'s line', detail: 'Google does not say whether a release is in review; a release it has not shown yet is probably in review.' })
  const live = prod.find((r) => r.status === 'completed')
  if (live) return cell(`Live ${named(live)}`, { tone: 'ok', version: live.name || '' })
  for (const track of PLAY_TRACKS.slice(1)) {
    const r = (byName.get(track) || []).find((x) => x.status !== 'halted')
    if (r) return cell(`${PLAY_NAMES[track]} ${named(r)}`, { tone: 'go', version: r.name || '', waits: 'crew', next: 'Test it on the test phone, then ask for your yes to go to production' })
  }
  return cell('Nothing uploaded yet', { waits: 'crew', next: 'Upload a build to internal testing' })
}

const APPLE = {
  READY_FOR_SALE: ['Live', 'ok', '', ''], READY_FOR_DISTRIBUTION: ['Live', 'ok', '', ''],
  WAITING_FOR_REVIEW: ['Waiting for review', 'go', 'store', 'Apple reviews it'], IN_REVIEW: ['In review', 'go', 'store', 'Apple reviews it'],
  PENDING_DEVELOPER_RELEASE: ['Approved, waits for your release', 'look', 'owner', 'Your yes to release it'],
  REJECTED: ['Rejected', 'bad', 'crew', 'Fix what Apple said and send it again'], METADATA_REJECTED: ['Listing rejected', 'bad', 'crew', 'Fix the listing and send it again'],
  DEVELOPER_REJECTED: ['Pulled back from review', 'wait', 'crew', 'Send it again when ready'],
  PREPARE_FOR_SUBMISSION: ['Being prepared', 'wait', 'crew', 'Finish the version and ask for your yes to send it for review'],
}

/** The App Store's newest version as one state, with the newest build's processing beside it. */
export function appleState(versions = [], builds = []) {
  const v = versions[0]
  const b = builds[0]
  const built = b ? ` Newest build ${b.version || ''}: ${String(b.processingState || '').toLowerCase() || 'state not given'}.` : ''
  if (!v) return cell(b ? `Build ${b.version || ''} uploaded` : 'No version yet', { waits: 'crew', next: b ? 'Make the version and attach the build' : 'Upload a build to TestFlight', detail: built.trim() })
  const s = v.appStoreState || v.appVersionState || ''
  const [words, tone, waits, next] = APPLE[s] || [s.toLowerCase().replaceAll('_', ' ') || 'State not given', 'wait', '', '']
  return cell(`${words} ${v.versionString || ''}`.trim(), { tone, version: v.versionString || '', waits, next, detail: built.trim() })
}

async function readStoreKey(id) {
  const c = readStore().connectors
  return Object.values(c).find((x) => x.auth === 'builtin' && x.builtin === id && x.secret) || null
}

async function checkPlay(ids, { fetcher, key }) {
  if (!ids.package) return cell('Not set up', { how: 'none', waits: 'owner', next: 'Name its package in the launch plan' })
  if (!key) return cell('Not known: no Google Play key', { how: 'none', waits: 'owner', next: 'Add the Google Play key on its row in Connectors' })
  const tool = BUILTINS['google-play'].tools.find((t) => t.name === 'play_tracks')
  return playState(await tool.run(key.secret, fetcher, { packageName: ids.package }))
}

async function checkApple(ids, { fetcher, key }) {
  if (!ids.bundle) return cell('Not set up', { how: 'none', waits: 'owner', next: 'Name its bundle id in the launch plan' })
  if (!key) return cell('Not known: no App Store key', { how: 'none', waits: 'owner', next: 'Add the App Store Connect key on its row in Connectors' })
  const tools = Object.fromEntries(BUILTINS['app-store-connect'].tools.map((t) => [t.name, t]))
  const app = (await tools.asc_apps.run(key.secret, fetcher, {})).find((a) => a.bundleId === ids.bundle)
  if (!app) return cell('No app record', { tone: 'bad', waits: 'owner', next: 'Create the app record in App Store Connect (the store has no way to do it for us)' })
  const [versions, builds] = await Promise.all([tools.asc_versions.run(key.secret, fetcher, { appId: app.id }), tools.asc_builds.run(key.secret, fetcher, { appId: app.id })])
  return appleState(versions, builds)
}

async function checkWeb(ids, { fetcher }) {
  if (!ids.url) return cell('Not set up', { how: 'none', waits: 'owner', next: 'Name its address in the launch plan' })
  let res
  try { res = await fetcher(ids.url, { redirect: 'follow', signal: AbortSignal.timeout(TIME_LIMIT_MS) }) } catch { return cell('Down: it does not answer', { tone: 'bad', waits: 'crew', next: 'Find out why the address does not answer' }) }
  if (!res.ok) return cell(`Down: it answers ${res.status}`, { tone: 'bad', waits: 'crew', next: 'Find out why the address fails' })
  let version = ''
  try { version = String((await getJson(fetcher, new URL('/version.json', ids.url).href)).version || '') } catch { version = '' }
  return cell(`Live${version ? ` ${version}` : ''}`, { tone: 'ok', version, detail: version ? '' : 'The site has no /version.json, so which version is live is not known.' })
}

const gh = (args) => new Promise((resolve, reject) => execFile('gh', args, { timeout: TIME_LIMIT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))))

/** A repository's releases: GitHub's own command line when it is signed in, else the public API. */
async function releasesOf(repo, fetcher, useGh = true) {
  try { if (!useGh) throw new Error('not asked'); return JSON.parse(await gh(['api', `repos/${repo}/releases?per_page=20`])) } catch { return getJson(fetcher, `https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json' } }) }
}

export function githubState(releases = []) {
  const draft = releases.find((r) => r.draft)
  const live = releases.find((r) => !r.draft)
  if (draft) return cell(`Draft ${draft.tag_name || draft.name || ''} waits for you`, { tone: 'look', version: draft.tag_name || '', waits: 'owner', next: 'Your yes to publish it', detail: live ? `Published now: ${live.tag_name}.` : '' })
  if (live) return cell(`Published ${live.tag_name}${live.prerelease ? ' (pre-release)' : ''}`, { tone: 'ok', version: live.tag_name || '' })
  return cell('No release yet', { waits: 'crew', next: 'Make a draft release for your yes' })
}

async function checkGithub(ids, { fetcher, useGh }) {
  if (!ids.repo) return cell('Not set up', { how: 'none', waits: 'owner', next: 'Name its repository in the launch plan' })
  return githubState(await releasesOf(ids.repo, fetcher, useGh))
}

async function checkItch(ids, { fetcher }) {
  if (!ids.target) return cell('Not set up', { how: 'none', waits: 'owner', next: ids.missing ? `Say ${ids.missing}` : 'Name its itch.io page (user/game) in the launch plan' })
  const channel = ids.channel || 'html5'
  const latest = await getJson(fetcher, `https://itch.io/api/1/x/wharf/latest?target=${encodeURIComponent(ids.target)}&channel_name=${encodeURIComponent(channel)}`)
  if (!latest.latest) return cell(`Nothing pushed to ${channel}`, { waits: 'crew', next: 'Push the build to its channel' })
  return cell(`Pushed ${latest.latest} on ${channel}`, { tone: 'ok', version: String(latest.latest), detail: 'Whether the page is public is not readable; the owner says so.' })
}

/** A store that refuses the key for one app says so plainly, with the one step that fixes it. */
function refusedCell(channel, ids, err) {
  const said = String(err?.message || err)
  if (!/\b(401|403)\b/.test(said)) return null
  if (channel === 'play') return cell('Not known: the key may not see this app', { how: 'none', tone: 'bad', waits: 'owner', detail: `Google said: ${said.slice(0, 160)}`, next: `In Play Console, Users and permissions: give the key's service account access to ${ids.package || 'this app'}` })
  if (channel === 'appstore') return cell('Not known: the key was refused', { how: 'none', tone: 'bad', waits: 'owner', detail: `Apple said: ${said.slice(0, 160)}`, next: 'Check the App Store Connect key on its row in Connectors (its role, or a key that was revoked)' })
  return null
}

const CHECKS = { play: checkPlay, appstore: checkApple, web: checkWeb, github: checkGithub, itch: checkItch }

/** A channel with no API: what a person last said, with its age; old news turns amber. */
function toldCell(told, ids, now) {
  if (!told) return cell(ids.missing ? 'Not set up' : 'Not told yet', { how: 'none', waits: 'owner', next: ids.missing ? `Say ${ids.missing}` : 'Say where it stands: this channel has no way to be read' })
  const old = now - told.at > TOLD_OLD_MS
  return cell(told.state, { how: 'told', tone: old ? 'look' : told.tone || 'wait', at: told.at, by: told.by || '', detail: old ? 'Told more than a week ago: say again where it stands.' : '', waits: told.waits || '', next: told.next || '' })
}

// ── one check of everything ─────────────────────────────────────────────────────────────

/** Read every product on every channel, keep the state, and add a history line for each change. */
export async function checkAll({ fetcher = fetch, useGh = true, now = Date.now(), plan = readPlan(), file = stateFile(), keys = null } = {}) {
  keys ||= { play: await readStoreKey('google-play'), appstore: await readStoreKey('app-store-connect') }
  const state = readState(file)
  const cells = {}
  for (const product of plan.products) {
    for (const [channel, ids] of Object.entries(product.channels || {})) {
      if (!CHANNEL.has(channel)) continue
      const key = keyOf(product.name, channel)
      let found
      try {
        found = CHECKS[channel] && !ids?.told ? await CHECKS[channel](ids || {}, { fetcher, useGh, key: keys[channel] }) : toldCell(state.told[key], ids || {}, now)
      } catch (err) {
        found = refusedCell(channel, ids || {}, err) || cell('Not known: the read failed', { how: 'none', tone: 'bad', detail: String(err?.message || err).slice(0, 200), waits: 'crew', next: 'Look at why the channel could not be read' })
      }
      found.checkedAt = now
      cells[key] = found
      const before = state.cells[key]
      if (!before || before.state !== found.state) state.history.unshift({ at: now, product: product.name, channel, from: before?.state || '', to: found.state, how: found.how })
    }
  }
  const next = { cells, told: state.told, releases: state.releases, history: state.history.slice(0, HISTORY), checkedAt: now }
  writeJson(file, next)
  return next
}

/** A person says where a channel with no API stands (or corrects one that cannot be read). */
export function tellState({ product, channel, state: said, tone = 'wait', waits = '', next = '', by = 'owner' }, { now = Date.now(), file = stateFile(), plan = readPlan() } = {}) {
  if (!plan.products.some((p) => p.name === product && p.channels?.[channel])) throw new EngineError(400, 'That product has no such channel in the launch plan')
  const words = String(said || '').trim().slice(0, 200)
  if (!words) throw new EngineError(400, 'Say where it stands')
  const state = readState(file)
  const key = keyOf(product, channel)
  state.told[key] = { state: words, tone: ['ok', 'go', 'look', 'bad', 'wait'].includes(tone) ? tone : 'wait', waits, next: String(next).slice(0, 200), at: now, by }
  state.history.unshift({ at: now, product, channel, from: state.cells[key]?.state || '', to: words, how: 'told', by })
  state.cells[key] = { ...toldCell(state.told[key], {}, now), checkedAt: now }
  writeJson(file, { ...state, history: state.history.slice(0, HISTORY) })
  return state.cells[key]
}

// ── a release, started from the board ──────────────────────────────────────────────────

/**
 * Start a product's release on the built-in release track: the crew builds it, writes the listing, makes and scores the
 * store images, the checks run and it is uploaded to the stores' testing lanes; nothing is sent for review before the
 * owner's yes at the track's gate. One release at a time per product.
 */
/** A release's failures past their rounds go to the ruler, else the lead: the crew's lead is named when the plan names neither. */
async function leadInput(co, inputs, options) {
  if (inputs.ruler || inputs.lead) return {}
  const bots = await call(`/companies/${co}/agents`, options).catch(() => [])
  const lead = (Array.isArray(bots) ? bots : []).filter((b) => b.status !== 'terminated').find((b) => b.role === 'ceo') || (Array.isArray(bots) ? bots : []).find((b) => !b.reportsTo && b.status !== 'terminated')
  return lead ? { lead: lead.name } : {}
}

export async function startRelease(name, { plan = readPlan(), file = stateFile(), now = Date.now(), ...options } = {}) {
  const product = plan.products.find((p) => p.name === name)
  if (!product) throw new EngineError(404, 'That product is not in the launch plan')
  const play = product.channels?.play?.package || ''
  const bundle = product.channels?.appstore?.bundle || ''
  if (!play && !bundle) throw new EngineError(400, 'A release goes to Google Play or the App Store: name its package or bundle id in the launch plan first')
  const state = readState(file)
  const open = state.releases[name]
  if (open?.requestId) {
    const before = await call(`/requests/${open.requestId}`, options).catch(() => null)
    if (before && !['done', 'stopped'].includes(before.status)) throw new EngineError(409, `A release of ${name} is already on its way (${before.jobCode})`)
  }
  const co = await companyId(options)
  const projects = await call(`/companies/${co}/projects`, options)
  const project = projects.find((p) => p.name === (product.project || product.name))
  const request = await call(`/companies/${co}/requests`, { ...options, method: 'POST', body: {
    track: plan.release?.track || 'release-app', title: `Release ${name}`, ...(project ? { projectId: project.id } : {}),
    words: `Release ${name} to ${[play && 'Google Play', bundle && 'the App Store'].filter(Boolean).join(' and ')}.${product.note ? `\n\n${product.note}` : ''}`,
    inputs: { ...(await leadInput(co, plan.release?.inputs || {}, options)), ...(plan.release?.inputs || {}), package: play, bundle,
      // The store-rules scan checks the laws of the countries it ships to and of what it does (docs/launch.md).
      ...(Array.isArray(product.regions) && product.regions.length ? { regions: product.regions.join(',') } : {}),
      ...(Array.isArray(product.features) && product.features.length ? { features: product.features.join(',') } : {}) },
  } })
  state.releases[name] = { requestId: request.id, jobCode: request.jobCode || '', at: now }
  state.history.unshift({ at: now, product: name, channel: play ? 'play' : 'appstore', from: '', to: `Release ${request.jobCode || ''} started`, how: 'told', by: 'owner' })
  writeJson(file, { ...state, history: state.history.slice(0, HISTORY) })
  return request
}

/** Where each product's latest release stands, read from its request on the engine. */
async function releaseStates(state, options) {
  const out = {}
  for (const [name, r] of Object.entries(state.releases || {})) {
    const req = await call(`/requests/${r.requestId}`, options).catch(() => null)
    if (!req) continue
    const trip = req.trips?.at(-1)
    const step = trip?.steps?.find((s) => s.id === trip.current)
    out[name] = { job: req.jobCode, status: req.status, tripId: trip?.id || '', step: step?.title || '', waits: step?.kind === 'gate' && trip?.status === 'running', tripStatus: trip?.status || '', cost: Number(req.cost?.usd) || 0 }
  }
  return out
}

// ── the page ────────────────────────────────────────────────────────────────────────────

const WAITS = { owner: 'you', crew: 'the crew', store: 'the store' }
const ORDER = { owner: 0, crew: 1, store: 2, '': 3 }

/** A product's readiness, as far as it can be read today; the rest is said to be not checked yet. */
function readinessOf(product, cells, keys) {
  const items = []
  for (const [channel, ids] of Object.entries(product.channels || {})) {
    const c = CHANNEL.get(channel)
    if (!c) continue
    items.push({ group: 'Plan', text: `${c.name}: its id is known`, state: ids?.missing ? 'fail' : 'pass', detail: ids?.missing || '' })
    if (c.key) items.push({ group: 'Keys', text: `${c.name} key added`, state: keys[channel] ? 'pass' : 'yours', detail: keys[channel] ? '' : 'Add it once on its row in Connectors' })
  }
  if (product.kind === 'app') {
    items.push({ group: 'Payments', text: 'Store products and test purchases', state: 'unknown', detail: 'Not checked yet' })
    items.push({ group: 'Monitoring', text: 'Crash reports and events from the new version', state: 'unknown', detail: 'Not checked yet' })
    items.push({ group: 'Legal', text: 'Content rating, data safety and privacy forms', state: 'yours', detail: 'Only you can fill these in the consoles' })
  }
  return items
}

export function launchPage({ plan = readPlan(), state = readState(), keys = {}, releases = {}, now = Date.now() } = {}) {
  const used = CHANNELS.filter((c) => plan.products.some((p) => p.channels?.[c.id]))
  const rows = plan.products.map((p) => {
    const cells = Object.fromEntries(used.map((c) => [c.id, p.channels?.[c.id] ? state.cells[keyOf(p.name, c.id)] || cell('Not checked yet', { how: 'none' }) : null]))
    const waiting = Object.entries(cells).filter(([, x]) => x?.next).sort(([, a], [, b]) => ORDER[a.waits || ''] - ORDER[b.waits || ''])[0]
    return {
      name: p.name, project: p.project || '', kind: p.kind || '', note: p.note || '', first: Boolean(p.first), cells,
      canRelease: Boolean(p.channels?.play?.package || p.channels?.appstore?.bundle), release: releases[p.name] || null,
      next: waiting ? { channel: CHANNEL.get(waiting[0]).name, text: waiting[1].next, waits: WAITS[waiting[1].waits] || '' } : null,
      readiness: readinessOf(p, cells, keys),
      history: state.history.filter((h) => h.product === p.name).slice(0, 20),
    }
  })
  return { channels: used.map(({ id, name }) => ({ id, name })), rows, checkedAt: state.checkedAt, stale: now - state.checkedAt > AGE_MS, planFound: plan.found, planFile: planFile().replace(os.homedir(), '~') }
}

let running = null
/** The page, reading again in the background when the last check is older than ten minutes, or now when asked. */
export async function launchView({ now = Date.now(), force = false } = {}) {
  const keys = { play: await readStoreKey('google-play'), appstore: await readStoreKey('app-store-connect') }
  const state = readState()
  if (force || now - state.checkedAt > AGE_MS) {
    running ||= checkAll({ keys }).finally(() => { running = null })
    if (force || !state.checkedAt) await running
  }
  const state2 = readState()
  return launchPage({ state: state2, keys, releases: await releaseStates(state2, {}).catch(() => ({})), now })
}
