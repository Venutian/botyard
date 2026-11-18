import { DESCRIBE } from './describe.js'
import { markdown } from './markdown.js'
import { BrainField, DAY_INKS, INKS } from './brain-field.js'

/**
 * Engram, the Brain view: the owner's notes vault as a brain. Each note is a neuron that glows in its area's
 * colour, each area a lobe, each `[[link]]` a fibre; a superseded note is ash with a fibre to what replaced
 * it, and the newest decisions are white-hot. Drag to turn it, scroll to come closer, click a neuron to read
 * the note. The timeline shows the brain as it stood on a past day; the search lights what matches. The List
 * says the same in words, for the keyboard and a screen reader.
 *
 * The owner can edit a note's text or start a new one (in inbox/) from here; bots never can, and nothing is deleted. While open it turns and its signals run; after five minutes with no
 * hand on it, it goes to sleep and the page returns to the yard (the owner's rule, 18 Nov 2026).
 */
const IDLE_MS = 5 * 60 * 1000

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const DAY_MS = 86400000
const dayOf = (iso) => Date.parse(`${iso}T12:00:00Z`)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const said = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
const short = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
const KIND_WORD = { decision: 'Decision', preference: 'Preference', fact: 'Fact', inbox: 'Inbox note', note: 'Note' }
const CLOSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>'

/** What the picture is drawn from. */
const keyOf = (brain) => JSON.stringify([brain.folder, brain.notes.map((n) => [n.id, n.date, n.status, n.area, n.links, n.supersededBy, n.pinned, n.title]), brain.areas])

export function noteSentence(n, areaName) {
  const bits = [`${KIND_WORD[n.kind] || 'Note'}: ${n.title}.`, `${areaName}, ${said(dayOf(n.date))}.`]
  if (n.status === 'superseded') bits.push('Superseded.')
  if (n.pinned) bits.push('In the index.')
  if (n.imported) bits.push('Imported, waiting for review.')
  if (n.links.length) bits.push(`Links to ${plural(n.links.length, 'note')}.`)
  return bits.join(' ')
}

/** Notes that match the search: every word in the title, the area, the tags or the first line. */
export function matches(notes, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return new Set(notes.filter((n) => { const hay = `${n.title} ${n.area} ${n.tags.join(' ')} ${n.excerpt} ${n.id}`.toLowerCase(); return words.every((w) => hay.includes(w)) }).map((n) => n.id))
}

