/**
 * The phone door: a second, separate server for the Botyard app.
 *
 * The office API answers only its own page on this machine and that does not change. This door
 * is what may be reachable from another device, so it holds a short list of named actions and
 * nothing else: there is no way through it to a path, a command, a thread or the engine's own API.
 *
 * It refuses to start without BOTYARD_PHONE_TOKEN, and it refuses any request that carries an
 * Origin header, because the app sends none and every browser does. That closes the door on a web
 * page reaching it from a browser on the same network, whatever token that page might guess.
 */
import { markCards, readCards, withCardState } from './lib/cards.mjs'
import http from 'node:http'
import { sendJson } from './lib/page-guard.mjs'
import { dataDir } from './lib/home.mjs'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { awayFile, noteArrival, readAway } from './lib/away.mjs'
import { changeCounts, changeDetail } from './lib/changes.mjs'
import { cameThroughEdge, edgeFile, readEdge, signPlay } from './lib/edge.mjs'
import { addDevice, deviceView, devicesFile, findDevice, readDevices, retireShared, revokeDevice, touchDevice } from './lib/devices.mjs'
import { guardFolder, readGuard, writeGuard } from './lib/guard.mjs'
import { companySettings } from './lib/company.mjs'
import { crewFaces, readFace } from './lib/studio.mjs'
import { ConnectorError, connectorList, loadTools, setAccess, settleHeld } from './lib/connectors.mjs'
import { decideImprovement, leadOf } from './lib/improvement-actions.mjs'
import { activityPage, botList, botPage, improvementsView, instructionsOf, moneyView, restoreInstructions, runDetail, runList, saveInstructions } from './lib/crew.mjs'
import { throttleAct, throttleState } from './lib/throttle.mjs'
import { tracksPage, tripAct, tripPage } from './lib/tracks.mjs'
import { launchView, startRelease, tellState } from './lib/launch.mjs'
import { botBehind } from './engine/caller.mjs'
import { addBot, addProject, addStarterCrew, archiveProject, botSettings, firstRun, firstRunMark, helperAct, helperTimetable, moveProject, nameStudio, newBotChoices, removeBot, removeVariable, renameProject, saveBot, setVariable, setupAct, setupState } from './lib/shape.mjs'
import { readTimers } from './lib/library.mjs'
import { crewFlow } from './lib/flow.mjs'
import { managerSummary } from './lib/manager.mjs'
import { crewFolder, readModels } from './lib/models.mjs'
import { readPlans } from './lib/plans.mjs'
import {
  EngineError, acceptQuestion, addComment, addJob, addRoutine, editRoutine, agentModels, answerQuestion, cancelJob, chatList, chatThread, decideApproval,
  jobDetail, jobWorkspace, pauseBot, pauseRoutine, proofImage, rejectQuestion, removeRoutine, reopenJob, resumeBot, resumeRoutine,
  routineList, runRoutine, sendChat, settleConnectCard, stopJob, studioSummary, companyId, crewOf,
  MAX_ATTACH_BYTES, PROOF_TYPES, uploadChatPicture,
} from './lib/engine.mjs'
import { PREVIEW_PORT, listPreviews, previewRoot, startPreviews } from './lib/previews.mjs'
import { artifactList, documentRevisions, jobList, jobPage, projectPage, restoreDocument, routinePage, saveGoal, setRoutineSchedule } from './lib/work.mjs'
import { liveSessions as readLiveSessions } from './lib/sessions.mjs'
import { OWN_PATH, ownPagesRequest } from './lib/own-pages.mjs'
import { reviewRecord, reviewSources, sendMarks } from './lib/marks.mjs'
import { dropItem, holdItem, readTray, sendTray, waitingQuestions } from './lib/tray.mjs'
import { brainRoute } from './lib/brain.mjs'

const MIN_TOKEN = 32
const MAX_BODY = 16 * 1024
/** A bot's instructions are a long text: the two paths that carry one take this much. */
const MAX_LONG_BODY = 512 * 1024
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const SHOWN_SESSIONS = 12
const JOB_ACTIONS = { stop: stopJob, cancel: cancelJob, reopen: reopenJob }
const BOT_ACTIONS = { pause: pauseBot, resume: resumeBot }
const ROUTINE_ACTIONS = { run: runRoutine, pause: pauseRoutine, resume: resumeRoutine, remove: removeRoutine }
const SEEN_EVERY_MS = 60 * 1000
const SESSIONS_TTL_MS = 60 * 1000
const SESSIONS_WAIT_MS = 700
const MANAGER_FRESH_MS = 4_000
/** What a phone screen shows of a long text: a job's document. */
const PHONE_DOC_CHARS = 12_000
const SHOWN_BOT_REVISIONS = 5

const digest = (value) => createHash('sha256').update(String(value)).digest()
const waitUpTo = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function tokenMatches(header, token) {
  const given = /^Bearer (.+)$/.exec(header || '')?.[1]
  return Boolean(given) && timingSafeEqual(digest(given), digest(token))
}

const send = sendJson

function sendImage(res, { type, bytes }) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

/** The address the app reached this PC on, so links it gets back work from wherever it is. */
const hostOf = (req) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  return /^[\w.-]+$/.test(host) ? host : '127.0.0.1'
}

