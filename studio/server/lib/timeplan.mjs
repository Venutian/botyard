/**
 * When a routine runs, as the owner chooses it and as the engine keeps it.
 *
 * The owner picks from plain choices (every so many minutes or hours, every day at a time, weekdays
 * at a time, one day of the week at a time); the engine keeps a five-field timetable (minute, hour,
 * day, month, weekday). This is the one place that turns one into the other and back, and that says
 * a timetable in words, so the map, the phone and every list say the same thing.
 *
 * A plan is `{ kind, n?, at?, day?, cron? }`:
 *   minutes  every `n` minutes (5 to 59)
 *   hours    every `n` hours (1 to 23), on the hour
 *   daily    every day at `at` ("07:30")
 *   weekdays Monday to Friday at `at`
 *   weekly   one `day` of the week (0 Sunday to 6 Saturday) at `at`
 *   cron     the five fields as written, for anything else
 */

export class PlanError extends Error {}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** The four fixed choices older pages and the phone app before 2.7 send by name. */
export const OLD_CHOICES = { nightly: '0 3 * * *', morning: '0 7 * * *', weekdays: '0 7 * * 1-5', weekly: '0 4 * * 1' }

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
const two = (n) => String(n).padStart(2, '0')
const whole = (value, min, max, words) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new PlanError(words)
  return n
}

/** One field of a timetable, checked the way the engine reads it: `*`, `5`, `1-5`, `1,3,5`, steps with `/`. */
function fieldOk(text, min, max) {
  if (!text) return false
  for (const part of String(text).split(',')) {
    const [range, step, extra] = part.split('/')
    if (extra !== undefined || (step !== undefined && !/^[1-9]\d*$/.test(step))) return false
    if (range === '*') continue
    const ends = range.split('-')
    if (ends.length > 2 || !ends.every((e) => /^\d+$/.test(e))) return false
    const [from, to = from] = ends.map(Number)
    if (from < min || to > max || from > to) return false
  }
  return true
}

/** Five fields the engine can read, tidied to single spaces; throws PlanError otherwise. */
export function checkCron(cron) {
  const fields = String(cron ?? '').trim().split(/\s+/)
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  if (fields.length !== 5 || !fields.every((f, i) => fieldOk(f, ...limits[i]))) {
    throw new PlanError('A timetable is five parts: minute, hour, day of the month, month, day of the week. For example "30 7 * * 1-5" is 07:30 on weekdays')
  }
  return fields.join(' ')
}

/** The timetable for a plan. Throws PlanError with words for the owner when the plan cannot be read. */
export function cronOf(plan) {
  if (typeof plan === 'string') {
    if (Object.hasOwn(OLD_CHOICES, plan)) return OLD_CHOICES[plan]
    throw new PlanError('Choose when it runs')
  }
  if (!plan || typeof plan !== 'object') throw new PlanError('Choose when it runs')
  const at = () => {
    const m = TIME.exec(String(plan.at ?? '').trim())
    if (!m) throw new PlanError('Give the time as hours and minutes, like 07:30')
    return [Number(m[1]), Number(m[2])]
  }
  switch (plan.kind) {
    case 'minutes': return `*/${whole(plan.n, 5, 59, 'Every 5 to 59 minutes. For longer gaps choose hours')} * * * *`
    case 'hours': { const n = whole(plan.n, 1, 23, 'Every 1 to 23 hours. For once a day choose a time of day'); return n === 1 ? '0 * * * *' : `0 */${n} * * *` }
    case 'daily': { const [h, m] = at(); return `${m} ${h} * * *` }
    case 'weekdays': { const [h, m] = at(); return `${m} ${h} * * 1-5` }
    case 'weekly': { const [h, m] = at(); return `${m} ${h} * * ${whole(plan.day, 0, 6, 'Choose a day of the week')}` }
    case 'cron': return checkCron(plan.cron)
    default: throw new PlanError('Choose when it runs')
  }
}

/** A timetable as the plain choice it is, or `{ kind: 'cron', cron }` when it is none of them. */
export function planOf(cron) {
  const text = String(cron ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return null
  const [minute, hour, day, month, weekday] = text.split(' ')
  const anyDay = day === '*' && month === '*'
  const num = (s, max) => (/^\d+$/.test(s) && Number(s) <= max ? Number(s) : null)
  const m = num(minute, 59)
  const h = num(hour, 23)
  if (anyDay && weekday === '*') {
    const step = /^\*\/(\d+)$/.exec(minute)
    if (step && hour === '*' && Number(step[1]) >= 5 && Number(step[1]) <= 59) return { kind: 'minutes', n: Number(step[1]) }
    if (m === 0 && hour === '*') return { kind: 'hours', n: 1 }
    const hours = /^\*\/(\d+)$/.exec(hour)
    if (m === 0 && hours && Number(hours[1]) >= 1 && Number(hours[1]) <= 23) return { kind: 'hours', n: Number(hours[1]) }
    if (m !== null && h !== null) return { kind: 'daily', at: `${two(h)}:${two(m)}` }
  }
  if (anyDay && m !== null && h !== null) {
    if (weekday === '1-5') return { kind: 'weekdays', at: `${two(h)}:${two(m)}` }
    const d = num(weekday, 7)
    if (d !== null) return { kind: 'weekly', day: d % 7, at: `${two(h)}:${two(m)}` }
  }
  return { kind: 'cron', cron: text }
}

/** A timetable said in words. */
export function wordsOf(cron) {
  const plan = planOf(cron)
  if (!plan) return 'Only when started by hand'
  switch (plan.kind) {
    case 'minutes': return `Every ${plan.n} minutes`
    case 'hours': return plan.n === 1 ? 'Every hour' : `Every ${plan.n} hours`
    case 'daily': return `Every day at ${plan.at}`
    case 'weekdays': return `Weekdays at ${plan.at}`
    case 'weekly': return `${DAY_NAMES[plan.day]}s at ${plan.at}`
    default: return `On its own timetable (${plan.cron})`
  }
}
