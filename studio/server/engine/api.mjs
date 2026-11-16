/**
 * The engine's whole front door: who is asking, then the read or the change.
 *
 * Reading is `http.mjs` (answered from the store). This adds who the caller
 * is and every path that changes something, under one set of addresses, so the crew's
 * scripts and a bot's own calls need nothing but the engine's address.
 *
 * A caller with no pass is the owner or one of the crew's scripts on this computer. A bot in a run
 * sends its run's pass (`Authorization: Bearer …`, the key its run was told); a pass that is not a
 * live run's is refused, so a finished run can change nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { addProduct, checkout, declineCard, noInvites, noSuch, patchSettings, release } from './extras.mjs'
import { engineBody, engineCode, withDisplay } from './codes.mjs'
import { attach, fileOf, fileOfForm } from './files.mjs'
import { handle } from './http.mjs'
import { more } from './read-more.mjs'
import { instructionsFile, restoreInstructions, rollbackAgent, saveInstructions, terminateAgent } from './bots.mjs'
import { addWorkspace, archiveProject, createProject, patchWorkspace, removeWorkspace } from './projects.mjs'
import { addTrigger, createRoutine, patchRoutine, patchTrigger, removeRoutine, removeTrigger, runRoutine } from './routines.mjs'
import { createCompany, isSetUp, patchCompany } from './studio.mjs'
import { cancelRun, whoHolds } from './runner.mjs'
import { Refused, addComment, createCard, createJob, openChat, patchJob, patchProject, putAgent, resetSessions, putDocument, restoreDocument, setPaused, settleCard, wake } from './write.mjs'
import { runLogsDir } from './names.mjs'

const one = '([^/]+)'
const route = (method, pattern, act) => [method, new RegExp(`^${pattern}$`), act]

/** Each path that changes something: (store, parts, body, ctx) → [status, answer]. */
const WRITES = [
  route('POST', `/companies/${one}/issues`, (s, p, b, c) => [201, createJob(s, p[0], b, c)]),
  route('PATCH', `/issues/${one}`, (s, p, b, c) => [200, patchJob(s, p[0], b, c)]),
  route('POST', `/issues/${one}/comments`, (s, p, b, c) => [201, addComment(s, p[0], b, c)]),
  route('POST', `/issues/${one}/interactions`, (s, p, b, c) => [201, createCard(s, p[0], b, c)]),
  route('POST', `/issues/${one}/interactions/${one}/(respond|accept|reject|withdraw|cancel)`, (s, p, b, c) => [200, settleCard(s, p[0], p[1], p[2], b, c)]),
  route('PUT', `/issues/${one}/documents/${one}`, (s, p, b, c) => [200, putDocument(s, p[0], p[1], b, c)]),
  route('POST', `/companies/${one}/agents`, (s, p, b, c) => [201, putAgent(s, p[0], null, b, c)]),
  route('PATCH', `/agents/${one}`, (s, p, b, c) => [200, putAgent(s, null, p[0], b, c)]),
  route('POST', `/companies/${one}/chats/${one}`, (s, p, b, c) => [200, openChat(s, p[0], p[1], c)]),
  route('POST', `/agents/${one}/(pause|resume)`, (s, p, b, c) => [200, setPaused(s, p[0], p[1] === 'pause', c)]),
  // The crew's scripts name the job in the body's own words: issueId, or payload.issueId.
  route('POST', `/agents/${one}/wakeup`, (s, p, b, c) => [202, wake(s, p[0], { issueId: b.issueId || b.payload?.issueId || null, source: b.source || 'automation', reason: b.reason || 'on_demand', forceFreshSession: b.forceFreshSession === true, payload: { ...(b.payload || {}), ...(b.failedRunId ? { failedRunId: b.failedRunId } : {}) } }, c)]),
  route('PATCH', `/projects/${one}`, (s, p, b, c) => [200, patchProject(s, p[0], b, c)]),
  route('POST', `/agents/${one}/runtime-state/reset-session`, (s, p, b, c) => [200, resetSessions(s, p[0], c)]),
  route('POST', `/routines/${one}/run`, (s, p, b, c) => [200, runRoutine(s, p[0], c)]),
  // The studio itself.
  route('POST', '/companies', (s, p, b, c) => [201, createCompany(s, b, c)]),
  route('PATCH', `/companies/${one}`, (s, p, b, c) => [200, patchCompany(s, p[0], b, c)]),
  // Bots: removed, their settings taken back, their instructions saved and restored.
  route('POST', `/agents/${one}/terminate`, (s, p, b, c) => [200, terminateAgent(s, p[0], c)]),
  route('DELETE', `/agents/${one}`, (s, p, b, c) => [200, terminateAgent(s, p[0], c)]),
  route('POST', `/agents/${one}/config-revisions/${one}/rollback`, (s, p, b, c) => [200, rollbackAgent(s, p[0], p[1], b, c)]),
  route('PUT', `/agents/${one}/instructions-bundle/file`, (s, p, b, c) => { instructionsFile(s, p[0], b.path === undefined || b.path === null ? {} : { path: b.path }, c); return [200, saveInstructions(s, p[0], { content: b.content, baseRevisionId: b.baseRevisionId ?? null }, c)] }),
  route('POST', `/agents/${one}/instructions-bundle/restore`, (s, p, b, c) => [200, restoreInstructions(s, p[0], { revisionId: b.revisionId, baseRevisionId: b.baseRevisionId ?? null }, c)]),
  route('PUT', `/agents/${one}/instructions`, (s, p, b, c) => [200, saveInstructions(s, p[0], { content: b.content, baseRevisionId: b.baseRevisionId ?? null }, c)]),
  // Projects and the folders they are worked in.
  route('POST', `/companies/${one}/projects`, (s, p, b, c) => [201, createProject(s, p[0], b, c)]),
  route('DELETE', `/projects/${one}`, (s, p, b, c) => [200, archiveProject(s, p[0], c)]),
  route('POST', `/projects/${one}/workspaces`, (s, p, b, c) => [201, addWorkspace(s, p[0], b, c)]),
  route('PATCH', `/projects/${one}/workspaces/${one}`, (s, p, b, c) => [200, patchWorkspace(s, p[0], p[1], b, c)]),
  route('DELETE', `/projects/${one}/workspaces/${one}`, (s, p, b, c) => [200, removeWorkspace(s, p[0], p[1], c)]),
  // Routines and their timetables.
  route('POST', `/companies/${one}/routines`, (s, p, b, c) => [201, createRoutine(s, p[0], b, c)]),
  route('PATCH', `/routines/${one}`, (s, p, b, c) => [200, patchRoutine(s, p[0], b, c)]),
  route('DELETE', `/routines/${one}`, (s, p, b, c) => [200, removeRoutine(s, p[0], c)]),
  route('POST', `/routines/${one}/triggers`, (s, p, b, c) => [201, addTrigger(s, p[0], b, c)]),
  route('PATCH', `/routine-triggers/${one}`, (s, p, b, c) => [200, patchTrigger(s, p[0], b, c)]),
  route('DELETE', `/routine-triggers/${one}`, (s, p, b, c) => [200, removeTrigger(s, p[0], c)]),
  // Around the edges: made things, a bot's own take and let-go, a sign-in card's "no", settings.
  route('POST', `/issues/${one}/work-products`, (s, p, b, c) => [201, addProduct(s, p[0], b, c)]),
  route('POST', `/issues/${one}/checkout`, (s, p, b, c) => [200, checkout(s, p[0], b, c)]),
  route('POST', `/issues/${one}/release`, (s, p) => [200, release(s, p[0])]),
  route('POST', `/connection-intents/${one}/decline`, (s, p, b, c) => [200, declineCard(s, p[0], b, c)]),
  route('PATCH', `/instance/settings/${one}`, (s, p, b, c) => [200, patchSettings(s, p[0], b, c)]),
  // What a Botyard does not have, said in plain words.
  route('POST', `/approvals/${one}/(approve|reject)`, noSuch('Approval')),
  route('POST', `/companies/${one}/invites`, noInvites),
  route('POST', `/invites/${one}/revoke`, noSuch('Invite')),
  route('PATCH', `/companies/${one}/skills/${one}/files`, noSuch('Skill')),
  route('POST', `/issues/${one}/documents/${one}/revisions/${one}/restore`, (s, p, b, c) => [200, restoreDocument(s, p[0], p[1], p[2], c)]),
  route('POST', `/heartbeat-runs/${one}/cancel`, (s, p, b, c) => {
    if (!cancelRun(s, p[0], c)) throw new Refused(409, 'That run is not one this engine has going')
    return [200, { ok: true }]
  }),
]