/** Build links for an app that came through Cloudflare: signed, on the play address. */
const playLink = (cloud) => (cloud ? (key) => `https://${cloud.play}/open/${key}?g=${signPlay(cloud.gate, key)}` : undefined)

/** A file's own bytes, as the app sends a picture: no JSON around it. */
async function readBytes(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new EngineError(413, 'Pictures are limited to 10 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new EngineError(413, 'That is too long')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new EngineError(400, 'That was not JSON')
  }
}

/** The coding sessions live on this computer right now, including those the engine did not start. */
const liveSessions = async () => (await readLiveSessions({ limit: SHOWN_SESSIONS })).map(({ title, harness, project }) => ({ title, harness, project }))

const clip = (text, max) => {
  const s = String(text ?? '')
  return s.length > max ? { text: s.slice(0, max), trimmed: true } : { text: s, trimmed: false }
}

/** The crew list for a phone: state, engine and why, tokens, and the waste flag, without the org chart. */
const phoneBots = ({ bots, wasteAt, wasteStale, at }) => ({
  bots: bots.map((b) => ({
    id: b.id, name: b.name, title: b.title, status: b.status, state: b.state, resting: Boolean(b.resting),
    engine: b.engine, model: b.model, why: b.why, tokensToday: b.tokensToday, tokensWeek: b.tokensWeek,
    waste: b.waste ? { runs: b.waste.runs, wasted: b.waste.wasted, share: b.waste.share, flagged: b.waste.flagged, causes: b.waste.causes } : null,
  })),
  wasteAt, wasteStale, at,
})

/** One bot for a phone: its page without the instructions' text (up to 200 KB) and with its last few settings changes. */
const phoneBot = ({ instructions, revisions, ...page }) => ({
  ...page,
  revisions: revisions.slice(0, SHOWN_BOT_REVISIONS),
  instructions: instructions ? { file: instructions.file, managed: Boolean(instructions.managed) } : null,
})

/** What a job's page adds on a phone: what it hangs off and waits on, its documents (cut short), files, runs and cost. */
const phoneJobMore = (page) => ({
  parent: page.parent, children: page.children, blockedBy: page.blockedBy, blocks: page.blocks,
  documents: page.documents.map(({ key, title, body, trimmed, revision, by, at }) => {
    const cut = clip(body, PHONE_DOC_CHARS)
    return { key, title, body: cut.text, trimmed: trimmed || cut.trimmed, revision, by, at }
  }),
  files: page.files.map(({ id, name, kind, size }) => ({ id, name, kind, size })),
  products: page.products.filter((w) => w.url).map(({ id, title, url, summary }) => ({ id, title, url, summary })),
  runs: page.runs,
  cost: page.cost,
})

