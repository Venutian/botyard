/**
 * The review sheet: the owner marks exact places in what a bot made, and sends every mark at once.
 *
 * Opened from any job or chat (`[data-act="review"]` with `data-job` or `data-bot`, or
 * `window.botyardMarks.open(...)`), it shows the bot's last message first and, down the left, every
 * other piece of the job that can be marked: earlier messages, the brief, documents, pictures, and
 * (where the job has a branch) its change, read in chapters. On text the owner selects words or
 * lines and leaves a comment; on a picture they tap a point or drag a box. Marks from several pieces
 * gather on the right and go with one press, as one message to the bot (or as the answer to the gate
 * a trip waits at). Marks not yet sent are kept in this browser until they are.
 */
import './marks.css'
import { boxFrom, esc, linesHtml, markWhere, payloadOf, selectionIn } from './marks-core.js'
export { esc }

const ICON = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
}
const KEEP = 'botyard.marks.'

async function call(url, payload) {
  const res = await fetch(url, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `The service answered ${res.status}`)
  return out
}

const post = (url, body) => call(url, body)

const kept = {
  read(id) { try { return JSON.parse(localStorage.getItem(KEEP + id) || 'null') } catch { return null } },
  write(id, value) { try { if (value?.marks?.length || value?.note) localStorage.setItem(KEEP + id, JSON.stringify(value)); else localStorage.removeItem(KEEP + id) } catch { /* private window: drafts live only while the sheet is open */ } },
}

let sheet = null
let state = null
let host = null
const renderers = {}

/** Other parts (the change, a live page) add the way their piece is drawn and marked. */
export function addPieceKind(kind, renderer) { renderers[kind] = renderer }

function build() {
  sheet = document.createElement('div')
  sheet.className = 'mk-sheet'
  sheet.hidden = true
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-labelledby', 'mk-title')
  sheet.innerHTML = `<div class="mk-frame">
    <header class="mk-head"><div><span class="mk-kicker">Review</span><h2 id="mk-title"></h2><p class="mk-sub"></p></div>
      <button type="button" class="btn icon ghost" data-mk="close" title="Close (Esc)" aria-label="Close">${ICON.close}</button></header>
    <nav class="mk-pieces" aria-label="What to review"></nav>
    <main class="mk-piece" tabindex="-1"></main>
    <aside class="mk-tray" aria-label="Your marks"></aside>
    <div class="mk-ask" hidden></div>
  </div>`
  sheet.addEventListener('click', onClick)
  sheet.addEventListener('input', onInput)
  sheet.addEventListener('keydown', onKey)
  sheet.addEventListener('mouseup', () => setTimeout(offerTextMark, 0))
  sheet.addEventListener('touchend', () => setTimeout(offerTextMark, 350))
  document.addEventListener('selectionchange', () => { if (state && !sheet.hidden && window.matchMedia('(pointer: coarse)').matches) clearTimeout(state.selTimer), state.selTimer = setTimeout(offerTextMark, 500) })
  ;(document.querySelector('.hud.studio') || document.body).append(sheet)
}

function save() { if (state) kept.write(state.jobId, { marks: state.marks, note: state.note }) }

