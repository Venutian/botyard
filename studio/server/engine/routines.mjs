/**
 * Routines: work that starts by itself. A routine with a timetable becomes a job for its bot when
 * its time comes; if its last job is still open it is not started again on top of it. The timetable
 * is the five-field form the owner's choices are saved in (minute, hour, day, month, weekday), read
 * in the routine's own time zone.
 */
import { randomUUID } from 'node:crypto'
import { Refused, createJob, note } from './write.mjs'

const iso = (now) => new Date(now).toISOString()

/** One field of a timetable as the set of numbers it allows: `*`, `5`, `1-5`, `1,3,5`, and steps like `*` + `/15`. */
function field(text, min, max) {
  const out = new Set()
  for (const part of String(text).split(',')) {
    const [range, stepText] = part.split('/')
    const step = Math.max(1, Number(stepText) || 1)
    let [from, to] = range === '*' ? [min, max] : range.split('-').map(Number)
    if (to === undefined) to = from
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return out
}

const PARTS = { minute: 'minute', hour: 'hour', day: 'day', month: 'month', weekday: 'weekday' }
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** The clock on the wall in a time zone, at an instant. */
function wall(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  return { [PARTS.minute]: Number(parts.minute), [PARTS.hour]: Number(parts.hour), [PARTS.day]: Number(parts.day), [PARTS.month]: Number(parts.month), [PARTS.weekday]: WEEKDAYS[parts.weekday] }
}

/**
 * The next minute after `after` that the timetable names, in ms, or null when it is not a timetable
 * this engine reads. Looks a year ahead at most, a minute at a time: a routine fires a few times a
 * day, and this runs once each time it does.
 */
export function nextTime(cron, after, timeZone = 'UTC') {
  const fields = String(cron || '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, day, month, weekday] = [field(fields[0], 0, 59), field(fields[1], 0, 23), field(fields[2], 1, 31), field(fields[3], 1, 12), field(fields[4].replace(/7/g, '0'), 0, 6)]
  if (!minute || !hour || !day || !month || !weekday) return null
  try { wall(after, timeZone) } catch { return null }
  let at = Math.floor(after / 60_000) * 60_000 + 60_000
  for (let n = 0; n < 366 * 24 * 60; n++, at += 60_000) {
    const w = wall(at, timeZone)
    if (minute.has(w.minute) && hour.has(w.hour) && day.has(w.day) && month.has(w.month) && weekday.has(w.weekday)) return at
    // Skip the rest of an hour that cannot match.
    if (!hour.has(w.hour) && w.minute === 0) at += 59 * 60_000
  }
  return null
}

/** Start a routine now: its job is made and given to its bot. */
export function runRoutine(store, routineId, { now = Date.now(), actor, source = 'manual', triggerId = null } = {}) {
  const routine = store.object('SELECT raw FROM routines WHERE id = ?', routineId)
  if (!routine) throw new Refused(404, 'Routine not found')
  if (routine.status === 'archived') throw new Refused(409, 'This routine was removed')
  const position = store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM routine_runs WHERE routine_id = ?', routineId).n
  const base = { id: randomUUID(), companyId: routine.companyId, routineId, triggerId, source, triggeredAt: iso(now), createdAt: iso(now), updatedAt: iso(now) }
  // One at a time: a routine whose last job is still open is not started again on top of it.
  const last = store.objects('SELECT raw FROM routine_runs WHERE routine_id = ? ORDER BY triggered_at DESC LIMIT 1', routineId)[0]
  const open = last?.linkedIssueId ? store.object('SELECT raw FROM jobs WHERE id = ?', last.linkedIssueId) : null
  if (open && !['done', 'cancelled'].includes(open.status)) {
    const run = { ...base, status: 'coalesced', linkedIssueId: open.id, coalescedIntoRunId: last.id }
    store.put('routine_runs', run, { position })
    return run
  }
  const job = createJob(store, routine.companyId, { title: routine.title, description: routine.description || '', projectId: routine.projectId || null, assigneeAgentId: routine.assigneeAgentId || null, priority: routine.priority }, { now, actor })
  const run = { ...base, status: 'issue_created', linkedIssueId: job.id }
  store.tx(() => {
    store.put('routine_runs', run, { position })
    store.put('routines', { ...routine, lastTriggeredAt: iso(now), lastEnqueuedAt: iso(now), updatedAt: iso(now) }, { position: store.row('SELECT position FROM routines WHERE id = ?', routineId).position })
  })
  return run
}

/** Start every routine whose time has come, and set each one's next time. */
export function tickRoutines(store, { now = Date.now() } = {}) {
  const fired = []
  for (const trigger of store.objects("SELECT raw FROM routine_triggers WHERE kind = 'schedule' AND enabled = 1")) {
    const routine = store.object('SELECT raw FROM routines WHERE id = ?', trigger.routineId)
    if (!routine || routine.status !== 'active') continue
    const due = trigger.nextRunAt ? Date.parse(trigger.nextRunAt) : null
    const next = nextTime(trigger.cronExpression, now, trigger.timezone || 'UTC')
    if (due !== null && due <= now) {
      // A time missed while the engine was off is skipped, not made up for: only the newest one counts.
      const late = now - due > 10 * 60_000
      if (!late) fired.push(runRoutine(store, routine.id, { now, source: 'schedule', triggerId: trigger.id, actor: { user: 'routine' } }))
      store.put('routine_triggers', { ...trigger, lastFiredAt: late ? trigger.lastFiredAt || null : iso(now), nextRunAt: next ? iso(next) : null, updatedAt: iso(now) })
    } else if (due === null && next) {
      store.put('routine_triggers', { ...trigger, nextRunAt: iso(next), updatedAt: iso(now) })
    }
  }
  return fired
}

// ── making and changing routines ────────────────────────────────────────────────────

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const ROUTINE_STATUSES = new Set(['active', 'paused', 'archived'])
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])

