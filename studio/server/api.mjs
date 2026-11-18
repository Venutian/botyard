import { ConnectorError, addConnector, connectorList, finishSignIn, gateway, gatewayReach, loadTools, removeConnector, setAccess, settleHeld, startSignIn, writeBotConfigs } from './lib/connectors.mjs'
import { markCards, withCardState } from './lib/cards.mjs'
import { dataDir } from './lib/home.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { clearWork } from './lib/manager.mjs'
import { readFace, staleStudioView, studioView } from './lib/studio.mjs'
import { guardFolder, readGuard, writeGuard } from './lib/guard.mjs'
import { MAX_ATTACH_BYTES, EngineError, companyId, crewOf, acceptQuestion, addComment, addJob, addRoutine, editRoutine, agentModels, answerQuestion, attachmentFile, cancelJob, chatList, decideApproval, jobWorkspace, pauseRoutine, removeRoutine, reopenJob, resumeRoutine, routineList, runRoutine, chatThread, pauseBot, rejectQuestion, resumeBot, sendChat, settleConnectCard, stopJob, studioSummary, uploadAttachment, uploadChatPicture } from './lib/engine.mjs'
import { artifactList, documentRevisions, editJob, jobIdOf, jobList, jobPage, projectPage, saveGoal, restoreDocument, routinePage, saveDocument, saveSkillFile, setRoutineSchedule, skillFile, skillList } from './lib/work.mjs'
import { changeDetail } from './lib/changes.mjs'
import { readTimers } from './lib/library.mjs'
import { OWN_PATH, ownPagesRequest } from './lib/own-pages.mjs'
import { decideImprovement, leadOf } from './lib/improvement-actions.mjs'
import { crewFolder, readModels } from './lib/models.mjs'
import { activityPage, botList, botPage, improvementsView, instructionsDiff, moneyView, resetBotSession, restoreInstructions, rollbackBot, runDetail, runList, saveInstructions, tokenWindows } from './lib/crew.mjs'
import { openrouterLeft, usageRows } from './lib/usage.mjs'
import { readPlans } from './lib/plans.mjs'
import { syncGithub } from './lib/github-sync.mjs'
import { deviceView, devicesFile, readDevices, revokeDevice } from './lib/devices.mjs'
import { companySettings, inviteMember, revokeInvite } from './lib/company.mjs'
import { addBot, addProject, addStarterCrew, archiveProject, botSettings, firstRun, firstRunMark, helperAct, helperTimetable, moveProject, nameStudio, newBotChoices, removeBot, removeVariable, renameProject, saveBot, setVariable, setupAct, setupState } from './lib/shape.mjs'
import { fromOwnPage, ownHost, readBytes, readJson, sendJson } from './lib/page-guard.mjs'
import { savedStore } from './lib/saved.mjs'
import { pageBuild } from './lib/built-page.mjs'
import { crewFlow, dropFlow, needsList, withWeek } from './lib/flow.mjs'
import { reviewRecord, reviewSources, sendMarks } from './lib/marks.mjs'
import { dropItem, holdItem, readTray, sendTray, waitingQuestions } from './lib/tray.mjs'
import { guidedChange } from './lib/chapters.mjs'
import { tracksPage, tripAct, tripPage } from './lib/tracks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOTYARD_DATA || dataDir()
const STATE_FILE = path.join(DATA_DIR, 'map.json')
/** What only the owner can say about the first run: named, looked at, skipped, closed. */
const FIRST_RUN_FILE = path.join(DATA_DIR, 'first-run.json')

/** What the page keeps between visits: one document, the page's own to shape (lib/saved.mjs). */
const saved = savedStore(STATE_FILE)

/**
 * Every answer that failed, and every slow one, leaves a line in the service's log: without it a
 * page that showed an error left nothing behind to find the cause with.
 */
