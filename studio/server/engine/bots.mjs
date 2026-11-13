/**
 * Bots in full: made, changed, removed; their instructions as text with every earlier version kept;
 * their settings' revisions, any of which can be taken back; and their variables, where a secret is
 * kept apart from the bot's row so that no read ever gives it out.
 *
 * Only the owner (or a script on this computer) changes a bot. A bot in a run may read all of this
 * and change none of it.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ADAPTER_TYPES } from './adapters.mjs'
import { HIDDEN, botSecretsFile, instructionsDir, isHidden, keysDir } from './names.mjs'
import { cancelRun } from './runner.mjs'
import { Refused, note } from './write.mjs'

const iso = (now) => new Date(now).toISOString()
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const agentOf = (store, id) => store.object('SELECT raw FROM agents WHERE id = ?', id)

export const ROLES = new Set(['ceo', 'engineer', 'qa', 'researcher', 'general', 'designer', 'pm'])
export const MAX_INSTRUCTIONS = 400_000
/** What a settings revision remembers of a bot. */
const SETTINGS = ['name', 'role', 'title', 'reportsTo', 'capabilities', 'adapterType', 'adapterConfig', 'runtimeConfig']
const settingsOf = (agent) => Object.fromEntries(SETTINGS.map((key) => [key, agent[key] ?? null]))

function ownerOnly(actor, what) {
  if (actor?.agent) throw new Refused(403, `Only the owner ${what}`)
}

function botOr404(store, id) {
  const agent = agentOf(store, id)
  if (!agent) throw new Refused(404, 'Agent not found')
  return agent
}
function liveBot(store, id) {
  const agent = botOr404(store, id)
  if (agent.status === 'terminated') throw new Refused(409, 'This bot was removed')
  return agent
}

// ── variables and secrets ───────────────────────────────────────────────────────────

/** A variable whose name says it is a secret is treated as one, whatever it was sent as. */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|APIKEY)($|_)/i
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isSecretName = (name) => SECRET_NAME.test(String(name))