/** A run's log, a piece at a time, as `{ content, nextOffset }`. */
function runLog(store, runId, query, { dataDir }) {
  const run = store.object('SELECT raw FROM runs WHERE id = ?', runId)
  if (!run) throw new Refused(404, 'Run not found')
  if (!run.logRef) throw new Refused(404, 'This run has no log')
  const file = path.join(runLogsDir(dataDir), run.logRef)
  const offset = Math.max(0, Number(query.get('offset')) || 0)
  const limit = Math.min(1024 * 1024, Math.max(1, Number(query.get('limitBytes')) || 256 * 1024))
  let size = 0
  try { size = fs.statSync(file).size } catch { throw new Refused(404, 'This run has no log yet') }
  // `tail` asks for the last bytes of the file as it is now: a run still going has no length booked yet.
  const tail = Number(query.get('tail')) || 0
  if (tail > 0) {
    const from = Math.max(0, size - Math.min(1024 * 1024, tail))
    const piece = Buffer.alloc(size - from)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, piece, 0, piece.length, from) } finally { fs.closeSync(fd) }
    return { runId, store: 'local_file', logRef: run.logRef, content: piece.toString('utf8'), offset: from, size }
  }
  const buffer = Buffer.alloc(Math.max(0, Math.min(limit, size - offset)))
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buffer, 0, buffer.length, offset) } finally { fs.closeSync(fd) }
  return { runId, store: 'local_file', logRef: run.logRef, content: buffer.toString('utf8'), ...(offset + buffer.length < size ? { nextOffset: offset + buffer.length } : {}) }
}