export async function open({ job = '', bot = '', piece = '', onSend = null } = {}) {
  if (!sheet) build()
  if (!sheet.isConnected) (document.querySelector('.hud.studio') || document.body).append(sheet)
  host = document.activeElement
  sheet.hidden = false
  document.documentElement.classList.add('mk-open')
  sheet.querySelector('#mk-title').textContent = 'Opening…'
  sheet.querySelector('.mk-sub').textContent = ''
  sheet.querySelector('.mk-pieces').innerHTML = ''
  sheet.querySelector('.mk-tray').innerHTML = ''
  sheet.querySelector('.mk-piece').innerHTML = '<p class="mk-none">Reading the job…</p>'
  try {
    const src = await call(`/api/studio/marks/sources?${bot ? `bot=${encodeURIComponent(bot)}` : `job=${encodeURIComponent(job)}`}`)
    const draft = kept.read(src.jobId) || {}
    state = { ...src, marks: (draft.marks || []).filter((m) => src.pieces.some((p) => p.id === m.pieceId)), note: draft.note || '', current: piece || src.pieces[0]?.id || '', pending: null, onSend, next: 1 }
    state.next = Math.max(0, ...state.marks.map((m) => m.n || 0)) + 1
    sheet.querySelector('#mk-title').textContent = `${src.ref ? `${src.ref} ` : ''}${src.chat ? `Chat with ${src.bot}` : src.title}`
    sheet.querySelector('.mk-sub').textContent = src.gate ? `Waiting at "${src.gate.title}": your marks are the answer` : src.bot ? `Marks go to ${src.bot} as one message` : ''
    draw()
    sheet.querySelector('.mk-piece').focus({ preventScroll: true })
  } catch (err) {
    sheet.querySelector('#mk-title').textContent = 'Review'
    sheet.querySelector('.mk-piece').innerHTML = `<p class="mk-none">${esc(err.message)}</p>`
  }
}

export function close({ force = false } = {}) {
  if (!sheet || sheet.hidden) return false
  if (state?.pending && !force) { state.pending = null; drawAsk(); return true }
  save()
  sheet.hidden = true
  document.documentElement.classList.remove('mk-open')
  state = null
  host?.focus?.({ preventScroll: true })
  return true
}

function draw() {
  drawPieces()
  drawPiece()
  drawTray()
  drawAsk()
}

function drawPieces() {
  const counts = new Map()
  for (const m of state.marks) counts.set(m.pieceId, (counts.get(m.pieceId) || 0) + 1)
  const group = (kind) => ({ message: 'Messages', brief: 'The job', document: 'Documents', picture: 'Pictures', change: 'The change', page: 'A live page' })[kind] || 'Other'
  let last = ''
  sheet.querySelector('.mk-pieces').innerHTML = state.pieces.length
    ? state.pieces.map((p) => {
      const g = group(p.kind)
      const head = g !== last ? `<p class="mk-group">${g}</p>` : ''
      last = g
      const n = counts.get(p.id)
      return `${head}<button type="button" class="mk-pick${p.id === state.current ? ' on' : ''}" data-mk="piece" data-id="${esc(p.id)}" aria-current="${p.id === state.current}"><span>${esc(p.title)}</span>${n ? `<b class="mk-count" aria-label="${n} marks">${n}</b>` : ''}</button>`
    }).join('')
    : '<p class="mk-none">Nothing to review on this job yet.</p>'
  // On a narrow screen the pieces are a strip: the one being read is brought into view.
  const on = sheet.querySelector('.mk-pick.on')
  if (on && window.matchMedia('(max-width: 760px)').matches) on.scrollIntoView({ inline: 'center', block: 'nearest' })
}

function drawPiece() {
  const box = sheet.querySelector('.mk-piece')
  const p = state.pieces.find((x) => x.id === state.current)
  if (!p) { box.innerHTML = '<p class="mk-none">Nothing here yet: once the bot has said or made something, it can be marked.</p>'; return }
  const mine = state.marks.filter((m) => m.pieceId === p.id)
  if (renderers[p.kind]) return renderers[p.kind].draw(box, p, mine, api)
  if (p.kind === 'picture') {
    box.innerHTML = `<p class="mk-hint">Tap a point or drag a box on the picture, then say what to change there.</p>
      <div class="mk-stage"><img src="${esc(p.src)}" alt="${esc(p.title)}" draggable="false">${mine.map((m) => pinHtml(m)).join('')}${state.pending?.pieceId === p.id && state.pending.box ? pinHtml({ ...state.pending, n: '' }, true) : ''}</div>`
    const stage = box.querySelector('.mk-stage')
    stage.addEventListener('pointerdown', (e) => startBox(e, stage, p))
    return
  }
  const marked = new Map()
  for (const m of mine) for (let n = m.line; n <= (m.lineEnd || m.line); n++) marked.set(n, [...(marked.get(n) || []), m.n])
  box.innerHTML = `<p class="mk-hint">Select words or whole lines, then say what to change there.</p><div class="mk-text-body" data-piece="${esc(p.id)}">${linesHtml(p.text, marked)}</div>`
}

