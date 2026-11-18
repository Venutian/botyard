/**
 * A bot that has copies of itself on other AIs is one card. What the card says about them, in one place for the
 * crew bar, the map and the Crew sheet: a small tag with the AI the running copy is on, and, when the bot holds
 * several jobs at once, how many ("checking 3") with the jobs in its title.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const VERB = { checking: 'checking', building: 'building', fix: 'fixing', fixing: 'fixing', ruling: 'ruling' }

/** The word for what a bot's jobs are, from the first word of a job's stage; '' when they differ or it is not known. */
function verbOf(jobs) {
  const words = new Set(jobs.map((j) => VERB[String(j.stage || '').split(' ')[0].toLowerCase()] || ''))
  return words.size === 1 ? [...words][0] : ''
}

/** "checking 3", or "3 jobs" when they are of several kinds; '' when the bot holds one job or none. */
export function busyWords(jobs = []) {
  if (!Array.isArray(jobs) || jobs.length < 2) return ''
  return `${verbOf(jobs) || 'on'} ${jobs.length}${verbOf(jobs) ? '' : ' jobs'}`
}

/** The jobs a bot holds, one per line, for a tooltip. */
export const jobsTitle = (jobs = []) => jobs.map((j) => [j.ref, j.title].filter(Boolean).join(' ')).join('\n')

/** The tag for a bot with copies: the AI its running copy is on. Nothing for a bot with none. */
export function copyTag(bot) {
  if (!Array.isArray(bot?.copies) || bot.copies.length < 2) return ''
  const now = bot.copies.find((c) => c.running) || bot.copies[0]
  const ai = bot.on || now.engine || now.where || ''
  const model = now.model ? ` (${now.model})` : ''
  const names = bot.copies.map((c) => c.name).join(', ')
  return ai ? `<em class="copy-tag" title="${esc(`Running on ${ai}${model}. One bot with ${bot.copies.length} copies, one per AI: ${names}`)}">${esc(ai)}</em>` : ''
}
