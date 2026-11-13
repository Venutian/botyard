/**
 * A project's goal, as the owner sees it and the lead reads it.
 *
 * The lead's rules (the crew's goal rules) keep each project's current goal in its description in the engine, in
 * marked parts: GOAL (who, when): the outcome. DONE WHEN: the checks that prove it. FIRST: the next step.
 * PARKED: what it pushes aside. OPEN NOW: what is in the way today (the lead keeps that one up to date).
 * Anything before the first mark is what the project is. This reads those parts out for the project
 * page, and writes them back the same way when the owner edits the goal, so the lead reads it as before.
 */

const MARKS = [
  ['goal', /GOAL(?:\s*\(([^)]*)\))?\s*:/],
  ['doneWhen', /DONE WHEN(?:\s+([^:.]{1,40}))?\s*:/],
  ['first', /FIRST\s*:/],
  ['parked', /PARKED\s*:/],
  ['open', /OPEN NOW\s*:/],
]
const ANY = new RegExp(`\\b(?:${MARKS.map(([, re]) => re.source).join('|')})`, 'g')
const LABEL = { goal: 'GOAL', doneWhen: 'DONE WHEN', first: 'FIRST', parked: 'PARKED', open: 'OPEN NOW' }
export const GOAL_FIELDS = ['about', 'goal', 'doneWhen', 'first', 'parked']
const MAX = { about: 1200, goal: 1500, doneWhen: 1500, first: 600, parked: 600 }

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** The parts of a description. A description with no marks is all "about", and has no goal. */
export function readGoal(description) {
  const text = String(description ?? '')
  const out = { about: '', goal: '', doneWhen: '', first: '', parked: '', open: '', setBy: '' }
  const hits = [...text.matchAll(ANY)]
  out.about = tidy(text.slice(0, hits[0]?.index ?? text.length))
  hits.forEach((hit, n) => {
    const [field, re] = MARKS.find(([, r]) => new RegExp(`^${r.source}`).test(hit[0]))
    const said = tidy(text.slice(hit.index + hit[0].length, hits[n + 1]?.index ?? text.length))
    // "DONE WHEN Phase 1: …" keeps what it is qualified by.
    const by = field === 'doneWhen' ? tidy(hit[0].match(re)?.[1] || '') : ''
    const body = by ? `${by}: ${said}` : said
    // A mark that comes twice keeps both: nothing the owner or the lead wrote is dropped.
    out[field] = out[field] ? `${out[field]} ${body}` : body
    if (field === 'goal') out.setBy = tidy(hit[0].match(re)?.[1] || '')
  })
  return out
}

/** The description from its parts, in the order the lead's rules write it. OPEN NOW is kept as it was. */
export function writeGoal(parts, { now = new Date(), by = 'owner' } = {}) {
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const said = (field) => tidy(parts[field])
  return [
    said('about'),
    said('goal') ? `GOAL (${by}, ${day}): ${said('goal')}` : '',
    ...['doneWhen', 'first', 'parked', 'open'].map((f) => (said(f) ? `${LABEL[f]}: ${said(f)}` : '')),
  ].filter(Boolean).join(' ')
}

/** What the owner sent, checked: only the known fields, as plain text, each within its length. */
export function goalInput(body) {
  const out = {}
  for (const field of GOAL_FIELDS) {
    const value = tidy(body?.[field])
    if (value.length > MAX[field]) throw Object.assign(new Error(`${field === 'about' ? 'About' : LABEL[field][0] + LABEL[field].slice(1).toLowerCase()} is limited to ${MAX[field]} characters`), { status: 400 })
    out[field] = value
  }
  return out
}

/** The note the lead gets in his chat when the owner changes a goal, so he works toward it from his next wake. */
export function goalNote(project, parts) {
  const lines = [`I changed the goal of ${project}.`]
  if (parts.goal) lines.push(`GOAL: ${parts.goal}`)
  else lines.push('It has no goal now: work from what the project is and its own docs.')
  if (parts.doneWhen) lines.push(`DONE WHEN: ${parts.doneWhen}`)
  if (parts.first) lines.push(`FIRST: ${parts.first}`)
  if (parts.parked) lines.push(`PARKED: ${parts.parked}`)
  lines.push('It is already in the project\'s description. Work toward it from now on: if nothing is running or queued for it, brief its next step.')
  return lines.join('\n\n')
}

/**
 * The newest plan the lead wrote for a project: a "Plan:" job, its goal (from the job's own brief) and his
 * report of the steps (his last comment that starts with PLAN:). Null when there is none.
 */
export function planOf(job, comments = []) {
  if (!job) return null
  const report = [...comments].reverse().find((c) => /^\s*PLAN\s*:/.test(c?.body || ''))
  const brief = readGoal(String(job.description || '').replace(/^#.*$/m, ''))
  return {
    id: job.id,
    title: String(job.title || '').replace(/^Plan:\s*/, ''),
    status: job.status || '',
    at: job.updatedAt || job.createdAt || null,
    goal: brief.goal,
    doneWhen: brief.doneWhen,
    report: report ? String(report.body).trim().slice(0, 6000) : '',
  }
}