/**
 * Answer one request. `headers` are lower-cased; `body` is the parsed JSON of a write.
 * `raw` is the body's own bytes, for an upload. A file is answered as `{ status, file }`.
 * @returns {{ status: number, body?: unknown, file?: { path: string, type: string, name: string } }}
 */
export function answer(store, request = {}, options = {}) {
  // A job named by its project's letters (BAL-326) is the job the engine knows as NGE-326.
  const asked = { ...request }
  if (typeof asked.url === 'string') asked.url = asked.url.replace(/^([^?#]*)/, (path) => path.split('/').map((part) => { try { return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(part) ? engineCode(store, part) : part } catch { return part } }).join('/'))
  if (asked.body && typeof asked.body === 'object') asked.body = engineBody(store, asked.body)
  const out = answerOne(store, asked, options)
  if (out.body && typeof out.body === 'object') out.body = withDisplay(store, out.body)
  return out
}

function answerOne(store, { method = 'GET', url = '/', headers = {}, body = {}, raw = null } = {}, { dataDir, now = Date.now(), actor: known = null } = {}) {
  const verb = String(method).toUpperCase()
  let at
  try { at = new URL(url, 'http://engine.local') } catch { return { status: 400, body: { error: 'Not a path' } } }
  let where = at.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  const pass = known ? '' : /^Bearer\s+(\S+)$/i.exec(headers.authorization || '')?.[1] || ''
  const bot = known?.agent ? { agentId: known.agent, runId: known.run || null } : pass ? whoHolds(store, pass) : null
  if (pass && !bot) return { status: 401, body: { error: 'This pass is not a live run\'s. A run\'s pass stops working when the run ends' } }
  const actor = known || (bot ? { agent: bot.agentId, run: bot.runId } : { user: 'local-board' })
  const ctx = { now, actor, dataDir }
  try {
    // "me" is the bot whose run is calling.
    if (/^\/agents\/me(\/|$)/.test(where)) {
      if (!bot) return { status: 401, body: { error: 'Only a bot in a run has a "me"' } }
      where = where.replace(/^\/agents\/me/, `/agents/${bot.agentId}`)
      url = `${where}${at.search}`
    }
    if (verb === 'GET') {
      if (where === '/health') return { status: 200, body: { status: 'ok', engine: 'studio', live: true, setUp: isSetUp(store) } }
      // A file's own bytes: the caller sends them on as they are.
      const content = new RegExp(`^/attachments/${one}/content$`).exec(where)
      if (content) return { status: 200, file: fileOf(store, content[1], ctx) }
      const log = new RegExp(`^/heartbeat-runs/${one}/log$`).exec(where)
      if (log) return { status: 200, body: runLog(store, log[1], at.searchParams, ctx) }
      const extra = more(store, where, Object.fromEntries(at.searchParams), ctx)
      if (extra) return extra
      return handle(store, 'GET', url, { now })
    }
    const upload = verb === 'POST' ? new RegExp(`^/companies/${one}/issues/${one}/attachments$`).exec(where) : null
    if (upload) return { status: 201, body: attach(store, upload[1], upload[2], fileOfForm(raw, headers['content-type'] || ''), ctx) }
    for (const [m, pattern, act] of WRITES) {
      if (m !== verb) continue
      const match = pattern.exec(where)
      if (!match) continue
      const [status, out] = act(store, match.slice(1).map((part) => decodeURIComponent(part)), body && typeof body === 'object' ? body : {}, ctx)
      return { status, body: out }
    }
    return { status: 404, body: { error: 'API route not found' } }
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { error: err.message } }
    return { status: 500, body: { error: 'Internal server error' } }
  }
}
