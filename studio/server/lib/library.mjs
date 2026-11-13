/**
 * What runs by itself for the crew and when: the timetable's helpers, read from the timetable this
 * process runs. Read only: nothing here starts, stops or writes anything.
 */

const TIMERS_FRESH_MS = 30_000

/** The helpers as the timetable lists them, made plain: what each does, when it runs next and last ran. */
export function timerView(state) {
  return (Array.isArray(state?.jobs) ? state.jobs : [])
    .filter((j) => typeof j?.name === 'string' && j.kind !== 'keeper')
    .map((j) => ({ id: j.name, name: String(j.what || j.name), next: j.on === false ? null : Number(j.nextAt) || null, last: Number(j.lastEnd || j.lastStart) || null }))
    .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity))
}

/** Botyard's own timetable, where this process runs it; nothing where it does not. */
const askTimetable = async () => {
  const timetable = await import('./timetable.mjs').catch(() => null)
  return timetable?.timetableState ? timetable.timetableState() : null
}

let timersCache = null
/** What runs by itself for the crew and when, cached half a minute. `run` is for tests. */
export async function readTimers({ run = askTimetable, now = Date.now } = {}) {
  if (timersCache && now() - timersCache.at < TIMERS_FRESH_MS && run === askTimetable) return timersCache.timers
  const timers = timerView(await run())
  if (run === askTimetable) timersCache = { at: now(), timers }
  return timers
}
