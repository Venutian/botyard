/**
 * The owner's buttons on the Improvements page: Accept, Reject, Ask me, Send to Tony.
 *
 * The findings are one plain file, improvements.json in the crew folder (own/improvements.py writes it
 * too). The server changes it directly with the same fields that script uses (status, decidedBy,
 * decidedAt, reason, job) instead of running the script: a Botyard install need not have ngen-own.
 * Every owner decision is written whole to a temp file and renamed over the original, so a reader
 * never sees half a file, and the one it replaces is pushed onto the finding's `history` so no
 * decision is lost. An owner decision always wins: a second click just changes the status again.
 * A rejection also goes into improvements-rejected.json, which the scout reads to not file it again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EngineError, addJob, call, companyId, crewOf } from './engine.mjs'
import { crewFolder } from './models.mjs'

export const ACTIONS = ['accept', 'reject', 'ask', 'send']
const STATUS_OF = { accept: 'accepted', reject: 'rejected', ask: 'ask', send: 'accepted' }
const DEFAULT_PROJECT = 'nGen Own'
const URL = /https?:\/\/[^\s)\]>"']+|github\.com\/[\w.-]+\/[\w.-]+/g
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()
const line = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()

function readFile(file, empty) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return empty }
}
function writeFile(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`)
  fs.renameSync(tmp, file)
}

/** What was said about a finding before this change: kept so the page can tell the whole story. */
function pastOf(item) {
  const history = Array.isArray(item.history) ? [...item.history] : []
  if (item.decidedBy && item.decidedAt && ['accepted', 'rejected', 'ask'].includes(item.status) && !history.some((h) => h.at === item.decidedAt && h.by === item.decidedBy)) {
    history.push({ by: item.decidedBy, status: item.status, at: item.decidedAt, reason: line(item.reason) })
  }
  return history
}

function remember(folder, item) {
  const file = path.join(folder, 'improvements-rejected.json')
  const mem = readFile(file, {})
  const titles = Array.isArray(mem.titles) ? mem.titles : []
  const urls = Array.isArray(mem.urls) ? mem.urls : []
  const t = norm(item.title)
  if (t && !titles.includes(t)) titles.push(t)
  if (!String(item.title || '').startsWith('[')) {
    for (const u of new Set(`${item.title} ${item.path} ${item.evidence} ${item.fix}`.match(URL) || [])) if (!urls.includes(u)) urls.push(u)
  }
  writeFile(file, { ...mem, titles, urls })
}

/** The engine's project and the bot to hand a job to, found by name. */
async function projectNamed(name, options) {
  const projects = await call(`/companies/${await companyId(options)}/projects`, options)
  const wanted = norm(name)
  return projects.find((p) => norm(p.name) === wanted) || null
}
async function botNamed(name, options) {
  const bots = await crewOf(await companyId(options), options)
  return bots.find((b) => norm(b.name) === norm(name) || norm(b.name).startsWith(`${norm(name)} `)) || null
}

/**
 * Applies one owner decision. `engine` is the engine's options (a fake fetcher in tests); `now` is seconds.
 * Returns the finding as it now stands, plus the job made (`jobRef`), when one was.
 */
export async function decideImprovement(id, { action, reason = '' } = {}, { folder = crewFolder(), now = Math.floor(Date.now() / 1000), engine, add = addJob } = {}) {
  if (!ACTIONS.includes(action)) throw new EngineError(400, 'Choose accept, reject, ask or send')
  const why = line(reason).slice(0, 400)
  if (action === 'reject' && !why) throw new EngineError(400, 'Say in one line why you reject it')
  const file = path.join(folder, 'improvements.json')
  const items = readFile(file, null)
  const item = Array.isArray(items) ? items.find((i) => i && i.id === id) : null
  if (!item) throw new EngineError(404, 'No such finding')

  let jobRef = ''
  if (action === 'accept' || action === 'send') {
    const projectName = line(item.project) || DEFAULT_PROJECT
    const project = await projectNamed(projectName, engine)
    const plan = `Finding ${item.id}: ${item.title}\n\nWhere: ${item.path || 'not named'}\nEvidence: ${item.evidence || 'none given'}\nSmallest fix: ${item.fix || 'none given'}`
    const tony = action === 'send' ? await botNamed('Tony', engine) : null
    if (action === 'send' && !tony) throw new EngineError(409, 'Tony is not in this studio')
    const made = await add({
      title: `Improve: ${line(item.title).slice(0, 150)}`,
      description: action === 'send' ? `${plan}\n\nPlan this and start it.` : `${plan}\n\nBrief outline: ${item.fix || item.title}`,
      ...(project ? { projectId: project.id } : {}),
      ...(tony ? { botId: tony.id } : {}),
      priority: 'medium',
    }, engine)
    jobRef = made.ref
    item.job = made.ref
  }
  const history = pastOf(item)
  if (action === 'reject') remember(folder, item)
  item.history = history
  item.status = STATUS_OF[action]
  item.decidedBy = 'owner'
  item.decidedAt = now
  item.reason = why || (action === 'send' ? 'Sent to Tony.' : '')
  writeFile(file, items)
  return { ok: true, item: { id: item.id, status: item.status, decidedBy: item.decidedBy, decidedAt: item.decidedAt, reason: item.reason, job: item.job || '' }, jobRef }
}
