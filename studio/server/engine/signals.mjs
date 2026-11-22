/**
 * The crew's signals and the blocked-jobs sweep: plain counts from the store, no AI.
 *
 * `crewSignals` answers "is the crew getting wasteful?": runs per finished job and per finished request, retries,
 * stale track steps (a round somebody started and nobody used), and the jobs that took the most runs. The crew
 * doctor reads it once a day (GET /companies/:id/signals?hours=24).
 *
 * `blockedSweep` looks at every job blocked for more than a day and sorts it: a track step whose trip has moved
 * on (nobody will read it), an "Unblock:" job that loops on a job that is still blocked, and a crew digest
 * nobody read are closed; anything else is only listed for the owner or the ruler. The engine runs it once a
 * day; a person or script can run it any time (POST /companies/:id/sweep/blocked, `apply: false` to look).
 */
import { ownerOrScript } from './caller.mjs'
import { Refused, addComment, note, patchJob } from './write.mjs'

const HOUR = 3_600_000
const ENGINE = { user: 'engine:sweep' }
const iso = (ms) => new Date(ms).toISOString()
const MARK = /TRACK STEP:\s*([0-9a-f-]{36})\/([\w-]+)\/(\d+)/

/** Numbers for a window of time (default the last 24 hours). */
export function crewSignals(store, { now = Date.now(), hours = 24 } = {}) {
  const from = iso(now - Math.max(1, Number(hours) || 24) * HOUR)
  const to = iso(now)
  const n = (sql, ...a) => store.row(sql, ...a).n
  const finishedJobs = n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND completed_at >= ? AND completed_at < ?", from, to)
  const runs = n('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ? AND started_at < ?', from, to)
  const failedRuns = n("SELECT COUNT(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? AND status IN ('failed', 'timed_out')", from, to)
  const retries = n('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? AND retry_of_run_id IS NOT NULL', from, to)
  const stale = store.objects("SELECT raw FROM trip_steps WHERE status = 'stale'").filter((r) => r.staleAt >= from && r.staleAt < to)
  const staleByStep = {}
  for (const r of stale) staleByStep[r.stepId] = (staleByStep[r.stepId] || 0) + 1
  // Runs for each request that finished in the window: its own job and every job its trips made.
  const done = store.objects("SELECT raw FROM requests WHERE status IN ('done') AND updated_at >= ? AND updated_at < ?", from, to)
  let requestRuns = 0
  for (const request of done) {
    const ids = new Set([request.jobId])
    for (const r of store.objects('SELECT raw FROM trip_steps WHERE request_id = ?', request.id).filter(() => true)) if (r.jobId) ids.add(r.jobId)
    for (const id of ids) requestRuns += n('SELECT COUNT(*) AS n FROM runs WHERE job_id = ?', id)
  }
  const heaviest = store.rows('SELECT job_id AS id, COUNT(*) AS runs FROM runs WHERE started_at >= ? AND started_at < ? GROUP BY job_id HAVING COUNT(*) >= 8 ORDER BY runs DESC LIMIT 5', from, to)
    .map((r) => ({ job: store.object('SELECT raw FROM jobs WHERE id = ?', r.id)?.identifier || r.id, title: String(store.object('SELECT raw FROM jobs WHERE id = ?', r.id)?.title || '').slice(0, 80), runs: r.runs }))
  const round = (x) => Math.round(x * 100) / 100
  return {
    window: { from, to, hours: Number(hours) || 24 },
    finishedJobs, runs, failedRuns, retries,
    runsPerFinishedJob: finishedJobs ? round(runs / finishedJobs) : null,
    staleSteps: { total: stale.length, byStep: staleByStep },
    requestsFinished: done.length, runsPerFinishedRequest: done.length ? round(requestRuns / done.length) : null,
    heaviestJobs: heaviest,
  }
}

const lastMoved = (job) => Date.parse(job.lastActivityAt || job.updatedAt || job.createdAt) || 0