const routineOf = (store, id) => store.object('SELECT raw FROM routines WHERE id = ?', id)
const triggersOf = (store, routineId) => store.objects('SELECT raw FROM routine_triggers WHERE routine_id = ? ORDER BY rowid', routineId)

function routineOr404(store, id) {
  const routine = routineOf(store, id)
  if (!routine) throw new Refused(404, 'Routine not found')
  return routine
}

/** Write the routine with its timetables as they are now, and keep what it was as a revision. */
function saveRoutine(store, routine, summary, { now, actor }) {
  const triggers = triggersOf(store, routine.id)
  const number = (Number(routine.latestRevisionNumber) || 0) + 1
  const revisionId = randomUUID()
  const bot = routine.assigneeAgentId ? store.object('SELECT raw FROM agents WHERE id = ?', routine.assigneeAgentId) : null
  const next = {
    ...routine, triggers, latestRevisionId: revisionId, latestRevisionNumber: number,
    assignee: bot ? { id: bot.id, name: bot.name, role: bot.role, title: bot.title, urlKey: bot.urlKey } : null,
    updatedByAgentId: actor?.agent || null, updatedByUserId: actor?.agent ? null : actor?.user || 'local-board', updatedAt: iso(now),
  }
  const position = store.row('SELECT position FROM routines WHERE id = ?', routine.id)?.position ?? store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM routines').n
  store.put('routines', next, { position })
  const { triggers: _t, recentRuns: _r, lastRun: _l, activeIssue: _a, project: _p, assignee: _b, ...plain } = next
  store.put('routine_revisions', {
    id: revisionId, companyId: routine.companyId, routineId: routine.id, revisionNumber: number, title: next.title, description: next.description || '',
    snapshot: { routine: plain, version: 1, triggers }, changeSummary: summary, restoredFromRevisionId: null,
    createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', createdByRunId: actor?.run || null, createdAt: iso(now),
  }, { position: number })
  return next
}

/** The fields of a routine that a request may set, checked against the studio. */
function routineFields(store, body, before = null) {
  const out = {}
  if (body.title !== undefined || !before) { const title = text(body.title, 500).trim(); if (!title) throw new Refused(400, 'A routine needs a title'); out.title = title }
  if (body.description !== undefined) out.description = text(body.description, 200_000)
  if (body.assigneeAgentId !== undefined || !before) {
    const bot = body.assigneeAgentId ? store.object('SELECT raw FROM agents WHERE id = ?', body.assigneeAgentId) : null
    if (!bot || bot.status === 'terminated') throw new Refused(400, 'A routine needs a bot of this studio to do it')
    out.assigneeAgentId = bot.id
  }
  if (body.projectId !== undefined) {
    if (body.projectId && !store.row('SELECT id FROM projects WHERE id = ?', body.projectId)) throw new Refused(400, 'That project is not in this studio')
    out.projectId = body.projectId || null
  }
  if (body.priority !== undefined) { if (!PRIORITIES.has(body.priority)) throw new Refused(400, 'Unknown priority'); out.priority = body.priority }
  if (body.status !== undefined) { if (!ROUTINE_STATUSES.has(body.status)) throw new Refused(400, 'A routine is active, paused or archived'); out.status = body.status }
  return out
}

