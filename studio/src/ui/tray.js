/**
 * The answer tray, in Needs you: answer several questions where they wait, and send them all at once.
 *
 * Each question card in Needs you has "Answer here". It opens the job's waiting questions in a small
 * sheet; the owner's answer is held in the tray (kept by the service, so the phone holds the same
 * tray) and the bots carry on meanwhile. At the top of Needs you the tray says how many answers are
 * held, and one press sends every one, each to the job that asked. A review whose marks are ready can
 * be held here too, from the review sheet. The Needs you count does not change until an answer is sent.
 */
import './tray.css'
import { esc } from './marks-core.js'

async function call(url, payload) {
  const res = await fetch(url, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `The service answered ${res.status}`)
  return out
}

let items = []
let loadedAt = 0
let dialog = null
let asked = null

/** The tray's own words: how many answers, reviews or both are held. */
export function trayWords(list) {
  const answers = list.filter((i) => i.kind !== 'review').length
  const reviews = list.length - answers
  const parts = [answers ? `${answers} answer${answers === 1 ? '' : 's'}` : '', reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : ''].filter(Boolean)
  return parts.length ? `${parts.join(' and ')} held` : ''
}

/** What one held item says in the tray. */
export function itemWords(i) {
  if (i.kind === 'review') return `${i.review?.marks?.length || 0} mark${i.review?.marks?.length === 1 ? '' : 's'}${i.review?.note ? ' and a note' : ''}`
  if (i.kind === 'accept') return 'Yes'
  if (i.kind === 'reject') return i.reason ? `No: ${i.reason}` : 'No'
  return i.said || 'Answered'
}

function trayHtml() {
  if (!items.length) return ''
  return `<section class="tray" aria-label="Answers held to send">
    <div class="tray-head"><b>${esc(trayWords(items))}</b><span>The bots carry on meanwhile; each goes to the job that asked.</span></div>
    <ul>${items.map((i) => `<li class="${i.error ? 'bad' : ''}"><span class="tray-what"><b>${esc(i.job || i.title)}</b><small>${esc(i.kind === 'review' ? 'Review' : i.title)}: ${esc(itemWords(i))}</small>${i.error ? `<small class="err">Not sent: ${esc(i.error)}</small>` : ''}</span>
      <button class="btn ghost small" data-act="tray-drop" data-key="${esc(i.key)}" aria-label="Take this out of the tray">Take out</button></li>`).join('')}</ul>
    <button class="btn primary tray-send" data-act="tray-send">Send ${items.length === 1 ? 'it' : `all ${items.length}`}</button>
  </section>`
}

function fill() {
  for (const slot of document.querySelectorAll('[data-part="tray"]')) {
    const html = trayHtml()
    if (slot.dataset.drawn !== html) { slot.innerHTML = html; slot.dataset.drawn = html }
  }
  for (const b of document.querySelectorAll('[data-act="tray-answer"]')) {
    const held = items.some((i) => (b.dataset.job && i.jobId === b.dataset.job) || (b.dataset.bot && i.botId === b.dataset.bot))
    const words = held ? 'Answer held ✓' : 'Answer here'
    if (b.textContent !== words) b.textContent = words
  }
}

async function load(force = false) {
  if (!force && Date.now() - loadedAt < 5000) return fill()
  loadedAt = Date.now()
  try { items = (await call('/api/studio/tray')).items || [] } catch { /* the tray shows what it last knew */ }
  fill()
}

export async function hold(item) {
  items = (await call('/api/studio/tray', { action: 'hold', item })).items || []
  loadedAt = Date.now()
  fill()
}

function toast(text, bad = false) {
  const el = document.createElement('div')
  el.className = `mk-toast${bad ? ' bad' : ''}`
  el.setAttribute('role', 'status')
  el.textContent = text
  ;(document.querySelector('.hud.studio') || document.body).append(el)
  setTimeout(() => el.remove(), 4200)
}

/** The answers a question form holds, the same way a card in a job is answered. */
export function answersOf(form, q) {
  const data = new FormData(form)
  const answers = q.items.map((item) => {
    const otherText = String(data.get(`${q.id}:${item.id}::other`) || '').trim()
    const optionIds = data.getAll(`${q.id}:${item.id}`).map(String)
    return { questionId: item.id, optionIds: otherText && !item.multiple ? [] : optionIds, ...(otherText ? { otherText } : {}) }
  })
  if (q.items.some((item, i) => (item.required || q.items.length === 1) && !answers[i].optionIds.length && !answers[i].otherText)) return null
  const said = q.items.map((item, i) => [...item.options.filter((o) => answers[i].optionIds.includes(o.id)).map((o) => o.label), answers[i].otherText].filter(Boolean).join(', ')).filter(Boolean).join('; ')
  return { answers, said }
}

