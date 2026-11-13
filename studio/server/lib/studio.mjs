/**
 * The map's view of the yard: each bot of the crew is a character, standing in the bay of the
 * project its job belongs to, or in the depot when it has none. The engine knows its own runs, so
 * nothing on this computer is scanned for it.
 *
 * On only where the engine runs on this machine.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { guardFolder, readGuard } from './guard.mjs'
import { readPlans } from './plans.mjs'
import { managerWithRecords } from './manager.mjs'

const HOUR_MS = 60 * 60 * 1000
const FRESH_MS = 24 * HOUR_MS
/** Past the map's own "nothing for three days" line, so a paused bot sits down and sleeps. */
const ASLEEP_MS = 4 * 24 * HOUR_MS
/** Where a bot with no job in a project waits: the yard's own bay. */
export const CREW_ROOM = 'Depot'
const CREW_SIZE = 1.6
const FRESH_STUDIO_MS = 3_000
/**
 * The screens that are not a project's: opened from the dock. They were rooms on the map once,
 * each with a keeper at a desk; the map now shows work only (a bay per project and the depot).
 */
export const SCREENS = [
  { id: 'chats', room: 'Chat room', name: 'Chats', does: 'Every conversation with the crew' },
  { id: 'manager', room: "Manager's office", name: 'Manager', does: 'What the crew is doing and what needs a look' },
  { id: 'settings', room: 'Control room', name: 'Settings', does: 'Limits, the crew, phones and the company' },
]
const FACE_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' }
const FACES_FRESH_MS = 60_000

/**
 * The characters the map draws: one per bot of the crew. `manager` and `records` come from
 * `managerWithRecords`. Pure, so the tests can pin it.
 */
export function studioRoster({ manager, records, now = Date.now() }) {
  const projectNames = new Map(records.projects.map((p) => [p.id, p.name]))
  const blocked = new Set(records.issues.filter((i) => i.status === 'blocked').map((i) => i.assigneeAgentId))
  return manager.bots.map((bot, index) => {
    // A bot stands in the bay of the job it has; with none (free, paused, stopped) it waits in the depot.
    const room = (bot.job && projectNames.get(bot.projectId)) || CREW_ROOM
    const running = bot.status === 'running'
    return {
      // The room is part of who this is on the map: a bot given a job in another project walks
      // out of one room and into the other, instead of its desk sliding across the floor.
      id: `crew:${bot.id}:${bot.projectId || 'none'}`,
      harness: 'crew', harnessName: bot.title || 'Crew', source: 'crew', ref: null, canOpen: false,
      title: bot.name,
      preview: bot.job ? `${bot.job.stage}: ${bot.job.title}` : bot.why || (bot.last ? `Last on ${bot.last.ref} ${bot.last.title}` : ''),
      project: room, projectPath: '', cwd: '', worktree: '', gitBranch: '', model: bot.model,
      // The crew keep their desks in the order the manager lists them.
      createdAt: index + 1,
      lastActivityAt: running ? now : bot.status === 'paused' ? now - ASLEEP_MS : Math.max(bot.last?.at || 0, now - FRESH_MS),
      running, hasError: !running && bot.status !== 'paused' && blocked.has(bot.id), prState: '', unread: false, archived: false,
      size: CREW_SIZE,
      crew: { id: bot.id, name: bot.name, title: bot.title, role: bot.role, look: bot.look, status: bot.status, resting: bot.resting, model: bot.model, where: bot.where, why: bot.why, job: bot.job, last: bot.last },
    }
  })
}

/** A bot's portrait is a picture named after it: "Senior Builder" is `senior-builder.webp`. */
export const faceName = (name = '') => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export const facesFolder = (env = process.env) => path.join(guardFolder(env), 'faces')

let faceCache = { at: 0, folder: '', files: new Map() }

/** The portraits in the faces folder, by name. Listed once a minute: a new picture needs no restart. */
async function faceFiles(folder, now) {
  if (faceCache.folder !== folder || now - faceCache.at > FACES_FRESH_MS) {
    const names = await fsp.readdir(folder).catch(() => [])
    const files = new Map(names.filter((n) => FACE_TYPES[path.extname(n)]).map((n) => [path.basename(n, path.extname(n)), n]))
    faceCache = { at: now, folder, files }
  }
  return faceCache.files
}

/** Which bots have a portrait: bot id to the address the map loads it from. */
export async function crewFaces(bots, { folder = facesFolder(), now = Date.now() } = {}) {
  const files = await faceFiles(folder, now)
  return Object.fromEntries(bots.filter((b) => files.has(faceName(b.name))).map((b) => [b.id, `/api/studio/face?name=${faceName(b.name)}`]))
}

/** One portrait's bytes and type, or null. Only a name from the folder's own listing is ever read. */
export async function readFace(name, { folder = facesFolder(), now = Date.now() } = {}) {
  const file = (await faceFiles(folder, now)).get(String(name))
  if (!file) return null
  const data = await fsp.readFile(path.join(folder, file)).catch(() => null)
  return data && { data, type: FACE_TYPES[path.extname(file)] }
}

let studioCache = null
let studioRefresh = null

/**
 * What the map polls: the roster and the manager's view in one small answer. The last one is
 * served while the next is worked out behind it, so the page never waits on the engine or git.
 */
export async function studioView({ now = Date.now, ...options } = {}) {
  const refresh = () => {
    studioRefresh ||= managerWithRecords({ now: now(), ...options })
      .then(async ({ manager, records }) => {
        const [faces, plans] = await Promise.all([crewFaces(manager.bots, { now: now() }), readPlans().catch(() => null)])
        const guard = readGuard(guardFolder())
        studioCache = { at: now(), view: { on: true, threads: studioRoster({ manager, records, now: now() }), manager, faces, plans, depot: CREW_ROOM, yard: records.name || '', shelved: guard.shelved, ranked: guard.ranked, screens: SCREENS,
          scannedAt: now() } }
        return studioCache.view
      })
      .finally(() => { studioRefresh = null })
    return studioRefresh
  }
  if (!studioCache) return refresh()
  if (now() - studioCache.at > FRESH_STUDIO_MS) refresh().catch(() => {})
  return studioCache.view
}

/** Something the map shows was just changed (a bot, a project, the studio's name): the next poll works the view out again. */
export function staleStudioView() { if (studioCache) studioCache.at = 0 }

/** For tests: start from nothing, as after a restart. */
export function forgetStudioView() { studioCache = null; studioRefresh = null }
