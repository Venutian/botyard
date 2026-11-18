import { DESCRIBE } from './describe.js'

/**
 * Gives each button the page draws a plain description as its tooltip, from the words in describe.js, when its
 * label alone could be misread ("Reject", "Pause", "Clear it"). A button that already has a title, or whose
 * label is not in the list, is left as it is. The pages are built as HTML strings and drawn again often, so this
 * watches what is added instead of every string saying it. Pure lookup first (`tipFor`), then the watcher.
 */

/** The words on a button, without the dots of "Cancel the job…", the count of a tab or the key hint. */
export const labelOf = (el) => String(el?.textContent ?? '').replace(/\s+/g, ' ').replace(/[….]+$/, '').trim()

/** The description for a button by its label, or '' when its label says plainly what happens. */
export function tipFor(el) {
  if (!el || el.title || el.getAttribute?.('title')) return ''
  const label = labelOf(el)
  const has = (name) => el.classList?.contains(name)
  // Status words: a job's state, a bot's state, a finding's state.
  if (has('state') || has('stage')) return DESCRIBE.status[label] || ''
  if (has('chip') && [...el.classList].some((c) => c.startsWith('imp-'))) return DESCRIBE.finding[label] || ''
  if (has('pile')) return DESCRIBE.pile[labelOf(el.querySelector?.('span') || el)] || ''
  if (el.dataset?.act === 'improve-filter') return DESCRIBE.finding[label.replace(/\s+\d+$/, '')] || ''
  // Counters with no unit.
  if (has('mk-count')) return DESCRIBE.map.marks
  if (el.matches?.('[data-tab] > b')) return el.closest('[data-tab="attention"]') ? DESCRIBE.map.needs : DESCRIBE.map.open
  if (/^Talk to /.test(label)) return DESCRIBE.act['Talk to a bot']
  if (/^Send to /.test(label) && el.dataset?.act === 'improve-send') return DESCRIBE.act['Send to the lead']
  if (/^Send (it|all \d+)$/.test(label)) return DESCRIBE.act['Send the tray']
  if (el.dataset?.act === 'improve-ask') return DESCRIBE.act['Ask me']
  if (el.dataset?.act === 'improve-reject-open') return DESCRIBE.act['Reject finding']
  const act = el.dataset?.act
  if (act === 'trip-gate' && label === 'Approve') return DESCRIBE.act['Approve step']
  if (act === 'trip' && ['Pause', 'Resume', 'Stop'].includes(label)) return DESCRIBE.act[`${label} run`]
  if (act === 'routine' && ['Pause', 'Resume'].includes(label)) return DESCRIBE.act[`${label} routine`]
  return DESCRIBE.act[label] || ''
}

/** Describes every button in `root` (and `root` itself) that has no title yet. */
export function describeControls(root) {
  if (!root?.querySelectorAll) return
  const PICK = 'button, summary, .state, .stage, .chip, .mk-count, [data-tab] > b'
  const all = root.matches?.(PICK) ? [root, ...root.querySelectorAll(PICK)] : [...root.querySelectorAll(PICK)]
  for (const el of all) {
    const tip = tipFor(el)
    if (tip) el.setAttribute('title', tip)
  }
}

/** Describes what is on the page now and everything drawn into it later. Returns a function that stops. */
export function watchDescriptions(root = document.body) {
  describeControls(root)
  if (typeof MutationObserver === 'undefined') return () => {}
  const seen = new MutationObserver((changes) => {
    for (const change of changes) for (const node of change.addedNodes) if (node.nodeType === 1) describeControls(node)
  })
  seen.observe(root, { childList: true, subtree: true })
  return () => seen.disconnect()
}