function questionHtml(q) {
  if (q.kind === 'confirm') {
    return `<form class="tray-q" data-q="${esc(q.id)}"><p><b>${esc(q.title)}</b></p>${q.prompt ? `<p class="prompt">${esc(q.prompt)}</p>` : ''}
      <label class="stack">${q.stops ? `Why, if you choose “${esc(q.reject)}” (optional)` : q.tripId ? `What to change, if you choose “${esc(q.reject)}” (goes back with the work)` : 'Why, if no (optional)'}<textarea name="reason" rows="2" maxlength="4000"></textarea></label>
      <div class="row"><button class="btn primary" type="button" data-hold="accept">${esc(q.accept)}: hold</button><button class="btn" type="button" data-hold="reject">${esc(q.reject)}: hold</button></div></form>`
  }
  return `<form class="tray-q" data-q="${esc(q.id)}"><p><b>${esc(q.title)}</b></p>${q.items.map((item) => `
    <fieldset>${item.prompt && item.prompt !== q.title ? `<legend>${esc(item.prompt)}</legend>` : ''}
      ${item.options.map((o) => `<label><input type="${item.multiple ? 'checkbox' : 'radio'}" name="${esc(q.id)}:${esc(item.id)}" value="${esc(o.id)}"><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`).join('')}
      <label class="other"><span><b>${item.options.length ? 'Other' : 'Your answer'}</b></span><textarea name="${esc(q.id)}:${esc(item.id)}::other" rows="2"></textarea></label>
    </fieldset>`).join('')}
    <div class="row"><button class="btn primary" type="button" data-hold="answer">Hold this answer</button></div></form>`
}

async function openAnswer({ job = '', bot = '', title = '' }) {
  if (!dialog) {
    dialog = document.createElement('div')
    dialog.className = 'mk-sheet tray-sheet'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'tray-title')
    dialog.addEventListener('click', onDialog)
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAnswer() } })
  }
  ;(document.querySelector('.hud.studio') || document.body).append(dialog)
  dialog.hidden = false
  dialog.innerHTML = `<div class="tray-frame"><header class="mk-head"><div><span class="mk-kicker">Answer here</span><h2 id="tray-title">${esc(title || 'A question')}</h2><p class="mk-sub">Reading the question…</p></div>
    <button type="button" class="btn icon ghost" data-tray="close" aria-label="Close">×</button></header><div class="tray-body"></div></div>`
  try {
    asked = { ...(await call(`/api/studio/tray/questions?${bot ? `bot=${encodeURIComponent(bot)}` : `job=${encodeURIComponent(job)}`}`)), botId: bot }
    dialog.querySelector('.mk-sub').textContent = `${asked.job}. Held answers go together from the tray at the top of Needs you.`
    const review = `<p class="hint">Something to point at instead? <button class="link" type="button" data-act="review" data-job="${esc(asked.jobId)}">Mark exact places…</button></p>`
    dialog.querySelector('.tray-body').innerHTML = (asked.questions.length ? asked.questions.map(questionHtml).join('') : '<p class="mk-none">Nothing waits on this job any more.</p>') + review
    dialog.querySelector('input, textarea, button[data-hold]')?.focus()
  } catch (err) {
    dialog.querySelector('.mk-sub').textContent = err.message
  }
}

function closeAnswer() { if (dialog) dialog.hidden = true }

async function onDialog(e) {
  if (e.target.closest('[data-tray="close"]') || e.target === dialog) return closeAnswer()
  if (e.target.closest('[data-act="review"]')) return closeAnswer()
  const button = e.target.closest('[data-hold]')
  if (!button) return
  const form = button.closest('form')
  const q = asked.questions.find((x) => x.id === form.dataset.q)
  const kind = button.dataset.hold
  const base = { jobId: asked.jobId, cardId: q.id, title: q.title, job: asked.job, ...(asked.botId ? { botId: asked.botId } : {}), ...(q.tripId ? { tripId: q.tripId } : {}), ...(q.stops ? { stops: true } : {}) }
  let item
  if (kind === 'answer') {
    const got = answersOf(form, q)
    if (!got) { toast('Pick an answer, or write your own', true); return }
    item = { ...base, kind: 'answer', ...got }
  } else item = { ...base, kind, reason: String(new FormData(form).get('reason') || '').trim() }
  try {
    await hold(item)
    form.outerHTML = `<p class="tray-held">Held: <b>${esc(q.title)}</b>, ${esc(itemWords(item))}.</p>`
    if (!dialog.querySelector('form.tray-q')) setTimeout(closeAnswer, 600)
  } catch (err) { toast(err.message, true) }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest?.('[data-act="tray-answer"], [data-act="tray-send"], [data-act="tray-drop"]')
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  const act = el.dataset.act
  if (act === 'tray-answer') return openAnswer({ job: el.dataset.job || '', bot: el.dataset.bot || '', title: el.dataset.title || '' })
  if (act === 'tray-drop') {
    items = (await call('/api/studio/tray', { action: 'drop', key: el.dataset.key })).items || []
    return fill()
  }
  el.disabled = true
  el.textContent = 'Sending…'
  try {
    const out = await call('/api/studio/tray', { action: 'send' })
    items = out.items || []
    toast(out.failed ? `${out.sent} sent; ${out.failed} did not go and ${out.failed === 1 ? 'stays' : 'stay'} in the tray` : `${out.sent} sent, each to the job that asked`, Boolean(out.failed))
  } catch (err) { toast(err.message, true) }
  loadedAt = Date.now()
  fill()
  // Needs you reads the cards again, so the ones answered leave the list and the count.
  window.botyardStudio?.refreshNeeds?.()
}, true)

// Needs you is drawn again on every change: the tray is put back into its slot each time, once a frame at most.
let queued = false
new MutationObserver(() => {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; if (document.querySelector('[data-part="tray"]:not([data-drawn]), [data-act="tray-answer"]')) load() })
}).observe(document.documentElement, { childList: true, subtree: true })

window.botyardTray = { hold, load: () => load(true) }