const QUIET = Boolean(process.env.NODE_TEST_CONTEXT)
const SLOW_MS = 3000
function note(res, status, body) {
  const req = res.req
  if (QUIET || !req) return
  const ms = req.startedAt ? Date.now() - req.startedAt : 0
  if (status < 400 && ms < SLOW_MS) return
  const why = status >= 400 ? `: ${String(body?.error || '').slice(0, 200)}` : ' (slow)'
  console.log(`[api] ${status} ${req.method} ${String(req.url).slice(0, 160)} ${ms}ms${why}`)
}

function send(res, status, body) {
  note(res, status, body)
  sendJson(res, status, body)
}

const readJsonBody = (req, limit) => readJson(req, limit)
/** An upload: past its size the answer says so in the words a person understands. */
const readRawBody = (req, limit) => readBytes(req, limit).catch((err) => { throw err.status === 413 ? new EngineError(413, 'Files are limited to 10 MB') : err })

/** An answer to a change the map itself shows: its own view is worked out again on the next poll. */
const changed = (res, status, body) => { staleStudioView(); return send(res, status, body) }

/** The cards the engine's summary lists, read through the flow's ten-second keep (lib/flow.mjs). */
const needsNow = () => needsList({ read: async () => (await studioSummary()).needsYou })

/** The request came over loopback — from this computer, not another device on the network. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const fromThisMachine = (req) => LOOPBACK.has(req.socket?.remoteAddress)

/**
 * The studio map, where the engine runs on this machine: the crew by project, and a word with any
 * bot of the crew. Everywhere else the first answer is `{ on: false }` and the page never asks again.
 *
 * Talking to a bot, pausing it and waking it are for the person at this machine.
 */