/** Projects in the owner's ranking: named ones first in that order, the rest after in their own (as the map's rank.js). */
function rankProjects(projects, ranked) {
  const at = new Map(ranked.map((name, i) => [name, i]))
  return projects
    .map((p, i) => ({ p, i, r: at.has(p.name) ? at.get(p.name) : ranked.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p)
}

/** The company for a phone, read only: who is in it and the open invites. No email addresses, secrets or switches. */
const phoneCompany = ({ name, about, code, members, invites }) => ({
  name, about, code,
  members: members.map(({ id, name: who, role, active, since }) => ({ id, name: who, role, active, since })),
  invites: invites.map(({ id, role, expires }) => ({ id, role, expires })),
})

export function phoneHandler({ token, faces = {}, connectors = {}, engine = {}, sessions = liveSessions, previews = previewRoot(), previewPort = PREVIEW_PORT, devices = devicesFile(), guard = guardFolder(), firstRunFile = path.join(process.env.BOTYARD_DATA || dataDir(), 'first-run.json'), shape = {}, away = awayFile(), edge = edgeFile(), port = 5288, crew = crewFolder(), plans = readPlans, timers = readTimers, throttle = {} }) {
  const failures = new Map()
  const seen = new Map()
  // Read and archived marks are added as each answer goes out, so a mark shows at once though the
  // summary itself is cached.
  const cards = path.join(guard, 'cards.json')
  const sorted = (view) => (view && Array.isArray(view.needsYou) ? { ...view, needsYou: withCardState(view.needsYou, readCards(cards)) } : view)
  const options = engine.fetcher ? { fetcher: engine.fetcher } : undefined

  // The office-wide thread scan walks every transcript on this PC, and here that is hundreds of
  // files: over 18 seconds on 10 November. The phone's first screen only needs the dozen sessions
  // that are running, so the door keeps the last answer and refreshes it behind the request. No
  // /v1/ answer ever waits for the scan.
  const scans = { at: 0, list: null, running: null }
  const scanSessions = () => {
    if (scans.running) return scans.running
    scans.running = Promise.resolve()
      .then(() => sessions())
      .then((list) => {
        scans.at = Date.now()
        scans.list = list
      })
      .catch(() => undefined)
      .finally(() => {
        scans.running = null
      })
    return scans.running
  }
  const recentSessions = async () => {
    const current = scans.list && Date.now() - scans.at < SESSIONS_TTL_MS
    const running = current ? null : scanSessions()
    if (scans.list) return scans.list
    if (running) await Promise.race([running, waitUpTo(SESSIONS_WAIT_MS)])
    return scans.list || []
  }
  // Warm it, so the first summary after a door restart does not go without the list.
  scanSessions()

  // The summary and the chat list are the phone's first screen. The engine can take a second or
  // more to answer them, so the door keeps the last answer and serves it at once, refreshing it
  // behind the request. The last good answer is never thrown away, and a door that has no answer
  // yet waits for the engine rather than sending an empty studio.
  const summaryCache = { at: 0, value: null, error: null, running: null }
  const chatsCache = { at: 0, value: null, error: null, running: null }
  const managerCache = { at: 0, value: null, error: null, running: null }

  const buildSummary = async (options) => {
    const [summary, live, plans] = await Promise.all([studioSummary(options), recentSessions(), readPlans()])
    const limits = readGuard(guard)
    const tunnel = readAway(away)
    const notices = [
      ...(limits.tripped ? [{ kind: 'blocked', id: '', title: 'Claude bots are paused', detail: 'The token guard stopped them at your limit. Raise it or turn it off in Botyard.' }] : []),
      ...(tunnel?.changed ? [{ kind: 'blocked', id: '', title: 'Your home internet address changed', detail: `Away access needs it. In the WireGuard app, edit this studio's tunnel and set Endpoint to ${tunnel.endpoint}:${tunnel.port}.` }] : []),
    ]
    const next = { ...summary, needsYou: [...notices, ...summary.needsYou], sessions: live, guard: limits, plans }
    return next
  }

  /**
   * Builds the phone's first screen and keeps the last good answer. A build that fails keeps that
   * answer and says what went wrong, so the phone can tell "nothing is happening" from "the engine
   * is down" instead of being shown an empty studio.
   */
  const refreshSummary = (options) => {
    if (summaryCache.running) return summaryCache.running
    summaryCache.running = buildSummary(options)
      .then((next) => {
        summaryCache.value = next
        summaryCache.at = Date.now()
        summaryCache.error = null
        return next
      })
      .catch((err) => {
        summaryCache.error = err?.message || 'The crew\'s engine is not running on this computer'
        throw err
      })
      .finally(() => { summaryCache.running = null })
    return summaryCache.running
  }

  const refreshChats = (options) => {
    if (chatsCache.running) return chatsCache.running
    chatsCache.running = chatList(options)
      .then((bots) => {
        chatsCache.value = { bots }
        chatsCache.at = Date.now()
        chatsCache.error = null
        return chatsCache.value
      })
      .catch((err) => {
        chatsCache.error = err?.message || 'The crew\'s engine is not running on this computer'
        throw err
      })
      .finally(() => { chatsCache.running = null })
    return chatsCache.running
  }

  /**
   * The summary, at once when the door has an answer, and after the engine answers when it has
   * not: an empty studio is worse than a slow one. A door with no answer yet and an engine that
   * is down answers with the error, as the door always did.
   */
  const summarySoon = async (options) => {
    const seen = summaryCache
    if (seen.value) {
      refreshSummary(options).catch(() => undefined)
      return seen.error ? { ...seen.value, error: seen.error } : seen.value
    }
    return refreshSummary(options)
  }

  /**
   * The manager's view (who is on what, where each piece of work stands, what happened today),
   * kept the same way. Both the phone's Home and the 3D map ask for it every few seconds, so an
   * answer younger than MANAGER_FRESH_MS is not rebuilt.
   */
  const refreshManager = (options) => {
    if (managerCache.running) return managerCache.running
    managerCache.running = Promise.all([managerSummary({ folder: crew, ...options }), summarySoon(options).catch(() => null)])
      .then(([manager, summary]) => {
        managerCache.value = { ...manager, needsYou: summary?.needsYou || [] }
        managerCache.at = Date.now()
        managerCache.error = null
        return managerCache.value
      })
      .catch((err) => {
        managerCache.error = err?.message || 'The crew\'s engine is not running on this computer'
        throw err
      })
      .finally(() => { managerCache.running = null })
    return managerCache.running
  }
  const managerSoon = async (options) => {
    const seen = managerCache
    if (!seen.value) return refreshManager(options)
    if (Date.now() - seen.at > MANAGER_FRESH_MS) refreshManager(options).catch(() => undefined)
    return seen.error ? { ...seen.value, error: seen.error } : seen.value
  }

  /** The chat list, the same way: at once when there is one, the error when there is not. */
  const chatsSoon = async (options) => {
    const seen = chatsCache
    if (seen.value) {
      refreshChats(options).catch(() => undefined)
      return seen.error ? { ...seen.value, error: seen.error } : seen.value
    }
    return refreshChats(options)
  }

  // Warm the phone's first screen, the way the session scan is warmed, so the first request after
  // a restart is answered from cache instead of waiting for the engine.
  const warmed = Promise.all([
    refreshSummary(options).catch(() => undefined),
    refreshChats(options).catch(() => undefined),
  ])

  const lockedOut = (ip) => {
    const entry = failures.get(ip)
    if (!entry) return false
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
      failures.delete(ip)
      return false
    }
    return entry.count >= MAX_FAILURES
  }
  const failed = (ip) => {
    const entry = failures.get(ip) || { count: 0, since: Date.now() }
    entry.count += 1
    failures.set(ip, entry)
  }

  const handler = async (req, res) => {
    // Through Cloudflare every request comes from this PC's tunnel, so wrong keys count against the
    // phone's own address, which the Worker passes on.
    const viaEdge = cameThroughEdge(req)
    const ip = viaEdge ? `edge:${String(req.headers['x-botyard-client'] || '')}` : req.socket?.remoteAddress || ''
    if (req.headers.origin) return send(res, 403, { error: 'The phone door does not answer web pages' })
    if (lockedOut(ip)) return send(res, 429, { error: 'Too many wrong tokens. Try again later' })
    const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    const device = key ? findDevice(devices, key) : null
    if (!device && (readDevices(devices).sharedRetired || !tokenMatches(req.headers.authorization, token))) {
      failed(ip)
      return send(res, 401, { error: 'Wrong or missing token' })
    }
    failures.delete(ip)
    if (device && Date.now() - (seen.get(device.id) || 0) > SEEN_EVERY_MS) {
      seen.set(device.id, Date.now())
      touchDevice(devices, device.id)
    }
    try {
      noteArrival(away, ip)
    } catch (err) {
      console.error('Could not note a visit through the tunnel:', err.message)
    }

    const { pathname, searchParams } = new URL(req.url, 'http://phone')
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(pathname)
    const comment = /^\/v1\/jobs\/([^/]+)\/comments$/.exec(pathname)
    const changes = /^\/v1\/jobs\/([^/]+)\/changes$/.exec(pathname)
    const proof = /^\/v1\/proof\/([^/]+)$/.exec(pathname)
    const face = /^\/v1\/faces\/([\w.-]+)$/.exec(pathname)
    const jobAction = /^\/v1\/jobs\/([^/]+)\/(stop|cancel|reopen)$/.exec(pathname)
    const question = /^\/v1\/jobs\/([^/]+)\/questions\/([^/]+)\/(respond|accept|reject)$/.exec(pathname)
    const routineAction = /^\/v1\/routines\/([^/]+)\/(run|pause|resume|remove)$/.exec(pathname)
    const trip = /^\/v1\/trips\/([^/]+)$/.exec(pathname)
    const tripDo = /^\/v1\/trips\/([^/]+)\/(approve|back|context|rerun|pause|resume|stop)$/.exec(pathname)
    const connectorAct = /^\/v1\/connectors\/([a-z0-9-]+)\/(access|check)$/.exec(pathname)
    const connectCard = /^\/v1\/connect-cards\/([^/]+)$/.exec(pathname)
    const deviceRevoke = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(pathname)
    const botAction = /^\/v1\/bots\/([^/]+)\/(pause|resume)$/.exec(pathname)
    const decision = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname)
    const chat = /^\/v1\/chats\/([^/]+)$/.exec(pathname)
    const chatMessage = /^\/v1\/chats\/([^/]+)\/messages$/.exec(pathname)
    const chatPicture = /^\/v1\/chats\/([^/]+)\/pictures$/.exec(pathname)
    const jobMore = /^\/v1\/jobs\/([^/]+)\/more$/.exec(pathname)
    const bot = /^\/v1\/bots\/([^/]+)$/.exec(pathname)
    const run = /^\/v1\/runs\/([^/]+)$/.exec(pathname)
    const project = /^\/v1\/projects\/([^/]+)$/.exec(pathname)
    const q = (name) => searchParams.get(name) || ''
    const page = () => Math.max(0, Math.floor(Number(q('page')) || 0))
    try {
      // The app knocks here on each address it knows, and keeps the one that answers first.
      if (pathname === '/v1/hello' && req.method === 'GET') {
        const tunnel = readAway(away)
        const cloud = readEdge(edge)
        return send(res, 200, {
          away: tunnel ? `${tunnel.address}:${port}` : null,
          edge: cloud ? { host: `https://${cloud.studio}`, gate: cloud.gate } : null,
        })
      }
      // ── shaping the studio: the crew editor, setup, the first run, projects, routines, documents ──
      const get = req.method === 'GET'
      const post = req.method === 'POST'
      const botPart = /^\/v1\/bots\/([^/]+)\/(settings|remove|variables|variables\/remove|instructions|instructions\/restore)$/.exec(pathname)
      const projectAct = /^\/v1\/projects\/([^/]+)\/(rename|move|archive|restore)$/.exec(pathname)
      const routinePart = /^\/v1\/routines\/([^/]+)\/(schedule|edit)$/.exec(pathname)
      const routineOne = /^\/v1\/routines\/([^/]+)$/.exec(pathname)
      const docPart = /^\/v1\/jobs\/([^/]+)\/documents\/([^/]+)\/(revisions|restore)$/.exec(pathname)
      const shaping = { ...options, ...shape }
      const first = { file: firstRunFile, devices, ...shaping }
      if (pathname === '/v1/bots/new' && get) return send(res, 200, await newBotChoices(shaping))
      if (pathname === '/v1/bots' && post) return send(res, 201, await addBot(await readBody(req, MAX_LONG_BODY), shaping))
      if (pathname === '/v1/bots/starter' && post) return send(res, 201, await addStarterCrew(shaping))
      if (botPart) {
        const [, id, what] = botPart
        if (what === 'settings' && get) {
          const crew = connectors.crew ?? (await crewOf(await companyId(options), options)).map((a) => ({ id: a.id, name: a.name }))
          return send(res, 200, await botSettings(id, { connectors: connectorList({ crew, ...connectors.options }).connectors, ...shaping }))
        }
        if (what === 'instructions' && get) return send(res, 200, (await instructionsOf(id, options)) || { file: '', managed: false, content: '', revisionId: null, history: [] })
        if (post) {
          const body = await readBody(req, what === 'instructions' ? MAX_LONG_BODY : MAX_BODY)
          if (what === 'settings') return send(res, 200, await saveBot(id, body, shaping))
          if (what === 'remove') return send(res, 200, await removeBot(id, shaping))
          // A variable's value goes straight on to the engine; no answer carries it.
          if (what === 'variables') return send(res, 200, await setVariable(id, body.name, body.value, shaping))
          if (what === 'variables/remove') return send(res, 200, await removeVariable(id, String(body.name || ''), shaping))
          if (what === 'instructions') return send(res, 200, await saveInstructions(id, { content: body.content, baseRevisionId: body.base ?? null }, options))
          if (what === 'instructions/restore') return send(res, 200, await restoreInstructions(id, { revisionId: String(body.revision || ''), baseRevisionId: body.base ?? null }, options))
        }
      }
      // A sign-in opens on the computer Botyard runs on, so the phone is shown the line to run there; a key can be pasted from here.
      if (pathname === '/v1/setup' && get) return send(res, 200, await setupState({ fresh: searchParams.get('fresh') === '1', remote: true }))
      if (pathname === '/v1/setup' && post) return send(res, 200, await setupAct(await readBody(req), { remote: true }))
      if (pathname === '/v1/helpers' && get) return send(res, 200, await helperTimetable())
      // The PC load, as the owner: the phone's key is the owner's, and the change is logged as made from the phone.
      if (pathname === '/v1/throttle' && process.env.BOTYARD_REFUSE_BOTS !== 'off' && botBehind(req)) return send(res, 403, { error: 'This is the owner\'s, not a bot\'s' })
      if (pathname === '/v1/throttle' && get) return send(res, 200, await throttleState(throttle))
      if (pathname === '/v1/throttle' && post) {
        const [status, body] = await throttleAct(await readBody(req), { ...throttle, setBy: 'owner (phone)' })
        return send(res, status, body)
      }
      if (pathname === '/v1/helpers' && post) return send(res, 200, await helperAct(await readBody(req)))
      if (pathname === '/v1/first-run' && get) return send(res, 200, await firstRun(first))
      if (pathname === '/v1/first-run' && post) {
        const body = await readBody(req)
        if (body.action === 'name') { await nameStudio(body.name, first); return send(res, 200, await firstRun(first)) }
        return send(res, 200, await firstRunMark(body, first))
      }
      if (pathname === '/v1/projects' && post) return send(res, 201, await addProject(await readBody(req), shaping))
      if (projectAct && post) {
        const body = await readBody(req)
        if (projectAct[2] === 'rename') return send(res, 200, await renameProject(projectAct[1], body.name, shaping))
        if (projectAct[2] === 'move') return send(res, 200, await moveProject(projectAct[1], body.folder, { init: body.init === true, ...shaping }))
        return send(res, 200, await archiveProject(projectAct[1], projectAct[2] === 'archive', shaping))
      }
      if (routinePart && post) {
        const body = await readBody(req)
        if (routinePart[2] === 'schedule') return send(res, 200, await setRoutineSchedule(routinePart[1], body.plan ?? body.schedule, body.timezone ?? null, options))
        return send(res, 200, await editRoutine(routinePart[1], body, options))
      }
      if (routineOne && get) return send(res, 200, await routinePage(routineOne[1], options))
      if (docPart && docPart[3] === 'revisions' && get) return send(res, 200, { revisions: await documentRevisions(docPart[1], decodeURIComponent(docPart[2]), options) })
      if (docPart && docPart[3] === 'restore' && post) return send(res, 200, await restoreDocument(docPart[1], decodeURIComponent(docPart[2]), String((await readBody(req)).revision || ''), options))
      if (pathname === '/v1/summary' && req.method === 'GET') return send(res, 200, sorted(await summarySoon(options)))
      // The crew map's tree for the phone: who leads, who answers to whom, and the lines between them. The same
      // Needs-you list as the summary, so the owner node's number is the badge's.
      if (pathname === '/v1/flow' && req.method === 'GET') return send(res, 200, await crewFlow({ window: ['now', '24h', '7d'].includes(q('window')) ? q('window') : '24h', needs: async () => sorted({ needsYou: (await summarySoon(options)).needsYou }).needsYou, ...options }))
      if (pathname === '/v1/manager' && req.method === 'GET') return send(res, 200, sorted(await managerSoon(options)))
      // The owner's goal for a project, from the phone: written where the lead reads it, and said to him.
      const goal = /^\/v1\/projects\/([^/]+)\/goal$/.exec(pathname)
      if (goal && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await saveGoal(goal[1], body, { tell: body.tell !== false, ...options }))
      }
      if (pathname === '/v1/cards' && req.method === 'POST') {
        const body = await readBody(req)
        const flag = (v) => (typeof v === 'boolean' ? v : undefined)
        markCards(body.keys, { read: flag(body.read), archived: flag(body.archived) }, { file: cards })
        return send(res, 200, { ok: true })
      }
      if (pathname === '/v1/jobs' && req.method === 'POST') {
        return send(res, 201, await addJob(await readBody(req), options))
      }
      if (job && req.method === 'GET') {
        const [detail, workspace, builds] = await Promise.all([
          jobDetail(job[1], options),
          jobWorkspace(job[1], options),
          listPreviews(job[1], { root: previews, host: hostOf(req), port: previewPort, link: viaEdge ? playLink(readEdge(edge)) : undefined }),
        ])
        return send(res, 200, { ...detail, changes: await changeCounts(workspace ?? undefined), previews: builds })
      }
      if (changes && req.method === 'GET') {
        const detail = await changeDetail((await jobWorkspace(changes[1], options)) ?? undefined)
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'This job has no branch to read' })
      }
      if (proof && req.method === 'GET') return sendImage(res, await proofImage(proof[1], options))
      // The bots' portraits in the home folder's faces folder: the same pictures the map shows.
      if (pathname === '/v1/faces' && req.method === 'GET') {
        const bots = (await crewOf(await companyId(options), options)).map((a) => ({ id: a.id, name: a.name }))
        const found = await crewFaces(bots, faces)
        return send(res, 200, { faces: Object.fromEntries(Object.entries(found).map(([id, url]) => [id, new URL(url, 'http://x').searchParams.get('name')])) })
      }
      if (face && req.method === 'GET') {
        const picture = await readFace(face[1], faces)
        if (!picture) return send(res, 404, { error: 'No such picture' })
        return sendImage(res, { type: picture.type, bytes: picture.data })
      }
      if (comment && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 201, await addComment(comment[1], body.text, options))
      }
      if (pathname === '/v1/routines' && req.method === 'GET') return send(res, 200, { routines: await routineList(options) })
      // Tracks: the requests and their trips; the owner answers a gate or sends work back from the phone as from the page.
      if (pathname === '/v1/tracks' && req.method === 'GET') return send(res, 200, await tracksPage(options))
      // Launch: the same board as the page; the owner may ask for a fresh check or say where an unreadable channel stands.
      if (pathname === '/v1/launch' && req.method === 'GET') return send(res, 200, await launchView())
      if (pathname === '/v1/launch' && req.method === 'POST') {
        const b = await readBody(req)
        if (b.action === 'release') await startRelease(String(b.product || ''), options)
        if (b.action === 'tell') tellState({ product: String(b.product || ''), channel: String(b.channel || ''), state: String(b.state || ''), tone: String(b.tone || ''), next: String(b.next || '') })
        return send(res, 200, await launchView({ force: b.action === 'check' }))
      }
      if (trip && req.method === 'GET') return send(res, 200, await tripPage(decodeURIComponent(trip[1]), options))
      if (tripDo && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await tripAct(decodeURIComponent(tripDo[1]), { action: tripDo[2], step: String(b.step || ''), to: String(b.to || ''), note: String(b.note || '') }, options)) }
      if (pathname === '/v1/routines' && req.method === 'POST') return send(res, 201, await addRoutine(await readBody(req), options))
      if (routineAction && req.method === 'POST') return send(res, 200, await ROUTINE_ACTIONS[routineAction[2]](routineAction[1], options))
      if (pathname === '/v1/guard' && req.method === 'POST') return send(res, 200, writeGuard(guard, await readBody(req)))
      if (pathname === '/v1/devices' && req.method === 'GET') {
        const state = readDevices(devices)
        const tunnel = readAway(away)
        return send(res, 200, {
          sharedActive: !state.sharedRetired,
          current: device?.id || null,
          devices: state.devices.map(deviceView),
          away: tunnel && { address: tunnel.address, up: tunnel.up, changed: tunnel.changed },
        })
      }
      if (pathname === '/v1/devices' && req.method === 'POST') return send(res, 201, addDevice(devices, (await readBody(req)).name))
      if (pathname === '/v1/devices/retire-shared' && req.method === 'POST') {
        if (!device) return send(res, 409, { error: 'Update this device to its own key first' })
        retireShared(devices)
        return send(res, 200, { ok: true })
      }
      if (deviceRevoke && req.method === 'POST') {
        if (device?.id === deviceRevoke[1]) return send(res, 409, { error: 'That is the device you are using' })
        revokeDevice(devices, deviceRevoke[1])
        return send(res, 200, { ok: true })
      }
      // Reviews: what can be marked on a job or in a chat, the send (the owner's only), and the kept record (lib/marks.mjs).
      if (pathname === '/v1/marks/sources' && req.method === 'GET') return send(res, 200, await reviewSources({ job: q('job'), bot: q('bot') }, { picture: (id) => `/v1/proof/${id}`, ...options }))
      if (pathname === '/v1/marks' && req.method === 'GET') return send(res, 200, await reviewRecord({ job: q('job'), project: q('project'), id: q('id') }, options))
      // The answer tray beside Needs you, the same one the map holds (lib/tray.mjs).
      if (pathname === '/v1/tray' && req.method === 'GET') return send(res, 200, { items: readTray() })
      if (pathname === '/v1/tray/questions' && req.method === 'GET') return send(res, 200, await waitingQuestions({ job: q('job'), bot: q('bot') }, options))
      if (pathname === '/v1/tray' && req.method === 'POST') {
        if (process.env.BOTYARD_REFUSE_BOTS !== 'off' && botBehind(req)) return send(res, 403, { error: 'This is the owner\'s, not a bot\'s' })
        const body = await readBody(req, MAX_LONG_BODY)
        if (body.action === 'hold') return send(res, 200, holdItem(body.item || {}))
        if (body.action === 'drop') return send(res, 200, dropItem(String(body.key || '')))
        if (body.action === 'send') return send(res, 200, await sendTray({ keys: Array.isArray(body.keys) ? body.keys.map(String) : null, settle: (id, verb, extra) => settleHeld(id, verb, { ...extra, ...connectors.options }).catch(() => null), ...options }))
        return send(res, 400, { error: 'Hold, drop or send' })
      }
      if (pathname === '/v1/marks' && req.method === 'POST') {
        if (process.env.BOTYARD_REFUSE_BOTS !== 'off' && botBehind(req)) return send(res, 403, { error: 'This is the owner\'s, not a bot\'s' })
        return send(res, 201, await sendMarks(await readBody(req, MAX_LONG_BODY), options))
      }
      if (jobAction && req.method === 'POST') return send(res, 200, await JOB_ACTIONS[jobAction[2]](jobAction[1], options))
      if (botAction && req.method === 'POST') return send(res, 200, await BOT_ACTIONS[botAction[2]](botAction[1], options))
      if (question && req.method === 'POST') {
        const [, jobId, questionId, verb] = question
        const body = await readBody(req)
        if (verb === 'respond') return send(res, 200, await answerQuestion(jobId, questionId, body.answers, options))
        // A card that held a bot's call on the owner's own account: the yes sends it, the no tells the bot.
        if (verb === 'accept') { const out = await acceptQuestion(jobId, questionId, options); await settleHeld(questionId, 'accept', connectors.options).catch(() => null); return send(res, 200, out) }
        const out = await rejectQuestion(jobId, questionId, body.reason, options)
        await settleHeld(questionId, 'reject', { reason: body.reason || '', ...connectors.options }).catch(() => null)
        return send(res, 200, out)
      }
      if (decision && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await decideApproval(decision[1], decision[2], body.note, options))
      }
      if (pathname === '/v1/chats' && req.method === 'GET') return send(res, 200, await chatsSoon(options))
      if (pathname === '/v1/models' && req.method === 'GET') {
        // Which model every bot runs on, the free models' health and the subscriptions: files and the engine only.
        return send(res, 200, await readModels({ folder: crew, agents: () => agentModels(options), plans: await plans() }))
      }
      // The map's sections, read the same way the map reads them and cut down for a phone.
      if (pathname === '/v1/jobs' && req.method === 'GET') {
        // 'all' is every pile; a phone that names none gets the older Active pile, as it always did.
        return send(res, 200, await jobList({ pile: q('pile') === 'all' ? '' : q('pile') || 'active', project: q('project'), bot: q('bot'), q: q('q'), page: page(), ...options }))
      }
      if (jobMore && req.method === 'GET') {
        return send(res, 200, phoneJobMore(await jobPage(jobMore[1], { previews, previewHost: hostOf(req), previewPort, ...options })))
      }
      if (pathname === '/v1/bots' && req.method === 'GET') return send(res, 200, phoneBots(await botList({ folder: crew, ...options })))
      if (bot && req.method === 'GET') return send(res, 200, phoneBot(await botPage(bot[1], { folder: crew, ...options })))
      if (pathname === '/v1/runs' && req.method === 'GET') return send(res, 200, await runList({ bot: q('bot'), status: q('status'), page: page(), ...options }))
      if (run && req.method === 'GET') return send(res, 200, await runDetail(run[1], options))
      if (pathname === '/v1/activity' && req.method === 'GET') return send(res, 200, await activityPage({ page: page(), bot: q('bot'), ...options }))
      // The owner's notes, read-only (lib/brain.mjs); the door's key is already checked, a bot's run is refused.
      if (await brainRoute(req, res, { pathname, query: searchParams, base: '/v1/brain', send, readBody, local: false, botBehind })) return
      if (pathname === '/v1/spend' && req.method === 'GET') return send(res, 200, await moneyView({ folder: crew, ...options }))
      if (pathname === '/v1/improvements' && req.method === 'GET') return send(res, 200, improvementsView({ folder: crew, lead: (await leadOf(options).catch(() => null))?.name || '' }))
      const finding = pathname.match(/^\/v1\/improvements\/(IMP-\d{1,6})$/)
      if (finding && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await decideImprovement(finding[1], { action: String(body.action || ''), reason: body.reason }, { folder: crew, engine: options }))
      }
      if (pathname === '/v1/projects' && req.method === 'GET') {
        // The ranking is saved through /v1/guard, as the map saves it: { ranked } and { shelved }.
        const [manager, limits] = [await managerSoon(options), readGuard(guard)]
        const shelf = new Set(limits.shelved)
        return send(res, 200, {
          projects: rankProjects(manager.projects, limits.ranked).map((p) => ({ ...p, shelved: shelf.has(p.name) })),
          ranked: limits.ranked,
          shelved: limits.shelved,
        })
      }
      if (project && req.method === 'GET') {
        const [info, manager] = await Promise.all([projectPage(project[1], options), managerSoon(options)])
        const counts = manager.projects.find((p) => p.id === project[1]) || null
        const here = new Set(counts?.bots || [])
        const { folders, ...rest } = info
        return send(res, 200, {
          ...rest,
          counts,
          shelved: readGuard(guard).shelved.includes(info.name),
          bots: manager.bots.filter((b) => here.has(b.name)).map(({ id, name, status, model, why, job }) => ({ id, name, status, model, why, job })),
          lines: manager.lines.filter((l) => l.projectId === project[1] || l.project === info.name),
        })
      }
      if (pathname === '/v1/timers' && req.method === 'GET') return send(res, 200, { timers: await timers() })
      if (pathname === '/v1/library' && req.method === 'GET') return send(res, 200, await artifactList({ cursor: q('cursor'), kind: q('kind') || 'all', ...options }))
      // Connectors: what is connected and who may use it. Adding one and signing in happen on the PC,
      // where the service sends the owner back to.
      if (pathname === '/v1/connectors' && req.method === 'GET') {
        const crew = connectors.crew ?? (await crewOf(await companyId(options), options)).map((a) => ({ id: a.id, name: a.name }))
        return send(res, 200, connectorList({ crew, ...connectors.options }))
      }
      if (connectorAct && req.method === 'POST') {
        const crew = connectors.crew ?? (await crewOf(await companyId(options), options)).map((a) => ({ id: a.id, name: a.name }))
        const body = await readBody(req)
        if (connectorAct[2] === 'access') return send(res, 200, await setAccess(connectorAct[1], { bots: body.bots, writes: body.writes, owner: body.owner }, { crew, ...connectors.options }))
        await loadTools(connectorAct[1], connectors.options)
        return send(res, 200, connectorList({ crew, ...connectors.options }).connectors.find((c) => c.id === connectorAct[1]) || {})
      }
      if (connectCard && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await settleConnectCard(connectCard[1], { connected: body.connected === true, service: body.service }, options))
      }
      if (pathname === '/v1/company' && req.method === 'GET') return send(res, 200, phoneCompany(await companySettings(options)))
      // A page of the owner's own (lib/own-pages.mjs): the list, and the page's own calls to its server file.
      // A phone has no use for a page's scripts and styles, so its files are not passed on.
      const own = /^\/v1\/own(\/([a-z0-9][a-z0-9-]{0,31})\/api(\/.*)?)?$/.exec(pathname)
      if (own && (get || post)) {
        const inner = new URL(`${OWN_PATH}${own[1] || ''}${req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length)}`, 'http://localhost')
        const runHelper = async (name) => {
          const { timetableAct } = await import('./lib/timetable.mjs')
          return timetableAct({ action: 'run', name: String(name) })[0] === 200
        }
        return await ownPagesRequest(req, res, inner, { demo: process.env.BOTYARD_DEMO === '1', runHelper })
      }
      if (chat && req.method === 'GET') return send(res, 200, await chatThread(chat[1], options))
      if (chatMessage && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 201, await sendChat(chatMessage[1], body.text, body.requestId, { ...options, pictures: body.pictures }))
      }
      // A picture for a chat message: its bytes, with its type and name, before the message names it.
      if (chatPicture && req.method === 'POST') {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        if (!PROOF_TYPES.has(type)) return send(res, 415, { error: 'Send a picture: PNG, JPEG, WebP or GIF' })
        const declared = Number(req.headers['content-length'])
        if (declared > MAX_ATTACH_BYTES) return send(res, 413, { error: 'Pictures are limited to 10 MB' })
        const bytes = await readBytes(req, MAX_ATTACH_BYTES)
        return send(res, 201, await uploadChatPicture(chatPicture[1], { name: q('name'), type, bytes }, options))
      }
      return send(res, 404, { error: 'Unknown endpoint' })
    } catch (err) {
      const status = err instanceof EngineError || err instanceof ConnectorError ? err.status : 500
      return send(res, status >= 400 && status < 600 ? status : 502, { error: err.message || 'Something went wrong', ...(err.canInit ? { canInit: true } : {}) })
    }
  }
  // The warm-up of the first screen, so a caller can wait for the door to be ready.
  handler.warmed = warmed
  return handler
}

export function startPhoneDoor(env = process.env) {
  const token = env.BOTYARD_PHONE_TOKEN || ''
  if (token.length < MIN_TOKEN) {
    throw new Error(`Set BOTYARD_PHONE_TOKEN to at least ${MIN_TOKEN} characters to open the phone door`)
  }
  const host = env.BOTYARD_PHONE_HOST || '127.0.0.1'
  const port = Number(env.BOTYARD_PHONE_PORT) || 5288
  const previews = previewRoot(env)
  const previewPort = Number(env.BOTYARD_PREVIEW_PORT) || PREVIEW_PORT
  const server = http.createServer(phoneHandler({ token, previews, previewPort, away: awayFile(env), edge: edgeFile(env), port }))
  server.listen(port, host, () => console.log(`Botyard phone door → http://${host}:${port}`))
  startPreviews({ root: previews, host, port: previewPort })
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    startPhoneDoor()
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