function readSecrets(dataDir) {
  if (!dataDir) return {}
  try {
    const all = JSON.parse(fs.readFileSync(botSecretsFile(dataDir), 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    return {}
  }
}
function writeSecrets(dataDir, all) {
  const file = botSecretsFile(dataDir)
  fs.mkdirSync(keysDir(dataDir), { recursive: true, mode: 0o700 })
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(all)}\n`, { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
  fs.chmodSync(file, 0o600)
}

/**
 * A bot's variables as its row keeps them: plain ones as they were sent, secrets as a marker. The
 * secret values go to the keys file. A secret sent back as the marker (or with no value) keeps the
 * value already held; a name left out is forgotten.
 */
function sealEnv(dataDir, agentId, given) {
  if (given === undefined || given === null) return given
  if (typeof given !== 'object' || Array.isArray(given)) throw new Refused(400, 'A bot\'s variables are names with values')
  const all = readSecrets(dataDir)
  const held = all[agentId] && typeof all[agentId] === 'object' ? all[agentId] : {}
  const keep = {}
  const row = {}
  for (const [name, raw] of Object.entries(given)) {
    if (!VARIABLE_NAME.test(name)) throw new Refused(400, `"${String(name).slice(0, 40)}" is not a variable name`)
    const entry = raw && typeof raw === 'object' ? raw : { type: 'plain', value: raw }
    const secret = entry.type === 'secret' || entry.type === 'secret_ref' || isSecretName(name)
    if (!secret) { row[name] = raw; continue }
    const value = entry.value
    if (value !== undefined && value !== null && value !== '' && !isHidden(value)) keep[name] = String(value)
    else if (typeof held[name] === 'string') keep[name] = held[name]
    row[name] = { type: 'secret', value: HIDDEN, set: dataDir ? name in keep : false }
  }
  if (dataDir && (Object.keys(keep).length || all[agentId])) {
    if (Object.keys(keep).length) all[agentId] = keep
    else delete all[agentId]
    writeSecrets(dataDir, all)
  }
  return row
}

/** A bot's variables for a run: the secrets with their real values, and any that has none left out. */
export function envForRun(dataDir, agent) {
  const given = agent?.adapterConfig?.env
  if (!given || typeof given !== 'object') return {}
  const held = readSecrets(dataDir)[agent.id] || {}
  const out = {}
  for (const [name, raw] of Object.entries(given)) {
    if (raw && typeof raw === 'object' && (raw.type === 'secret' || raw.type === 'secret_ref')) {
      if (typeof held[name] === 'string') out[name] = held[name]
      continue
    }
    out[name] = raw
  }
  return out
}

function forgetSecrets(dataDir, agentId) {
  if (!dataDir) return
  const all = readSecrets(dataDir)
  if (!(agentId in all)) return
  delete all[agentId]
  writeSecrets(dataDir, all)
}

// ── settings and their revisions ────────────────────────────────────────────────────

function addRevision(store, before, next, { source, now, actor, rolledBackFromRevisionId = null }) {
  const changedKeys = SETTINGS.filter((key) => !same(before[key], next[key]))
  if (!changedKeys.length) return null
  const revision = {
    id: randomUUID(), companyId: next.companyId, agentId: next.id, createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board',
    source, rolledBackFromRevisionId, changedKeys, beforeConfig: settingsOf(before), afterConfig: settingsOf(next), createdAt: iso(now),
  }
  store.put('agent_revisions', revision, { position: store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM agent_revisions WHERE agent_id = ?', next.id).n })
  return revision
}

const urlKeyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function nameFree(store, name, exceptId) {
  const other = store.objects('SELECT raw FROM agents WHERE name = ?', name).find((a) => a.id !== exceptId && a.status !== 'terminated')
  if (other) throw new Refused(409, 'Another bot already has that name')
}

/** A bot may not answer to itself, or to a bot that answers to it. */
function bossOr400(store, id, bossId) {
  if (!bossId) return null
  const boss = agentOf(store, bossId)
  if (!boss || boss.status === 'terminated') throw new Refused(400, 'The bot it reports to does not exist')
  for (let at = boss, n = 0; at && n < 50; at = at.reportsTo ? agentOf(store, at.reportsTo) : null, n++) {
    if (at.id === id) throw new Refused(400, 'A bot cannot report to itself, directly or through others')
  }
  return bossId
}

/**
 * A bot made new (POST /companies/:id/agents) or changed (PATCH /agents/:id). What it was before a
 * change is kept as a revision. `instructions` in the body saves its instructions in the same call.
 */
export function putAgent(store, companyId, id, body = {}, { now = Date.now(), actor, dataDir = '' } = {}) {
  ownerOnly(actor, 'makes or changes a bot')
  const before = id ? liveBot(store, id) : null
  const company = store.object('SELECT raw FROM company LIMIT 1')
  if (!before && (!company || company.id !== companyId)) throw new Refused(404, 'Company not found')
  const name = body.name !== undefined ? text(body.name, 120).trim() : before?.name
  if (!name) throw new Refused(400, 'A bot needs a name')
  nameFree(store, name, before?.id)
  if (body.adapterType !== undefined && !ADAPTER_TYPES.includes(body.adapterType)) throw new Refused(400, `Botyard can run a bot on ${ADAPTER_TYPES.join(', ')}`)
  if (body.role !== undefined && !ROLES.has(body.role)) throw new Refused(400, `A bot's role is one of ${[...ROLES].join(', ')}`)
  if (body.adapterConfig !== undefined && (body.adapterConfig === null || typeof body.adapterConfig !== 'object' || Array.isArray(body.adapterConfig))) throw new Refused(400, 'adapterConfig is a set of settings')
  if (body.instructions !== undefined && (typeof body.instructions !== 'string' || !body.instructions.trim())) throw new Refused(400, 'The instructions are empty')
  const botId = before?.id || randomUUID()
  const reportsTo = body.reportsTo !== undefined ? bossOr400(store, botId, body.reportsTo) : before?.reportsTo || null
  let adapterConfig = body.adapterConfig === undefined ? before?.adapterConfig || {}
    : body.replaceAdapterConfig || !before ? { ...body.adapterConfig } : { ...(before.adapterConfig || {}), ...body.adapterConfig }
  if (body.adapterConfig !== undefined && adapterConfig.env !== undefined) adapterConfig = { ...adapterConfig, env: sealEnv(dataDir, botId, adapterConfig.env) }
  else if (body.adapterConfig !== undefined && body.replaceAdapterConfig) forgetSecrets(dataDir, botId)
  const next = {
    ...(before || { id: botId, companyId: company.id, status: 'idle', icon: null, appearance: null, pauseReason: null, pausedAt: null, lastHeartbeatAt: null, avatarUrl: null, createdAt: iso(now), permissions: {}, metadata: null, spentMonthlyCents: 0, budgetMonthlyCents: 0 }),
    name, role: body.role || before?.role || 'general', title: body.title !== undefined ? text(body.title, 200) : before?.title || '',
    capabilities: body.capabilities !== undefined ? text(body.capabilities, 4000) || null : before?.capabilities || null,
    adapterType: body.adapterType || before?.adapterType || 'process', adapterConfig,
    runtimeConfig: body.runtimeConfig !== undefined ? body.runtimeConfig || {} : before?.runtimeConfig || {},
    reportsTo, urlKey: urlKeyOf(name), updatedAt: iso(now),
    // What the bot's own settings say of its role and look (lib/looks.mjs reads them): laid over what was there.
    ...(body.metadata !== undefined ? { metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { ...(before?.metadata || {}), ...body.metadata } : null } : {}),
  }
  store.tx(() => {
    store.put('agents', next)
    if (before) addRevision(store, before, next, { source: actor?.agent ? 'agent' : 'board', now, actor })
    note(store, before ? 'agent.updated' : 'agent.created', { type: 'agent', id: next.id }, actor, {}, now)
  })
  if (body.instructions !== undefined) saveInstructions(store, next.id, { content: body.instructions }, { now, actor, dataDir })
  return agentOf(store, next.id)
}

/** Set a bot's settings back to what one revision left (or, with `to: 'before'`, to what it found). */
export function rollbackAgent(store, agentId, revisionId, body = {}, { now = Date.now(), actor, dataDir = '' } = {}) {
  ownerOnly(actor, 'takes a bot\'s settings back')
  const before = liveBot(store, agentId)
  const revision = store.object('SELECT raw FROM agent_revisions WHERE id = ? AND agent_id = ?', revisionId, agentId)
  if (!revision) throw new Refused(404, 'Revision not found')
  const target = body.to === 'before' ? revision.beforeConfig : revision.afterConfig
  if (!target || typeof target !== 'object') throw new Refused(409, 'This revision did not keep the settings')
  const next = { ...before, updatedAt: iso(now) }
  for (const key of SETTINGS) if (key in target) next[key] = target[key]
  if (!next.name) next.name = before.name
  nameFree(store, next.name, before.id)
  next.urlKey = urlKeyOf(next.name)
  // The bot it answered to then may be gone now.
  if (next.reportsTo) { try { bossOr400(store, before.id, next.reportsTo) } catch { next.reportsTo = null } }
  if (next.adapterConfig?.env !== undefined) next.adapterConfig = { ...next.adapterConfig, env: sealEnv(dataDir, before.id, next.adapterConfig.env) }
  store.tx(() => {
    store.put('agents', next)
    addRevision(store, before, next, { source: 'rollback', now, actor, rolledBackFromRevisionId: revision.id })
    note(store, 'agent.config_rolled_back', { type: 'agent', id: agentId }, actor, { revisionId: revision.id }, now)
  })
  return next
}

/**
 * Remove a bot. Its row stays, because jobs, runs and comments name it; it leaves every list, its
 * waiting wakes are dropped, what it has running is stopped, and its name is free again.
 */
export function terminateAgent(store, agentId, { now = Date.now(), actor, dataDir = '', io } = {}) {
  ownerOnly(actor, 'removes a bot')
  const agent = botOr404(store, agentId)
  if (agent.status === 'terminated') return agent
  const next = { ...agent, status: 'terminated', terminatedAt: iso(now), pauseReason: null, pausedAt: null, updatedAt: iso(now) }
  store.tx(() => {
    store.put('agents', next)
    for (const wake of store.objects("SELECT raw FROM wakes WHERE agent_id = ? AND status = 'queued'", agentId)) {
      store.put('wakes', { ...wake, status: 'cancelled', error: 'The bot was removed', finishedAt: iso(now), updatedAt: iso(now) })
    }
    for (const under of store.objects('SELECT raw FROM agents WHERE reports_to = ?', agentId)) store.put('agents', { ...under, reportsTo: agent.reportsTo || null, updatedAt: iso(now) })
    note(store, 'agent.terminated', { type: 'agent', id: agentId }, actor, {}, now)
  })
  for (const run of store.rows("SELECT id FROM runs WHERE agent_id = ? AND status = 'running'", agentId)) cancelRun(store, run.id, { dataDir, ...(io ? { io } : {}) })
  forgetSecrets(dataDir, agentId)
  return next
}

// ── instructions ────────────────────────────────────────────────────────────────────

/** The file a bot's instructions are in: its own, or one the engine keeps for it. */
export function instructionsFileOf(agent, dataDir) {
  const own = agent.adapterConfig?.instructionsFilePath
  if (typeof own === 'string' && own.trim()) return own
  return dataDir ? path.join(instructionsDir(dataDir), `${agent.id}.md`) : ''
}

const revisionsOf = (store, agentId) => store.objects('SELECT raw FROM instruction_revisions WHERE agent_id = ? ORDER BY position', agentId)
const onDisk = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }

function addInstructions(store, agent, content, source, { now, actor }) {
  const revision = { id: randomUUID(), companyId: agent.companyId, agentId: agent.id, source, content, bytes: Buffer.byteLength(content), createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', createdAt: iso(now) }
  store.put('instruction_revisions', revision, { position: store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM instruction_revisions WHERE agent_id = ?', agent.id).n })
  return revision
}

/** The bot's instructions now: the file's own text, and the newest revision kept of it. */
export function instructions(store, agentId, { dataDir = '' } = {}) {
  const agent = botOr404(store, agentId)
  const file = instructionsFileOf(agent, dataDir)
  const revisions = revisionsOf(store, agentId)
  const latest = revisions.at(-1) || null
  const disk = file ? onDisk(file) : null
  return { agent, file, content: disk ?? latest?.content ?? '', revisionId: latest?.id || null, revisions }
}

/**
 * Save a bot's instructions as a new revision and write them where the bot reads them. If the file
 * was changed outside Botyard since the last revision, that text is kept as a revision of its own
 * first, so nothing is written over unseen.
 */
export function saveInstructions(store, agentId, { content, baseRevisionId = null, source = '' } = {}, { now = Date.now(), actor, dataDir = '' } = {}) {
  ownerOnly(actor, 'changes a bot\'s instructions')
  const agent = liveBot(store, agentId)
  if (typeof content !== 'string' || !content.trim()) throw new Refused(400, 'The instructions are empty')
  if (content.length > MAX_INSTRUCTIONS) throw new Refused(400, 'The instructions are too long')
  const file = instructionsFileOf(agent, dataDir)
  if (!file) throw new Refused(409, 'This bot has no place for its instructions')
  const revisions = revisionsOf(store, agentId)
  let latest = revisions.at(-1) || null
  if (baseRevisionId !== null && baseRevisionId !== undefined && baseRevisionId !== (latest?.id || null)) throw new Refused(409, 'These instructions were changed since you opened them. Open them again and make your change there')
  const disk = onDisk(file)
  return store.tx(() => {
    if (disk !== null && disk.trim() && disk !== (latest?.content ?? null) && disk !== content) latest = addInstructions(store, agent, disk, 'file', { now: now - 1, actor: null })
    const revision = latest && latest.content === content ? latest : addInstructions(store, agent, content, source || (actor?.agent ? 'api' : 'board'), { now, actor })
    if (disk !== content) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, content)
      fs.renameSync(`${file}.tmp`, file)
    }
    // A bot whose instructions the engine keeps is told where they are, as the crew's own are.
    if (agent.adapterConfig?.instructionsFilePath !== file) store.put('agents', { ...agentOf(store, agentId), adapterConfig: { ...(agentOf(store, agentId).adapterConfig || {}), instructionsFilePath: file }, updatedAt: iso(now) })
    if (revision !== latest) note(store, 'agent.instructions_saved', { type: 'agent', id: agentId }, actor, { revisionId: revision.id }, now)
    return { path: path.basename(file), content, revisionId: revision.id }
  })
}

/** Make an earlier revision the current one, as a new revision. */
export function restoreInstructions(store, agentId, { revisionId, baseRevisionId = null } = {}, ctx = {}) {
  ownerOnly(ctx.actor, 'changes a bot\'s instructions')
  const old = store.object('SELECT raw FROM instruction_revisions WHERE id = ? AND agent_id = ?', revisionId || '', agentId)
  if (!old) throw new Refused(404, 'Revision not found')
  return saveInstructions(store, agentId, { content: old.content, baseRevisionId, source: 'restore' }, ctx)
}

const shown = (revision) => ({ id: revision.id, createdAt: revision.createdAt, source: revision.source, bytes: revision.bytes ?? Buffer.byteLength(revision.content || '') })

/** The wire shapes the map reads: the bundle, its one file, its history, and what one revision changed. */
export function instructionsBundle(store, agentId, ctx = {}) {
  const { agent, file } = instructions(store, agentId, ctx)
  return { agentId, companyId: agent.companyId, mode: 'managed', editable: agent.status !== 'terminated', rootPath: file ? path.dirname(file) : '', entryFile: file ? path.basename(file) : '', resolvedEntryPath: file, warnings: [], files: file ? [{ path: path.basename(file) }] : [] }
}
export function instructionsFile(store, agentId, query = {}, ctx = {}) {
  const { file, content, revisionId } = instructions(store, agentId, ctx)
  // Only the bot's own instructions are read out, whatever is asked for.
  if (!file || (query.path !== undefined && path.basename(String(query.path)) !== path.basename(file))) throw new Refused(404, 'File not found')
  return { path: path.basename(file), content, revisionId }
}
export const instructionsHistory = (store, agentId) => { botOr404(store, agentId); return { revisions: revisionsOf(store, agentId).reverse().map(shown) } }
export function instructionsPage(store, agentId, ctx = {}) {
  const { file, content, revisionId, revisions } = instructions(store, agentId, ctx)
  return { content, revisionId, path: file, history: [...revisions].reverse().map(shown) }
}

/** What changed between two revisions: the text around the change, what went and what came. */
export function instructionsDiff(store, agentId, query = {}) {
  botOr404(store, agentId)
  const textOf = (id) => {
    if (!id || id === 'null') return ''
    const found = store.object('SELECT raw FROM instruction_revisions WHERE id = ? AND agent_id = ?', String(id), agentId)
    if (!found) throw new Refused(404, 'Revision not found')
    return found.content || ''
  }
  const from = textOf(query.from)
  const to = textOf(query.to)
  let head = 0
  while (head < from.length && head < to.length && from[head] === to[head]) head++
  let tail = 0
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++
  return { prefix: from.slice(0, head), removed: from.slice(head, from.length - tail), added: to.slice(head, to.length - tail), suffix: from.slice(from.length - tail) }
}