async function studioRoute(req, res, url) {
  const read = req.method === 'GET'
  try {
    // The map draws the yard's own crew and nothing else: the engine knows its own runs.
    if (url.pathname === '/api/studio' && read) return send(res, 200, await studioView())
    if (url.pathname === '/api/studio/chat' && read) return send(res, 200, await chatThread(url.searchParams.get('bot') || ''))
    if (url.pathname === '/api/studio/routines' && read) return send(res, 200, { routines: await routineList() })
    if (url.pathname === '/api/studio/tracks' && read) return send(res, 200, await tracksPage())
    if (url.pathname === '/api/studio/trip' && read) return send(res, 200, await tripPage(url.searchParams.get('id') || ''))
    if (url.pathname === '/api/studio/job' && read) return send(res, 200, await jobPage(url.searchParams.get('id') || ''))
    if (url.pathname === '/api/studio/chats' && read) return send(res, 200, { chats: await chatList() })
    if (url.pathname === '/api/studio/settings' && read) return send(res, 200, readGuard(guardFolder()))
    // What only the phone app could do before: the map is now the whole studio on this machine.
    // Kept ten seconds and worked out again as soon as a job, a comment or a card moves: it took about 340 ms.
    if (url.pathname === '/api/studio/needs' && read) return send(res, 200, { needs: withCardState(await needsNow()) })
    // The crew map: who tells whom, from the store (lib/flow.mjs).
    if (url.pathname === '/api/studio/flow' && read) return send(res, 200, await crewFlow({ window: url.searchParams.get('window') || '24h', needs: async () => withCardState(await needsNow()) }))
    if (url.pathname === '/api/studio/models' && read) return send(res, 200, await readModels({ folder: crewFolder(), agents: () => agentModels() }))
    if (url.pathname === '/api/studio/usage' && read) {
      // Every part may be missing (no crew scripts, no key, the engine slow): the list then shows less.
      const [plans, windows, models, openrouter] = await Promise.all([
        readPlans().catch(() => null),
        tokenWindows().catch(() => []),
        readModels({ folder: crewFolder(), agents: async () => [], detail: true }).catch(() => ({ free: [], subscriptions: { antigravityUsedUp: [] } })),
        openrouterLeft().catch(() => null),
      ])
      return send(res, 200, { at: Date.now(), providers: usageRows({ plans, windows, free: models.free, usedUp: models.subscriptions?.antigravityUsedUp || [], openrouter }) })
    }
    // The crew in full: bots, their runs, the activity timeline, and what it all used.
    const q = (name) => url.searchParams.get(name) || ''
    // The crew with its week from the flow: share of the Claude week and MET / NOT MET (lib/flow.mjs).
    if (url.pathname === '/api/studio/bots' && read) {
      const [list, week] = await Promise.all([botList(), crewFlow({ window: '7d', needs: async () => withCardState(await needsNow()) }).catch(() => null)])
      return send(res, 200, withWeek(list, week))
    }
    if (url.pathname === '/api/studio/bot' && read) return send(res, 200, await botPage(q('id')))
    if (url.pathname === '/api/studio/runs' && read) return send(res, 200, await runList({ bot: q('bot'), status: q('status'), page: Number(q('page')) || 0 }))
    if (url.pathname === '/api/studio/run' && read) return send(res, 200, await runDetail(q('id')))
    if (url.pathname === '/api/studio/activity' && read) return send(res, 200, await activityPage({ page: Number(q('page')) || 0, bot: q('bot') }))
    if (url.pathname === '/api/studio/spend' && read) return send(res, 200, await moneyView())
    if (url.pathname === '/api/studio/improvements' && read) return send(res, 200, improvementsView({ lead: (await leadOf().catch(() => null))?.name || '' }))
    // Shaping the studio: a bot's settings for its editor, what a new bot can be, the first run, setup, the helpers.
    if (url.pathname === '/api/studio/bot/settings' && read) return send(res, 200, await botSettings(q('id'), { connectors: connectorList({ crew: await connectorCrew().catch(() => []) }).connectors }))
    if (url.pathname === '/api/studio/bot/new' && read) return send(res, 200, await newBotChoices())
    if (url.pathname === '/api/studio/first-run' && read) return send(res, 200, await firstRun({ file: FIRST_RUN_FILE }))
    if (url.pathname === '/api/studio/setup-rows' && read) return send(res, 200, await setupState({ fresh: q('fresh') === '1' }))
    if (url.pathname === '/api/studio/helpers' && read) return send(res, 200, await helperTimetable())
    if (url.pathname === '/api/studio/instructions/diff' && read) return send(res, 200, await instructionsDiff(q('bot'), q('from'), q('to')))
    // Jobs and projects in full, routines and timers, and the library.
    if (url.pathname === '/api/studio/jobs' && read) return send(res, 200, await jobList({ pile: q('pile'), project: q('project'), bot: q('bot'), q: q('q'), page: Number(q('page')) || 0 }))
    if (url.pathname === '/api/studio/job/changes' && read) {
      const detail = await changeDetail((await jobWorkspace(await jobIdOf(q('id')))) ?? undefined)
      return detail ? send(res, 200, detail) : send(res, 404, { ok: false, error: 'This job has no branch to read' })
    }
    if (url.pathname === '/api/studio/job/document' && read) return send(res, 200, { revisions: await documentRevisions(q('id'), q('key')) })
    if (url.pathname === '/api/studio/file' && read) {
      const file = await attachmentFile(q('id'))
      res.writeHead(200, {
        'Content-Type': file.type, 'Content-Length': file.bytes.length, 'Cache-Control': 'max-age=300',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        ...(file.download ? { 'Content-Disposition': 'attachment' } : {}),
      })
      return res.end(file.bytes)
    }
    if (url.pathname === '/api/studio/project' && read) return send(res, 200, await projectPage(q('id')))
    if (url.pathname === '/api/studio/routine' && read) return send(res, 200, await routinePage(q('id')))
    if (url.pathname === '/api/studio/timers' && read) return send(res, 200, { timers: await readTimers() })
    if (url.pathname === '/api/studio/artifacts' && read) return send(res, 200, await artifactList({ cursor: q('cursor'), kind: q('kind') || 'all' }))
    if (url.pathname === '/api/studio/skills' && read) return send(res, 200, { skills: await skillList() })
    if (url.pathname === '/api/studio/skill/file' && read) return send(res, 200, await skillFile(q('id'), q('path')))
    if (url.pathname === '/api/studio/devices' && read) return send(res, 200, { devices: readDevices(devicesFile()).devices.map(deviceView) })
    if (url.pathname === '/api/studio/company' && read) return send(res, 200, await companySettings())
    if (url.pathname === '/api/studio/face' && read) {
      const face = await readFace(url.searchParams.get('name') || '')
      if (!face) return send(res, 404, { error: 'No picture of that bot' })
      res.writeHead(200, { 'Content-Type': face.type, 'Content-Length': face.data.length, 'Cache-Control': 'max-age=300' })
      return res.end(face.data)
    }
    // Reviews: what can be marked on a job or in a chat, and the kept record (lib/marks.mjs).
    if (url.pathname === '/api/studio/marks/sources' && read) return send(res, 200, await reviewSources({ job: q('job'), bot: q('bot') }))
    if (url.pathname === '/api/studio/marks' && read) return send(res, 200, await reviewRecord({ job: q('job'), project: q('project'), id: q('id') }))
    // A job's change in chapters, the heart first; overviews in plain words when asked (lib/chapters.mjs).
    if (url.pathname === '/api/studio/marks/change' && read) {
      const detail = await changeDetail((await jobWorkspace(await jobIdOf(q('job')))) ?? undefined)
      return detail ? send(res, 200, await guidedChange(detail, { overview: q('overview') === '1', folder: path.join(DATA_DIR, 'overviews') })) : send(res, 404, { error: 'This job has no branch to read' })
    }
    // The answer tray beside Needs you: answers held to send at once (lib/tray.mjs).
    if (url.pathname === '/api/studio/tray' && read) return send(res, 200, { items: readTray() })
    if (url.pathname === '/api/studio/tray/questions' && read) return send(res, 200, await waitingQuestions({ job: q('job'), bot: q('bot') }))
    if (read) return send(res, 404, { error: 'Unknown endpoint' })
    if (!fromThisMachine(req)) return send(res, 403, { ok: false, error: 'The crew only takes orders from the computer Botyard runs on' })
    // Every write below changes a job, a comment, a card or a bot: the kept flow and cards go with it.
    dropFlow()
    // A file for a job comes as its own bytes, named in the address.
    if (url.pathname === '/api/studio/attach' && req.method === 'POST') {
      const bytes = await readRawBody(req, MAX_ATTACH_BYTES)
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      return send(res, 201, await uploadAttachment(q('id'), { name: q('name'), type, bytes }))
    }
    // A picture for a chat message, put on the bot's conversation; the message then names it.
    if (url.pathname === '/api/studio/chat/picture' && req.method === 'POST') {
      const bytes = await readRawBody(req, MAX_ATTACH_BYTES)
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      return send(res, 201, await uploadChatPicture(q('bot'), { name: q('name'), type, bytes }))
    }
    // Instructions, documents and skill files can run to a few hundred kilobytes; everything else is a line or two.
    const big = ['/api/studio/marks', '/api/studio/tray', '/api/studio/instructions', '/api/studio/document', '/api/studio/skill', '/api/studio/job', '/api/studio/bot'].includes(url.pathname)
    const body = await readJsonBody(req, big ? 1024 * 1024 : 64 * 1024)
    // The owner's override of a finding: only the map's own page on this machine gets here (the guards above).
    const finding = url.pathname.match(/^\/api\/studio\/improvements\/(IMP-\d{1,6})$/)
    if (finding && req.method === 'POST') return send(res, 200, await decideImprovement(finding[1], { action: String(body.action || ''), reason: body.reason }))
    if (url.pathname === '/api/studio/trip' && req.method === 'POST') return changed(res, 200, await tripAct(String(body.id || ''), { action: String(body.action || ''), step: String(body.step || ''), to: String(body.to || ''), note: String(body.note || '') }))
    if (url.pathname === '/api/studio/chat' && req.method === 'POST') return send(res, 200, await sendChat(body.bot, body.text, randomUUID(), { pictures: body.pictures }))
    if (url.pathname === '/api/studio/job' && req.method === 'POST' && body.action === 'add') return send(res, 201, await addJob(body))
    // The owner's marks on a piece of a bot's work, sent as one message (lib/marks.mjs).
    if (url.pathname === '/api/studio/marks' && req.method === 'POST') return send(res, 201, await sendMarks(body))
    if (url.pathname === '/api/studio/tray' && req.method === 'POST') {
      if (body.action === 'hold') return send(res, 200, holdItem(body.item || {}))
      if (body.action === 'drop') return send(res, 200, dropItem(String(body.key || '')))
      if (body.action === 'send') return changed(res, 200, await sendTray({ keys: Array.isArray(body.keys) ? body.keys.map(String) : null, settle: (id, verb, extra) => settleHeld(id, verb, extra).catch(() => null) }))
    }
    if (url.pathname === '/api/studio/routine' && req.method === 'POST') {
      // Removing one asks for a confirm on the page first.
      const act = { run: runRoutine, pause: pauseRoutine, resume: resumeRoutine, remove: removeRoutine }[body.action]
      if (act) return send(res, 200, await act(String(body.id || '')))
      if (body.action === 'add') return send(res, 201, await addRoutine(body))
      if (body.action === 'schedule') return send(res, 200, await setRoutineSchedule(String(body.id || ''), body.plan ?? body.schedule, body.timezone))
      if (body.action === 'edit') return send(res, 200, await editRoutine(String(body.id || ''), body.changes || {}))
    }
    // A bot made, changed or removed; its variables by name. Removing one asks for a confirm on the page first.
    if (url.pathname === '/api/studio/bot' && req.method === 'POST') {
      const bot = String(body.bot || '')
      if (body.action === 'save') return changed(res, 200, await saveBot(bot, body.changes || {}))
      if (body.action === 'add') return changed(res, 201, await addBot(body.fields || {}))
      if (body.action === 'starter') return changed(res, 201, await addStarterCrew())
      if (body.action === 'remove') return changed(res, 200, await removeBot(bot))
      if (body.action === 'variable') return changed(res, 200, await setVariable(bot, body.name, body.value))
      if (body.action === 'variable-remove') return changed(res, 200, await removeVariable(bot, String(body.name || '')))
    }
    if (url.pathname === '/api/studio/project' && req.method === 'POST') {
      const id = String(body.id || '')
      if (body.action === 'add') return changed(res, 201, await addProject(body))
      if (body.action === 'rename') return changed(res, 200, await renameProject(id, body.name))
      if (body.action === 'move') return changed(res, 200, await moveProject(id, body.folder, { init: body.init === true }))
      if (body.action === 'archive' || body.action === 'restore') return changed(res, 200, await archiveProject(id, body.action === 'archive'))
    }
    // Repos of the owner's GitHub that look like projects: a dry list first, then the add.
    if (url.pathname === '/api/studio/github-sync' && req.method === 'POST') return changed(res, 200, await syncGithub({ add: body.action === 'add' }))
    if (url.pathname === '/api/studio/first-run' && req.method === 'POST') {
      if (body.action === 'name') { await nameStudio(body.name, { file: FIRST_RUN_FILE }); return changed(res, 200, await firstRun({ file: FIRST_RUN_FILE })) }
      return changed(res, 200, await firstRunMark(body, { file: FIRST_RUN_FILE }))
    }
    // A key pasted on the setup page goes straight on to the keys file; no answer carries it.
    if (url.pathname === '/api/studio/setup-rows' && req.method === 'POST') return send(res, 200, await setupAct(body))
    if (url.pathname === '/api/studio/helpers' && req.method === 'POST') return send(res, 200, await helperAct(body))
    if (url.pathname === '/api/studio/job' && req.method === 'POST' && body.action === 'edit') return send(res, 200, await editJob(String(body.id || ''), body.changes || {}))
    if (url.pathname === '/api/studio/document' && req.method === 'POST' && body.action === 'save') return send(res, 200, await saveDocument(String(body.id || ''), String(body.key || ''), { body: body.body, baseRevisionId: body.base ?? null }))
    if (url.pathname === '/api/studio/document' && req.method === 'POST' && body.action === 'restore') return send(res, 200, await restoreDocument(String(body.id || ''), String(body.key || ''), String(body.revision || '')))
    // Changing a skill's file asks for a confirm on the page first.
    if (url.pathname === '/api/studio/skill' && req.method === 'POST' && body.action === 'save') return send(res, 200, await saveSkillFile(String(body.id || ''), { path: body.path, content: body.content }))
    // A card a bot put in a conversation, answered where it is shown.
    if (url.pathname === '/api/studio/card' && req.method === 'POST') {
      if (body.verb === 'respond') return send(res, 200, await answerQuestion(body.chat, body.card, body.answers))
      // A card that held a bot's call on the owner's own account: the yes sends it, the no tells the bot.
      if (body.verb === 'accept') { const out = await acceptQuestion(body.chat, body.card); await settleHeld(body.card, 'accept').catch(() => null); return send(res, 200, out) }
      if (body.verb === 'reject') { const out = await rejectQuestion(body.chat, body.card, body.reason); await settleHeld(body.card, 'reject', { reason: body.reason || '' }).catch(() => null); return send(res, 200, out) }
      if (body.verb === 'connected' || body.verb === 'not-connected') return send(res, 200, await settleConnectCard(String(body.card || ''), { connected: body.verb === 'connected', service: body.service }))
    }
    if (url.pathname === '/api/studio/bot' && req.method === 'POST' && ['pause', 'resume'].includes(body.action)) {
      return send(res, 200, await (body.action === 'pause' ? pauseBot : resumeBot)(body.bot))
    }
    // The page asks for a confirm before each of these; the server takes the request as meant.
    if (url.pathname === '/api/studio/bot' && req.method === 'POST' && body.action === 'reset') return send(res, 200, await resetBotSession(String(body.bot || '')))
    if (url.pathname === '/api/studio/bot' && req.method === 'POST' && body.action === 'rollback') return send(res, 200, await rollbackBot(String(body.bot || ''), String(body.revision || '')))
    if (url.pathname === '/api/studio/instructions' && req.method === 'POST' && body.action === 'save') return send(res, 200, await saveInstructions(String(body.bot || ''), { content: body.content, baseRevisionId: body.base ?? null }))
    if (url.pathname === '/api/studio/instructions' && req.method === 'POST' && body.action === 'restore') return send(res, 200, await restoreInstructions(String(body.bot || ''), { revisionId: String(body.revision || ''), baseRevisionId: body.base ?? null }))
    const jobAct = { stop: stopJob, cancel: cancelJob, reopen: reopenJob }[body.action]
    if (url.pathname === '/api/studio/job' && req.method === 'POST' && jobAct) return send(res, 200, await jobAct(String(body.id || '')))
    if (url.pathname === '/api/studio/job' && req.method === 'POST' && body.action === 'comment') return send(res, 201, await addComment(String(body.id || ''), body.text))
    // The owner sorts the cards: read or archived, shared with the phone.
    // The owner's goal for a project, written where the lead reads it, and said to him in his chat.
    if (url.pathname === '/api/studio/project-goal' && req.method === 'POST') return send(res, 200, await saveGoal(String(body.id || ''), body, { tell: body.tell !== false }))
    if (url.pathname === '/api/studio/cards' && req.method === 'POST') {
      const flag = (v) => (typeof v === 'boolean' ? v : undefined)
      markCards(body.keys, { read: flag(body.read), archived: flag(body.archived) })
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/api/studio/approval' && req.method === 'POST' && ['approve', 'reject'].includes(body.decision)) {
      return send(res, 200, await decideApproval(String(body.id || ''), body.decision, body.note))
    }
    if (url.pathname === '/api/studio/invite' && req.method === 'POST') {
      if (body.action === 'add') return send(res, 201, await inviteMember({ role: body.role }))
      if (body.action === 'revoke') return send(res, 200, await revokeInvite(body.id))
    }
    if (url.pathname === '/api/studio/device' && req.method === 'POST' && body.action === 'revoke') {
      revokeDevice(devicesFile(), String(body.id || ''))
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/api/studio/job' && req.method === 'POST' && body.action === 'clear') {
      return send(res, 200, await clearWork(String(body.id || '')))
    }
    if (url.pathname === '/api/studio/settings' && req.method === 'POST') return send(res, 200, writeGuard(guardFolder(), body))
    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    if (!(err instanceof EngineError)) throw err
    // No engine here is the ordinary case, not a fault: the office is simply not a studio.
    // Only an engine that is not there says so: one that was slow or failed is still a studio.
    if (url.pathname === '/api/studio' && read && err.status === 503) return send(res, 200, { on: false })
    return send(res, err.status || 502, { ok: false, error: err.message, ...(err.canInit ? { canInit: true } : {}) })
  }
}

