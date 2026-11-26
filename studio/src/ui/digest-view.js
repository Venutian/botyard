/**
 * The decision digest at the top of Needs you (docs/digest.md): five cards at most, the ones only the owner may
 * answer first. A default card says its answer and when that applies by itself; an answer already applied by
 * default has "Take back" while the engine can still undo it. Each card opens where it is answered: its job, or
 * the chat it was asked in. Built from the list's own parts (the card, the state word, the small button).
 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The digest as HTML, or '' when nothing waits and nothing can be taken back. */
export function digestHtml(digest) {
  if (!digest || (!digest.cards?.length && !digest.applied?.length)) return ''
  const open = (c) => (c.chat && c.botId ? `data-bot="${esc(c.botId)}"` : `data-line="${esc(c.jobId)}"`)
  const cards = (digest.cards || []).map((c) => `<button type="button" class="ask digest-card ${c.kind === 'must' ? 'wants' : 'read'}" ${open(c)}>
      <span class="kind"><span class="state ${c.kind === 'must' ? 'warn' : 'info'}">${c.kind === 'must' ? 'Only you' : 'Has a default'}</span>${c.count > 1 ? ` asked ${c.count} times` : ''}${c.job ? ` · ${esc(c.job)}` : ''}</span>
      <b>${esc(c.title)}</b>
      <small>${esc(c.line)}</small>
    </button>`).join('')
  const applied = (digest.applied || []).map((a) => `<div class="ask digest-card read applied">
      <span class="kind"><span class="state ok">Applied by default</span>${a.job ? ` · ${esc(a.job)}` : ''}</span>
      <b>${esc(a.title)}</b>
      <small>${esc(a.line)}</small>
      ${a.canReverse ? `<span class="sort"><button type="button" class="btn ghost small" data-act="digest-take-back" data-job="${esc(a.jobId)}" data-card-id="${esc(a.id)}" title="The question is open again and waits for your own answer; the bot is told">Take back</button></span>` : ''}
    </div>`).join('')
  const head = digest.cards?.length ? `<h3 class="digest-head">Your decisions${digest.notes ? `<small>${esc(digest.notes)}</small>` : ''}</h3>` : ''
  return `<section class="digest" aria-label="Your decisions">${head}${cards}${applied ? `<h3 class="digest-head">Decided for you</h3>${applied}` : ''}</section>`
}