/** POST /companies/:id/routines. It has no timetable until one is added. */
export function createRoutine(store, companyId, body = {}, { now = Date.now(), actor } = {}) {
  if (!store.row('SELECT id FROM company WHERE id = ?', companyId)) throw new Refused(404, 'Company not found')
  const fields = routineFields(store, body)
  return store.tx(() => {
    const routine = {
      id: randomUUID(), companyId, projectId: null, parentIssueId: null, description: '', priority: 'medium', status: 'active',
      concurrencyPolicy: 'coalesce_if_active', catchUpPolicy: 'skip_missed', originKind: 'manual', latestRevisionId: null, latestRevisionNumber: 0,
      createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board',
      lastTriggeredAt: null, lastEnqueuedAt: null, triggers: [], recentRuns: [], lastRun: null, activeIssue: null, createdAt: iso(now), ...fields,
    }
    note(store, 'routine.created', { type: 'routine', id: routine.id }, actor, {}, now)
    return saveRoutine(store, routine, 'Created routine', { now, actor })
  })
}

/** PATCH /routines/:id: its title, text, bot, project, priority; active, paused or archived (removed). */
export function patchRoutine(store, id, body = {}, { now = Date.now(), actor } = {}) {
  const routine = routineOr404(store, id)
  const fields = routineFields(store, body, routine)
  return store.tx(() => {
    // A routine that is switched back on starts from its next time, not from one it missed while off.
    if (fields.status === 'active' && routine.status !== 'active') {
      for (const trigger of triggersOf(store, id)) {
        const next = trigger.kind === 'schedule' ? nextTime(trigger.cronExpression, now, trigger.timezone || 'UTC') : null
        store.put('routine_triggers', { ...trigger, nextRunAt: next ? iso(next) : null, updatedAt: iso(now) })
      }
    }
    note(store, fields.status === 'archived' ? 'routine.archived' : 'routine.updated', { type: 'routine', id }, actor, {}, now)
    return saveRoutine(store, { ...routine, ...fields }, fields.status && fields.status !== routine.status ? `Set to ${fields.status}` : 'Updated routine', { now, actor })
  })
}

/** DELETE /routines/:id: the routine stops and leaves the lists; its runs and their jobs stay. */
export const removeRoutine = (store, id, ctx) => patchRoutine(store, id, { status: 'archived' }, ctx)

/** A timetable's fields, checked: five fields this engine reads, in a time zone it knows. */
function triggerFields(body, before, now) {
  const cronExpression = body.cronExpression !== undefined ? String(body.cronExpression).trim().replace(/\s+/g, ' ') : before?.cronExpression
  const timezone = body.timezone !== undefined ? String(body.timezone || 'UTC').trim() : before?.timezone || 'UTC'
  const next = nextTime(cronExpression, now, timezone)
  if (next === null) throw new Refused(400, 'A timetable is five fields (minute, hour, day, month, weekday) in a time zone like Europe/Stockholm')
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : before?.enabled ?? true
  return { cronExpression, timezone, enabled, nextRunAt: iso(next) }
}

/** POST /routines/:id/triggers: when the routine starts by itself. */
export function addTrigger(store, routineId, body = {}, { now = Date.now(), actor } = {}) {
  const routine = routineOr404(store, routineId)
  if ((body.kind || 'schedule') !== 'schedule') throw new Refused(400, 'A routine starts on a timetable. Other ways are not built')
  const fields = triggerFields(body, null, now)
  return store.tx(() => {
    const trigger = {
      id: randomUUID(), companyId: routine.companyId, routineId, kind: 'schedule', label: text(body.label, 120) || null, ...fields, lastFiredAt: null, lastResult: null,
      createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', createdAt: iso(now), updatedAt: iso(now),
    }
    store.put('routine_triggers', trigger, { routine_id: routineId })
    saveRoutine(store, routine, 'Added a timetable', { now, actor })
    return trigger
  })
}

function triggerOr404(store, id) {
  const trigger = store.object('SELECT raw FROM routine_triggers WHERE id = ?', id)
  if (!trigger) throw new Refused(404, 'Timetable not found')
  return trigger
}

/** PATCH /routine-triggers/:id: another timetable, another time zone, on or off. */
export function patchTrigger(store, id, body = {}, { now = Date.now(), actor } = {}) {
  const trigger = triggerOr404(store, id)
  const fields = triggerFields(body, trigger, now)
  return store.tx(() => {
    const next = { ...trigger, ...fields, ...(body.label !== undefined ? { label: text(body.label, 120) || null } : {}), updatedAt: iso(now) }
    store.put('routine_triggers', next, { routine_id: trigger.routineId })
    const routine = routineOf(store, trigger.routineId)
    if (routine) saveRoutine(store, routine, 'Changed its timetable', { now, actor })
    return next
  })
}

/** DELETE /routine-triggers/:id: the routine no longer starts by that timetable. */
export function removeTrigger(store, id, { now = Date.now(), actor } = {}) {
  const trigger = triggerOr404(store, id)
  return store.tx(() => {
    store.drop('routine_triggers', id)
    const routine = routineOf(store, trigger.routineId)
    if (routine) saveRoutine(store, routine, 'Removed a timetable', { now, actor })
    return { ok: true }
  })
}