const pinHtml = (m, pending = false) => {
  const b = m.box
  const point = !(b.w || b.h)
  const style = point ? `left:${b.x * 100}%;top:${b.y * 100}%` : `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`
  return `<span class="mk-spot ${point ? 'point' : 'box'}${pending ? ' pending' : ''}" style="${style}"><b>${esc(m.n)}</b></span>`
}

function startBox(e, stage, p) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  const img = stage.querySelector('img')
  const rect = img.getBoundingClientRect()
  const from = { x: e.clientX, y: e.clientY }
  e.preventDefault()
  stage.setPointerCapture?.(e.pointerId)
  let ghost = stage.querySelector('.mk-spot.drawing')
  const move = (ev) => {
    const b = boxFrom(from, { x: ev.clientX, y: ev.clientY }, rect)
    if (!ghost) { ghost = document.createElement('span'); ghost.className = 'mk-spot box pending drawing'; stage.append(ghost) }
    Object.assign(ghost.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` })
  }
  const up = (ev) => {
    stage.removeEventListener('pointermove', move)
    stage.removeEventListener('pointerup', up)
    stage.removeEventListener('pointercancel', up)
    ghost?.remove()
    const box = boxFrom(from, { x: ev.clientX, y: ev.clientY }, rect)
    state.pending = { kind: 'picture', pieceId: p.id, box, where: box.w || box.h ? 'a box on the picture' : 'a point on the picture' }
    drawPiece()
    // The plate opens just under the spot, not at the picture's corner.
    drawAsk({ left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height, bottom: rect.top + (box.y + box.h) * rect.height })
  }
  stage.addEventListener('pointermove', move)
  stage.addEventListener('pointerup', up)
  stage.addEventListener('pointercancel', up)
}

function offerTextMark() {
  if (!state || sheet.hidden) return
  // A piece drawn by its own kind (the change) offers its own marks.
  const body = sheet.querySelector('.mk-text-body[data-piece]')
  if (!body) return
  const found = selectionIn(body)
  if (!found) return
  const p = state.pieces.find((x) => x.id === body.dataset.piece)
  state.pending = { kind: 'text', pieceId: p.id, quote: found.quote, line: found.line, lineEnd: found.lineEnd, where: markWhere({ kind: 'text', ...found }) }
  drawAsk(found.rect)
}

/** The small plate where a new mark's comment is written. */
function drawAsk(rect = null) {
  const ask = sheet.querySelector('.mk-ask')
  const p = state?.pending
  if (!p) { ask.hidden = true; ask.innerHTML = ''; return }
  ask.innerHTML = `<p class="mk-ask-where">${ICON.pin}<span>Mark ${state.next}: ${esc(p.where)}</span></p>
    ${p.quote ? `<blockquote>${esc(p.quote.length > 220 ? `${p.quote.slice(0, 219)}…` : p.quote)}</blockquote>` : ''}
    <label class="mk-label" for="mk-new">What should change here?</label>
    <textarea id="mk-new" rows="3" placeholder="Say what is wrong and what you want instead"></textarea>
    <div class="mk-acts"><button type="button" class="btn ghost" data-mk="ask-cancel">Cancel</button><button type="button" class="btn primary" data-mk="ask-add">Add mark</button></div>`
  ask.hidden = false
  const frame = sheet.querySelector('.mk-frame').getBoundingClientRect()
  if (rect && window.innerWidth > 760) {
    const top = Math.min(frame.bottom - 230, Math.max(frame.top + 70, rect.bottom + 8))
    const left = Math.min(frame.right - 380, Math.max(frame.left + 12, rect.left))
    Object.assign(ask.style, { top: `${top - frame.top}px`, left: `${left - frame.left}px` })
  } else Object.assign(ask.style, { top: '', left: '' })
  // A pick inside a live page leaves the keys with that page's frame: take them back first.
  window.focus()
  ask.querySelector('textarea').focus({ preventScroll: true })
}

function addPending() {
  const text = sheet.querySelector('#mk-new')?.value.trim()
  if (!state.pending || !text) { sheet.querySelector('#mk-new')?.focus(); return }
  const mark = { ...state.pending, n: state.next++, comment: text }
  state.marks.push(mark)
  state.pending = null
  // A mark on a live page takes its screenshot now, at the owner's size and scroll; the send waits for it.
  if (mark.kind === 'page' && mark.look && !mark.shotId) {
    state.shots = state.shots || []
    state.shots.push(post('/api/studio/look/shot', { job: state.jobId, ...mark.look }).then((shot) => { mark.shotId = shot.id; save() }).catch((err) => { mark.shotWhy = err.message; toast(`No screenshot: ${err.message}`, true) }))
  }
  window.getSelection()?.removeAllRanges()
  save()
  draw()
}

function drawTray() {
  const gate = state.gate
  const marks = state.marks
  const pieceTitle = (id) => state.pieces.find((p) => p.id === id)?.title || ''
  const items = marks.map((m) => `<li class="mk-mark" data-n="${m.n}">
      <div class="mk-mark-head"><b class="mk-num">${m.n}</b><button type="button" class="mk-goto" data-mk="goto" data-n="${m.n}"><b>${esc(markWhere(m))}</b> · ${esc(pieceTitle(m.pieceId))}</button>
      <button type="button" class="btn icon ghost small" data-mk="drop" data-n="${m.n}" title="Remove this mark" aria-label="Remove mark ${m.n}">${ICON.close}</button></div>
      ${m.quote ? `<blockquote>${esc(m.quote.length > 160 ? `${m.quote.slice(0, 159)}…` : m.quote)}</blockquote>` : ''}
      <textarea rows="2" data-mk="comment" data-n="${m.n}" aria-label="Comment on mark ${m.n}">${esc(m.comment)}</textarea></li>`).join('')
  const backTo = gate?.before?.length > 1
    ? `<label class="mk-label" for="mk-to">Send the work back to</label><select id="mk-to">${gate.before.map((s, i) => `<option value="${esc(s.id)}" ${i === gate.before.length - 1 ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>`
    : ''
  sheet.querySelector('.mk-tray').innerHTML = `<h3>Your marks <span>${marks.length}</span></h3>
    ${marks.length ? `<ol class="mk-marks">${items}</ol>` : '<p class="mk-none small">No marks yet. Select words, or tap a picture, to leave one.</p>'}
    <label class="mk-label" for="mk-note">Anything else</label>
    <textarea id="mk-note" rows="3" data-mk="note" placeholder="A word about the whole piece (optional)">${esc(state.note)}</textarea>
    ${backTo}
    <div class="mk-send">
      <button type="button" class="btn primary" data-mk="send" data-verdict="back" ${marks.length || state.note.trim() ? '' : 'disabled'}>${gate ? 'Send back with marks' : `Send to ${esc(state.bot || 'the bot')}`}</button>
      <button type="button" class="btn ghost" data-mk="send" data-verdict="approve">${gate ? 'Approve' : 'Approve and keep'}</button>
      ${gate ? '' : `<button type="button" class="btn ghost" data-mk="hold" ${marks.length || state.note.trim() ? '' : 'disabled'} title="Keep it in the tray in Needs you, to send with your other answers">Hold in the tray</button>`}
    </div>
    <p class="mk-foot">${marks.length ? `${marks.length} mark${marks.length === 1 ? '' : 's'} ${marks.length === 1 ? 'goes' : 'go'} as one message.` : ''} Ctrl+Enter sends.</p>`
}

async function send(verdict) {
  if (state.pending) addPending()
  if (state.shots?.length) await Promise.all(state.shots)
  const to = sheet.querySelector('#mk-to')?.value || ''
  const body = payloadOf(state, verdict, to)
  const button = sheet.querySelector(`[data-mk="send"][data-verdict="${verdict}"]`)
  for (const b of sheet.querySelectorAll('[data-mk="send"]')) b.disabled = true
  if (button) button.textContent = 'Sending…'
  try {
    const review = await call('/api/studio/marks', body)
    kept.write(state.jobId, null)
    state.marks = []
    state.note = ''
    const done = state.onSend
    close({ force: true })
    toast(verdict === 'approve' ? 'Approved and kept' : `Sent: ${review.marks?.length || 0} mark${review.marks?.length === 1 ? '' : 's'} in one message`)
    done?.(review)
    window.botyardStudio?.refreshNeeds?.()
  } catch (err) {
    toast(err.message, true)
    drawTray()
  }
}

/** Keep the review in the tray in Needs you, to go with the owner's other answers in one press. */
async function holdReview() {
  if (state.pending) addPending()
  if (state.shots?.length) await Promise.all(state.shots)
  try {
    await window.botyardTray.hold({ kind: 'review', jobId: state.jobId, title: 'Your review', job: `${state.ref ? `${state.ref} ` : ''}${state.title}`.trim(), review: payloadOf(state, 'back') })
    kept.write(state.jobId, null)
    state.marks = []
    state.note = ''
    close({ force: true })
    toast('Held in the tray in Needs you')
  } catch (err) { toast(err.message, true) }
}

function toast(text, bad = false) {
  const el = document.createElement('div')
  el.className = `mk-toast${bad ? ' bad' : ''}`
  el.setAttribute('role', 'status')
  el.textContent = text
  ;(document.querySelector('.hud.studio') || document.body).append(el)
  setTimeout(() => el.remove(), 4200)
}

function onClick(e) {
  const el = e.target.closest('[data-mk]')
  if (!el) return
  const act = el.dataset.mk
  if (act === 'close') return close({ force: true })
  if (act === 'piece') { state.current = el.dataset.id; state.pending = null; draw(); return }
  if (act === 'ask-cancel') { state.pending = null; window.getSelection()?.removeAllRanges(); drawPiece(); drawAsk(); return }
  if (act === 'ask-add') return addPending()
  if (act === 'drop') { state.marks = state.marks.filter((m) => m.n !== Number(el.dataset.n)); save(); draw(); return }
  if (act === 'goto') {
    const m = state.marks.find((x) => x.n === Number(el.dataset.n))
    if (!m) return
    state.current = m.pieceId
    draw()
    sheet.querySelector(`.mk-line[data-n="${m.line}"]`)?.scrollIntoView({ block: 'center' })
    return
  }
  if (act === 'send') return send(el.dataset.verdict)
  if (act === 'hold') return holdReview()
}

function onInput(e) {
  const el = e.target
  if (el.dataset.mk === 'comment') {
    const m = state.marks.find((x) => x.n === Number(el.dataset.n))
    if (m) { m.comment = el.value; save() }
  }
  if (el.dataset.mk === 'note') {
    state.note = el.value
    save()
    const b = sheet.querySelector('[data-mk="send"][data-verdict="back"]')
    if (b) b.disabled = !(state.marks.length || state.note.trim())
  }
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (state?.pending) addPending(); else if (state && (state.marks.length || state.note.trim())) send('back'); return }
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'mk-new') { e.preventDefault(); addPending() }
}

/** For the parts that draw their own pieces (the change, a live page). */
const api = {
  esc,
  toast,
  linesHtml,
  pending(mark, rect) { state.pending = mark; drawAsk(rect) },
  get state() { return state },
}

// Any `[data-act="review"]` on the page opens the sheet for its job or bot.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-act="review"]')
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  open({ job: el.dataset.job || '', bot: el.dataset.bot || '', piece: el.dataset.piece || '' })
}, true)

window.botyardMarks = { open, close, addPieceKind }
