/**
 * The kept record: every piece the owner approved or sent back, with its marks, read-only. Opened
 * for one job (from its sheet) or one project (from its page), newest first; each review shows the
 * words the bot was sent and the cut copies that went with them.
 */
import { esc } from './marks-core.js'

const VERDICT = { back: 'Sent back', context: 'Sent back to run again', approve: 'Approved', note: 'Noted' }
let sheet = null

async function call(url) {
  const res = await fetch(url)
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `The service answered ${res.status}`)
  return out
}

const when = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }

/** One kept review, folded: what, when, how it went; open, the words as sent and the cut copies. */
export function reviewHtml(r) {
  const n = r.marks?.length || 0
  const verdict = `${VERDICT[r.verdict] || r.verdict}${r.gate ? ' at a gate' : ''}`
  return `<details class="rec"><summary><span class="rec-verdict ${esc(r.verdict)}">${esc(verdict)}</span><b>${esc(r.jobRef ? `${r.jobRef} · ` : '')}${esc(r.piece?.title || '')}</b><small>${n} mark${n === 1 ? '' : 's'} · ${esc(when(r.createdAt))}</small></summary>
    ${r.cuts?.length ? `<div class="rec-cuts">${r.cuts.map((id) => `<a class="view-img" href="/api/studio/file?id=${esc(id)}" target="_blank" rel="noopener" data-name="cut copy"><img src="/api/studio/file?id=${esc(id)}" alt="A marked place, cut out" loading="lazy"></a>`).join('')}</div>` : ''}
    <pre class="rec-text">${esc(r.text)}</pre></details>`
}

async function openRecord({ job = '', project = '', title = '' }) {
  if (!sheet) {
    sheet = document.createElement('div')
    sheet.className = 'mk-sheet tray-sheet rec-sheet'
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    sheet.setAttribute('aria-labelledby', 'rec-title')
    sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-rec="close"]')) sheet.hidden = true })
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); sheet.hidden = true } })
  }
  ;(document.querySelector('.hud.studio') || document.body).append(sheet)
  sheet.hidden = false
  sheet.innerHTML = `<div class="tray-frame"><header class="mk-head"><div><span class="mk-kicker">Kept</span><h2 id="rec-title">Reviews${title ? `: ${esc(title)}` : ''}</h2><p class="mk-sub">Every piece approved or sent back, with its marks, as the bot was sent it. Read only.</p></div>
    <button type="button" class="btn icon ghost" data-rec="close" aria-label="Close">×</button></header><div class="tray-body"><p class="mk-none">Reading…</p></div></div>`
  sheet.querySelector('[data-rec="close"]').focus()
  try {
    const { reviews } = await call(`/api/studio/marks?${job ? `job=${encodeURIComponent(job)}` : `project=${encodeURIComponent(project)}`}`)
    sheet.querySelector('.tray-body').innerHTML = reviews.length ? reviews.map(reviewHtml).join('') : '<p class="mk-none">Nothing kept yet: a review sent or approved from the review sheet is kept here.</p>'
  } catch (err) {
    sheet.querySelector('.tray-body').innerHTML = `<p class="mk-none">${esc(err.message)}</p>`
  }
}

if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-act="reviews"]')
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  openRecord({ job: el.dataset.job || '', project: el.dataset.project || '', title: el.dataset.title || '' })
}, true)