export class BrainMap {
  /**
   * @param {HTMLElement} host where the view sits
   * @param {{ sleep?: () => void }} [acts] `sleep`: Engram has been left alone long enough; the page goes back to the yard
   */
  constructor(host, acts = {}) {
    this.acts = acts
    this.el = document.createElement('section')
    this.el.className = 'brainmap'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Engram')
    this.el.innerHTML = `<div class="bm-bar">
        <h1 class="bm-title">Engram</h1>
        <p class="bm-sub"></p>
        <label class="bm-find"><span class="visually-hidden">Search the notes</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 11.2L14.5 14.5M12.4 7a5.4 5.4 0 1 1-10.8 0a5.4 5.4 0 1 1 10.8 0"/></svg><input type="search" placeholder="Search the notes" autocomplete="off" spellcheck="false"></label>
        <button type="button" class="bm-new" data-act="new-note">New note</button>
        <div class="bm-seg" role="group" aria-label="Show as"><button type="button" data-mode="field" title="${DESCRIBE.brain.field}" aria-pressed="true">Brain</button><button type="button" data-mode="list" title="${DESCRIBE.brain.list}" aria-pressed="false">List</button></div>
        <p class="bm-said" role="status" aria-live="polite"></p>
      </div>
      <div class="bm-stage"><div class="bm-tip" hidden></div><p class="bm-hint">Drag to turn, scroll to come closer, click a neuron to read it.</p></div>
      <div class="bm-list" hidden></div>
      <div class="bm-time">
        <div class="bm-hist" aria-hidden="true"></div>
        <input class="bm-scrub" type="range" min="0" max="1" step="1" value="1" aria-label="Show the brain as it stood on">
        <div class="bm-ticks" aria-hidden="true"></div>
      </div>
      <div class="bm-legend" aria-label="What the light means">
        <span><i class="lg dec"></i>Decision</span><span><i class="lg pref"></i>Preference</span><span><i class="lg fact"></i>Fact or note</span>
        <span><i class="lg hot"></i>New in the last 3 days</span><span><i class="lg ash"></i>Superseded, with a fibre to what replaced it</span>
        <span><i class="lg ring"></i>Imported, to review</span><span><i class="lg fib"></i>A link between notes</span>
      </div>
      <aside class="bm-note panel" hidden aria-label="Note"></aside>
      <div class="bm-empty" hidden></div>`
    host.prepend(this.el)
    this.stage = this.el.querySelector('.bm-stage')
    this.list = this.el.querySelector('.bm-list')
    this.tip = this.el.querySelector('.bm-tip')
    this.note = this.el.querySelector('.bm-note')
    this.said = this.el.querySelector('.bm-said')
    this.sub = this.el.querySelector('.bm-sub')
    this.find = this.el.querySelector('.bm-find input')
    this.scrub = this.el.querySelector('.bm-scrub')
    this.empty = this.el.querySelector('.bm-empty')
    this.brain = null
    this.key = ''
    this.chosen = ''
    this.focusArea = ''
    this.query = ''
    this.asOf = Infinity
    this.mode = 'field'
    this.on = false
    this.field = null
    this.find.addEventListener('input', () => { this.query = this.find.value; this._draw() })
    this.find.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const hit = [...(matches(this._visible(), this.query) || [])].at(-1)
      if (hit) this.open(hit)
    })
    this.scrub.addEventListener('input', () => { this.asOf = Number(this.scrub.value) >= Number(this.scrub.max) ? Infinity : this._from + Number(this.scrub.value) * DAY_MS; this._draw() })
    this.el.addEventListener('click', (e) => this._click(e))
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.note.hidden) { e.stopPropagation(); this.close() } })
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'input']) this.el.addEventListener(type, () => this._awake(), { passive: true })
  }

  /** The field is made the first time it is shown: a page that never opens Engram makes no WebGL. */
  _field() {
    if (this.field) return this.field
    try {
      this.field = new BrainField(this.stage, {
        pick: (id) => this.open(id),
        hover: (id, x, y) => this._hover(id, x, y),
      })
      // Day or night follows the page's plates, now and whenever they are switched.
      const page = this.el.closest('[data-plates]') || document.querySelector('.hud.studio')
      const follow = () => this.field?.setTheme(this._night())
      follow()
      if (page) new MutationObserver(follow).observe(page, { attributes: true, attributeFilter: ['data-plates'] })
    } catch {
      this.field = null
      this.mode = 'list'
      this._syncMode()
    }
    return this.field
  }

  /** Any hand on Engram keeps it awake for five more minutes. */
  _awake() {
    clearTimeout(this._idle)
    if (this.on) this._idle = setTimeout(() => this.acts.sleep?.(), IDLE_MS)
  }

  _night() {
    return (this.el.closest('[data-plates]') || document.querySelector('.hud.studio'))?.dataset.plates === 'night'
  }

  /** The area inks for the page around the field: deep by day, light by night. */
  _inks() {
    return this._night() ? INKS : DAY_INKS
  }

  show(on) {
    this.on = on
    this.el.hidden = !on
    this._awake()
    if (on) { this._field()?.show(this.mode === 'field'); this.refresh() } else this.field?.show(false)
  }

  /** Ask for the notes again; drawn only if something in them changed. */
  async refresh() {
    if (!this.on || this._asking) return
    this._asking = true
    try {
      const res = await fetch('/api/studio/brain', { headers: { accept: 'application/json' } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `The notes answered ${res.status}`)
      this.setBrain(body)
    } catch (err) {
      if (!this.brain) this._empty(`The notes could not be read: ${err.message}`)
    } finally {
      this._asking = false
    }
  }

  setBrain(brain) {
    if (!brain?.on) { this.brain = null; this.key = ''; return this._empty(brain?.why || 'No notes folder is set.', true) }
    const key = keyOf(brain)
    this.brain = brain
    this.empty.hidden = true
    if (key === this.key) return
    this.key = key
    this._from = dayOf(brain.from)
    const days = Math.max(1, Math.round((dayOf(brain.to) - this._from) / DAY_MS))
    const atEnd = Number(this.scrub.value) >= Number(this.scrub.max)
    this.scrub.max = String(days)
    if (atEnd) this.scrub.value = String(days)
    this.sub.textContent = `${plural(brain.notes.length, 'note')} in ${brain.name}, ${short(dayOf(brain.from))} to ${short(dayOf(brain.to))}`
    this._timeline()
    this._field()?.setBrain(brain)
    this._draw()
    if (this.chosen && !brain.notes.some((n) => n.id === this.chosen)) this.close()
  }

  _empty(why, canSet = false) {
    this.empty.hidden = false
    this.empty.innerHTML = `<h2>Your notes go here</h2><p>${esc(why)}</p>${canSet ? `<p>Engram reads any folder of markdown notes, such as an Obsidian vault. It only reads; you edit the notes in their files.</p>
      <form class="bm-set"><label>Notes folder <input name="folder" placeholder="~/Documents/notes" required></label><button type="submit">Read this folder</button></form><p class="bm-set-said" role="status"></p>` : ''}`
    this.empty.querySelector('form')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const out = this.empty.querySelector('.bm-set-said')
      const res = await fetch('/api/studio/brain/folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: e.target.folder.value }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { out.textContent = body.error || 'That folder could not be used.'; return }
      out.textContent = 'Reading the notes.'
      this.refresh()
    })
  }

  /** The notes as they stood on the chosen day. */
  _visible() {
    if (!this.brain) return []
    return this.asOf === Infinity ? this.brain.notes : this.brain.notes.filter((n) => dayOf(n.date) <= this.asOf)
  }

  _timeline() {
    const days = Number(this.scrub.max)
    const count = new Array(days + 1).fill(0)
    for (const n of this.brain.notes) count[Math.max(0, Math.min(days, Math.round((dayOf(n.date) - this._from) / DAY_MS)))] += 1
    const most = Math.max(1, ...count)
    this.el.querySelector('.bm-hist').innerHTML = count.map((c) => `<i style="height:${c ? 14 + (c / most) * 86 : 0}%"></i>`).join('')
    const room = Math.max(2, Math.floor((this.el.querySelector('.bm-time').clientWidth || 900) / 70))
    const step = [1, 2, 3, 7, 14, 30, 61, 91, 182, 365].find((s) => days / s <= room) || 365
    let ticks = ''
    for (let d = 0; d <= days; d += step) ticks += `<span style="left:${(d / Math.max(1, days)) * 100}%">${short(this._from + d * DAY_MS)}</span>`
    this.el.querySelector('.bm-ticks').innerHTML = ticks
  }

  _syncMode() {
    for (const b of this.el.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode))
    this.stage.hidden = this.mode !== 'field'
    this.list.hidden = this.mode !== 'list'
    this.field?.show(this.on && this.mode === 'field')
  }

  /** Paint the field and the list from the search, the day, the area and the chosen note. */
  _draw() {
    if (!this.brain || !this.on) return
    const visible = this._visible()
    const shown = new Set(visible.map((n) => n.id))
    const hits = matches(visible, this.query)
    const byId = new Map(this.brain.notes.map((n) => [n.id, n]))
    const dim = (id) => !shown.has(id) || (hits && !hits.has(id)) || (this.focusArea && byId.get(id)?.area !== this.focusArea)
    const c = this.chosen && byId.get(this.chosen)
    const near = c ? new Set([c.id, ...c.links, ...c.supersededBy, ...c.supersedes, ...this.brain.notes.filter((n) => n.links.includes(c.id)).map((n) => n.id)]) : null
    this.field?.paint({ dim, chosen: this.chosen, near, area: this.focusArea })
    if (this.mode === 'list') this._list(visible.filter((n) => !dim(n.id)))
    const total = this.brain.notes.length
    const when = this.asOf === Infinity ? '' : `As it stood on ${said(this.asOf)}: `
    this.said.textContent = hits ? `${when}${plural(hits.size, 'note matches', 'notes match')} “${this.query.trim()}”` : this.asOf === Infinity ? `${this.brain.notes.filter((n) => n.status === 'superseded').length} superseded, ${this.brain.notes.filter((n) => n.imported).length} to review` : `${when}${visible.length} of ${total} notes`
  }

  _list(notes) {
    const byArea = new Map(this.brain.areas.map((a) => [a.id, []]))
    for (const n of [...notes].reverse()) byArea.get(n.area)?.push(n)
    this.list.innerHTML = [...byArea].filter(([, ns]) => ns.length).map(([area, ns]) => {
      const a = this.brain.areas.find((x) => x.id === area)
      const slot = this.brain.areas.indexOf(a) % INKS.length
      return `<section style="--ink:${this._inks()[slot]}"><h2>${esc(a.name)} <span>${ns.length}${a.private ? ', private' : ''}</span></h2><ul>${ns.map((n) => `<li><button type="button" data-note="${esc(n.id)}" class="${n.status === 'superseded' ? 'old' : ''}"><strong>${esc(n.title)}</strong><span>${esc(KIND_WORD[n.kind])}, ${short(dayOf(n.date))}${n.status === 'superseded' ? ', superseded' : ''}${n.imported ? ', to review' : ''}</span></button></li>`).join('')}</ul></section>`
    }).join('') || '<p class="bm-none">No note matches.</p>'
  }

  /** The note's name beside the pointer, on hover only. */
  _hover(id, x, y) {
    const n = id && this.brain?.notes.find((m) => m.id === id)
    if (!n) { this.tip.hidden = true; return }
    this.tip.hidden = false
    this.tip.innerHTML = `<span>${short(dayOf(n.date))}, ${esc(KIND_WORD[n.kind].toLowerCase())}</span>${esc(n.title)}`
    this.tip.style.transform = `translate(${Math.min(x + 14, this.stage.clientWidth - 300)}px, ${Math.max(8, y - 44)}px)`
  }

  _click(e) {
    const mode = e.target.closest('[data-mode]')?.dataset.mode
    if (mode) { this.mode = mode; this._syncMode(); return this._draw() }
    const area = e.target.closest('[data-area]')?.dataset.area
    if (area) { this.focusArea = this.focusArea === area ? '' : area; return this._draw() }
    const id = e.target.closest('[data-note]')?.dataset.note
    if (id) return this.open(id)
    if (e.target.closest('[data-act="close-note"]')) return this.close()
    if (e.target.closest('[data-act="edit-note"]')) return this._edit()
    if (e.target.closest('[data-act="cancel-edit"]')) return this.open(this.chosen)
    if (e.target.closest('[data-act="save-note"]')) return this._save()
    if (e.target.closest('[data-act="new-note"]')) return this._new()
  }

  /** Open a note's text on the side, and turn the brain to it. */
  async open(id) {
    this.chosen = id
    this.note.hidden = false
    this.el.classList.add('reading')
    this.note.innerHTML = '<p class="bm-loading">Reading the note.</p>'
    this._draw()
    this.field?.focus(id)
    try {
      const res = await fetch(`/api/studio/brain/note?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
      const n = await res.json()
      if (!res.ok) throw new Error(n.error || `The note answered ${res.status}`)
      if (this.chosen !== id) return
      this._open = n
      const byId = new Map(this.brain.notes.map((x) => [x.id, x]))
      const title = (x) => byId.get(x)?.title || x
      const inks = this._inks()
      const inkOf = (x) => inks[this.brain.areas.findIndex((a) => a.id === byId.get(x)?.area) % inks.length] || inks[0]
      const chip = (x) => `<button type="button" class="bm-chip" style="--ink:${inkOf(x)}" data-note="${esc(x)}">${esc(title(x))}</button>`
      // [[links]] in the text become buttons to the note they name.
      const body = markdown(n.text.replace(/^#\s+.*\n?/, '').replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_, t, label) => `⟦${t.trim()}⟧${label ? `⟪${label}⟫` : ''}`))
        .replace(/⟦([^⟧]+)⟧(?:⟪([^⟫]*)⟫)?/g, (_, t, label) => byId.has(t) ? `<button type="button" class="bm-wl" data-note="${esc(t)}">${esc(label || title(t))}</button>` : `<span class="bm-wl missing">${esc(label || t)}</span>`)
      const area = this.brain.areas.find((a) => a.id === n.area)
      const backs = this.brain.notes.filter((x) => x.links.includes(id)).map((x) => x.id)
      this.note.innerHTML = `<header class="bm-note-head" style="--ink:${inkOf(id)}">
          <p class="bm-note-kind">${esc(KIND_WORD[n.kind] || 'Note')} in ${esc(area?.name || n.area)}${n.private ? ', private' : ''}</p>
          <h2>${esc(n.title)}</h2>
          <p class="bm-note-meta">${said(dayOf(n.date))}${n.status && n.status !== 'accepted' ? `, ${esc(n.status)}` : ''}${n.imported ? ', imported, to review' : ''}</p>
          <button type="button" class="bm-close" data-act="close-note" aria-label="Close the note">${CLOSE}</button>
        </header>
        ${n.supersededBy.length ? `<p class="bm-replaced-by">Replaced by ${n.supersededBy.map(chip).join(' ')}</p>` : ''}
        ${n.supersedes.length ? `<p class="bm-replaces">Replaces ${n.supersedes.map(chip).join(' ')}</p>` : ''}
        <div class="bm-text">${body}</div>
        ${backs.length ? `<div class="bm-backs"><h3>Named by</h3>${backs.map(chip).join('')}</div>` : ''}
        <div class="bm-acts"><button type="button" class="bm-btn" data-act="edit-note">Edit note</button><span>${esc(n.path)}</span></div>`
      this.note.scrollTop = 0
    } catch (err) {
      this.note.innerHTML = `<p class="bm-loading">${esc(err.message)}</p><button type="button" class="bm-close" data-act="close-note" aria-label="Close the note">${CLOSE}</button>`
    }
  }

  /** The note's whole text, frontmatter included, in a field to edit. */
  _edit() {
    const n = this._open
    if (!n) return
    this.note.innerHTML = `<header class="bm-note-head" style="--ink:var(--accent)"><p class="bm-note-kind">Editing</p><h2>${esc(n.title)}</h2>
        <button type="button" class="bm-close" data-act="close-note" aria-label="Close the note">${CLOSE}</button></header>
      <label class="bm-edit"><span class="visually-hidden">The note's text</span><textarea spellcheck="true">${esc(n.raw)}</textarea></label>
      <p class="bm-edit-said" role="status"></p>
      <div class="bm-acts"><button type="button" class="bm-btn primary" data-act="save-note">Save note</button><button type="button" class="bm-btn" data-act="cancel-edit">Cancel</button><span>${esc(n.path)}</span></div>`
    const area = this.note.querySelector('textarea')
    area.focus()
    area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this._save() } })
  }

  async _save() {
    const n = this._open
    const area = this.note.querySelector('.bm-edit textarea')
    if (!n || !area) return
    const said = this.note.querySelector('.bm-edit-said')
    said.textContent = 'Saving.'
    const res = await fetch('/api/studio/brain/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: n.id, text: area.value, version: n.version }) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) { said.textContent = body.error || 'The note could not be saved.'; return }
    this.key = ''
    await this.refresh()
    this.open(n.id)
  }

  /** A new note: a title and a first line, filed in inbox/ until it is sorted. */
  _new() {
    this.chosen = ''
    this._open = null
    this.note.hidden = false
    this.el.classList.add('reading')
    this.note.innerHTML = `<header class="bm-note-head" style="--ink:var(--accent)"><p class="bm-note-kind">New note, filed in inbox/</p><h2>Write it down</h2>
        <button type="button" class="bm-close" data-act="close-note" aria-label="Close">${CLOSE}</button></header>
      <form class="bm-newform"><label>Title <input name="title" required maxlength="120" placeholder="What was decided"></label>
        <label>Text <textarea name="text" rows="8" placeholder="The decision or the preference, and why."></textarea></label>
        <p class="bm-edit-said" role="status"></p>
        <div class="bm-acts"><button type="submit" class="bm-btn primary">Save note</button></div></form>`
    const form = this.note.querySelector('form')
    const title = form.querySelector('[name="title"]')
    const text = form.querySelector('[name="text"]')
    title.focus()
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const said = form.querySelector('.bm-edit-said')
      const res = await fetch('/api/studio/brain/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, text: text.value }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { said.textContent = body.error || 'The note could not be saved.'; return }
      this.key = ''
      await this.refresh()
      this.open(body.id)
    })
  }

  close() {
    this.chosen = ''
    this.note.hidden = true
    this.el.classList.remove('reading')
    this._draw()
  }
}