// ── connectors ──────────────────────────────────────────────────────────────────────

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
/** The small page the owner lands on when a service sends them back from its sign-in. */
const signedInPage = (ok, title, line) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f14;color:#eef0f4;font:16px/1.5 system-ui,sans-serif">
<main style="max-width:420px;padding:32px;text-align:center"><div style="font-size:44px;line-height:1;color:${ok ? '#6fdc8c' : '#ff8a7a'}">${ok ? '✓' : '!'}</div>
<h1 style="font-size:22px;margin:16px 0 8px">${esc(title)}</h1><p style="margin:0;color:#a9b0bd">${esc(line)}</p></main>
<script>try{window.opener&&window.opener.postMessage({studioConnector:${ok ? 'true' : 'false'}},'*')}catch(e){};${ok ? 'setTimeout(()=>window.close(),1800)' : ''}</script>`

/** The working bots, by id and name: who a connector can be given to. */
const connectorCrew = async () => (await crewOf(await companyId())).map((a) => ({ id: a.id, name: a.name }))

/**
 * Connectors and their gateway. True when the request was one of these.
 * The gateway is what a bot calls: `/api/mcp/<connector>/<the bot's pass>`.
 */
async function connectorRoute(req, res, url) {
  const hop = /^\/api\/mcp\/([a-z0-9-]+)\/([\w-]+)$/.exec(url.pathname)
  const mine = hop || url.pathname.startsWith('/api/studio/connect')
  if (!mine) return false
  try {
    if (hop) {
      const body = ['POST'].includes(req.method) ? (await readRawBody(req, 4 * 1024 * 1024)).toString('utf8') : ''
      const out = await gateway(hop[1], hop[2], { method: req.method, body, headers: req.headers })
      note(res, out.status, out.status >= 400 ? { error: 'gateway refused' } : null)
      res.writeHead(out.status, { 'Cache-Control': 'no-store', ...out.headers })
      res.end(out.body)
      return true
    }
    if (url.pathname === '/api/studio/connect/callback' && req.method === 'GET') {
      let page
      try {
        const done = await finishSignIn({ state: url.searchParams.get('state') || '', code: url.searchParams.get('code') || '', error: url.searchParams.get('error') || '' })
        page = signedInPage(true, `${done.name} is connected`, 'You can close this tab and go back to Botyard.')
      } catch (err) {
        page = signedInPage(false, 'Not connected', err.message || 'The sign-in did not finish.')
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(page)
      return true
    }
    if (url.pathname === '/api/studio/connectors' && req.method === 'GET') {
      const base = `http://127.0.0.1:${req.socket.localPort}`
      const reach = {}
      await Promise.all(connectorList().connectors.map(async (c) => { reach[c.id] = await gatewayReach(base, c.id) }))
      send(res, 200, connectorList({ crew: await connectorCrew().catch(() => []), reach }))
      return true
    }
    if (url.pathname === '/api/studio/connector' && req.method === 'POST') {
      if (!fromThisMachine(req)) { send(res, 403, { ok: false, error: 'Connectors are set up on the computer Botyard runs on' }); return true }
      const body = await readJsonBody(req, 64 * 1024)
      const crew = await connectorCrew().catch(() => [])
      const id = String(body.id || '')
      if (body.action === 'add') send(res, 201, await addConnector(body, { crew }))
      else if (body.action === 'signin') send(res, 200, await startSignIn(id, { redirectUri: `http://localhost:${req.socket.localPort}/api/studio/connect/callback` }))
      else if (body.action === 'access') send(res, 200, await setAccess(id, { bots: body.bots, writes: body.writes, owner: body.owner }, { crew }))
      else if (body.action === 'check') { await loadTools(id); send(res, 200, connectorList({ crew }).connectors.find((c) => c.id === id) || {}) }
      else if (body.action === 'remove') send(res, 200, await removeConnector(id, { crew }))
      else send(res, 400, { ok: false, error: 'Unknown action' })
      return true
    }
    send(res, 404, { error: 'Unknown endpoint' })
    return true
  } catch (err) {
    if (!(err instanceof ConnectorError) && !(err instanceof EngineError)) throw err
    send(res, err.status || 502, { ok: false, error: err.message })
    return true
  }
}

/** The page's API: answers a path under /api, and hands any other request to `next` (Vite's, or the page server). */
export async function apiMiddleware(req, res, next) {
  const { pathname } = new URL(req.url, 'http://x')
  const url = { pathname, searchParams: new URL(req.url, 'http://x').searchParams }
  if (pathname.slice(0, 5) !== '/api/') return next ? next() : send(res, 404, { error: 'Nothing is here' })
  req.startedAt = Date.now()

  // A bot's call to a connector carries no Origin (it is not a page); its pass is what lets it in,
  // and it must still name this computer, so a tunnel's name or a rebound name is refused.
  const hop = /^\/api\/mcp\/[a-z0-9-]+\/[\w-]+$/.test(pathname)
  if (hop) {
    if (!ownHost(req)) return send(res, 403, { error: 'The connector gateway answers this computer only' })
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'Use POST' })
    try { if (await connectorRoute(req, res, url)) return } catch (err) { return send(res, err?.status >= 400 && err.status < 500 ? err.status : 500, { error: String(err?.message || err) }) }
  } else if (!fromOwnPage(req)) {
    return send(res, 403, { error: 'Botyard only answers its own page on this machine' })
  }

  try {
    // A page of the owner's own, from the home folder (lib/own-pages.mjs): its files and its own calls.
    if (url.pathname === OWN_PATH || url.pathname.startsWith(`${OWN_PATH}/`)) {
      const runHelper = async (name) => {
        const { timetableAct } = await import('./lib/timetable.mjs')
        return timetableAct({ action: 'run', name: String(name) })[0] === 200
      }
      return await ownPagesRequest(req, res, url, { demo: process.env.BOTYARD_DEMO === '1', runHelper })
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { service: 'botyard', workspace: path.resolve(here, '..'), page: pageBuild(path.resolve(here, '..', 'dist')) })
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, saved.read())
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const out = await saved.save(await readJsonBody(req))
      return send(res, out.status, out.body)
    }

    if (await connectorRoute(req, res, url)) return
    if (url.pathname.startsWith('/api/studio')) return await studioRoute(req, res, url)

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    // What a caller got wrong says so with its own status; anything else is a fault here.
    return send(res, err?.status >= 400 && err.status < 500 ? err.status : 500, { error: String(err?.message || err) })
  }
}