/** What to do with each job blocked for longer than `olderThanHours`: close it (`close`) or only list it (`ask`). */
export function blockedSweep(store, { now = Date.now(), olderThanHours = 24, apply = false, actor = ENGINE } = {}) {
  const cutoff = now - olderThanHours * HOUR
  const blocked = store.objects("SELECT raw FROM jobs WHERE status = 'blocked' ORDER BY created_at")
  const stillBlocked = new Set(blocked.map((j) => j.identifier))
  const out = []
  for (const job of blocked) {
    if (lastMoved(job) > cutoff) continue
    // Waiting for the owner on a card is not stuck.
    if (store.row("SELECT id FROM cards WHERE job_id = ? AND status = 'pending' LIMIT 1", job.id)) continue
    const mark = MARK.exec(job.description || '')
    let kind = 'ask'
    let why = 'Blocked for more than a day with nothing waiting on the owner: the ruler or the owner decides'
    if (mark) {
      const trip = store.object('SELECT raw FROM trips WHERE id = ?', mark[1])
      const row = store.objects('SELECT raw FROM trip_steps WHERE trip_id = ? AND job_id = ?', mark[1], job.id)[0]
      if (!trip || ['done', 'stopped'].includes(trip.status) || row?.status === 'stale') { kind = 'close'; why = 'A track step whose trip has moved on: nobody reads it' }
    } else if (/^Unblock:/i.test(job.title || '')) {
      const target = /Unblock:\s*([A-Z]+-\d+)/.exec(job.title || '')?.[1]
      const same = blocked.filter((j) => /^Unblock:/i.test(j.title || '') && target && j.title.includes(target)).length
      if (target && (stillBlocked.has(target) || same > 1)) { kind = 'close'; why = `An unblock job that loops: ${target} is still blocked` }
    } else if (/^Crew digest/i.test(job.title || '')) {
      kind = 'close'; why = 'A crew digest that nobody picked up'
    }
    out.push({ job: job.identifier, id: job.id, title: String(job.title || '').slice(0, 100), blockedHours: Math.round((now - lastMoved(job)) / HOUR), kind, why })
  }
  if (apply) {
    for (const item of out.filter((o) => o.kind === 'close')) {
      addComment(store, item.id, { body: `Closed by the daily blocked-jobs sweep: ${item.why}. Nothing else was changed.` }, { now, actor, quiet: true })
      patchJob(store, item.id, { status: 'cancelled' }, { now, actor })
      item.closed = true
    }
    note(store, 'blocked.swept', { type: 'company', id: 'sweep' }, actor, { closed: out.filter((o) => o.closed).length, asked: out.filter((o) => o.kind === 'ask').length }, now)
  }
  return { checkedAt: iso(now), olderThanHours, blocked: blocked.length, found: out.length, closed: out.filter((o) => o.closed).length, items: out }
}

/** The engine runs the sweep once a day; true when it did. */
export function dailyBlockedSweep(store, state, { now = Date.now() } = {}) {
  const last = state.at || store.row("SELECT created_at FROM activity WHERE action = 'blocked.swept' ORDER BY created_at DESC LIMIT 1")?.created_at
  if (last && now - Date.parse(last) < 24 * HOUR) { state.at = last; return null }
  state.at = iso(now)
  return blockedSweep(store, { now, apply: true })
}

export const SIGNAL_WRITES = [
  [ 'POST', /^\/companies\/([^/]+)\/sweep\/blocked$/, (s, p, b, c) => {
    ownerOrScript(c.actor, 'sweeps blocked jobs')
    return [200, blockedSweep(s, { now: c.now, olderThanHours: Number(b.olderThanHours) || 24, apply: b.apply !== false, actor: c.actor })]
  } ],
]

export function readSignals(store, where, query = {}) {
  const sig = /^\/companies\/([^/]+)\/signals$/.exec(where)
  if (sig) return { status: 200, body: crewSignals(store, { hours: query.hours }) }
  if (/^\/companies\/([^/]+)\/sweep\/blocked$/.test(where)) return { status: 200, body: blockedSweep(store, { olderThanHours: Number(query.olderThanHours) || 24, apply: false }) }
  return null
}
void Refused
