import { markdown } from './markdown.js'

/**
 * The Brain view: the owner's notes vault as strata. Each area is a band, a note stands in its area's band
 * at the day it was made, its `[[links]]` arc to the notes it names, a superseded note is faded with an arrow
 * to the note that replaced it, and the newest decisions carry a halo. The scrubber shows the brain as it
 * stood on a past day; the search lights what matches; a click opens the note's text on the side.
 *
 * Read-only: editing stays in the files. It stands still: drawn when the notes, the size, the day, the
 * search or the chosen note change, and at no other time.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const DAY_MS = 86400000
const dayOf = (iso) => Date.parse(`${iso}T12:00:00Z`)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const said = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
const short = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const KIND_WORD = { decision: 'Decision', preference: 'Preference', fact: 'Fact', inbox: 'Inbox note', note: 'Note' }
const AREAS = 10
/** How many days count as new: their decisions carry the halo. */
const NEW_DAYS = 3

/** The shape of a note's mark, centred on 0,0, r its size. */
function shape(kind, r) {
  if (kind === 'decision') return `<path d="M0 ${-r * 1.25}L${r * 1.25} 0L0 ${r * 1.25}L${-r * 1.25} 0Z"/>`
  if (kind === 'preference') return `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="${r * 0.3}"/>`
  return `<circle r="${r}"/>`
}

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

/**
 * Where everything goes, as numbers: a pure function of the notes and the size, so it can be tested.
 * Notes on the same day in the same band step up and down so none covers another.
 */
export function layout(brain, { width, height, side = 0 }) {
  const compact = width < 480
  const left = compact ? 16 : width < 760 ? 120 : 168
  const right = (compact ? 16 : 28) + side
  const top = 18
  const bottom = 18
  const from = dayOf(brain.from) - 2 * DAY_MS
  const to = dayOf(brain.to) + 2 * DAY_MS
  const plotW = Math.max(120, width - left - right)
  const x = (iso) => left + ((dayOf(iso) - from) / Math.max(DAY_MS, to - from)) * plotW
  const bandH = Math.max(34, (height - top - bottom) / Math.max(1, brain.areas.length))
  const bands = brain.areas.map((a, i) => ({ ...a, slot: i % AREAS, y: top + i * bandH, h: bandH }))
  const bandOf = new Map(bands.map((b) => [b.id, b]))
  const taken = new Map()
  const at = new Map()
  for (const n of brain.notes) {
    const band = bandOf.get(n.area) || bands.at(-1)
    const px = x(n.date)
    const cell = `${n.area}:${Math.round(px / 16)}`
    const k = taken.get(cell) || 0
    taken.set(cell, k + 1)
    const step = Math.min(15, (band.h - 16) / 4)
    const offset = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * step
    const r = n.pinned ? 9 : 6.5
    at.set(n.id, { x: px + (Math.abs(offset) > band.h / 2 - 8 ? (k % 3) * 6 : 0), y: band.y + band.h / 2 + Math.max(-band.h / 2 + 9, Math.min(band.h / 2 - 9, offset)), r, slot: band.slot })
  }
  return { left, right, top, from, to, plotW, x, bands, at, width, height, compact }
}

export class BrainMap {
  /** @param {HTMLElement} host where the view sits */
  constructor(host) {
    this.el = document.createElement('section')
    this.el.className = 'brainmap'
    this.el.hidden = true
    this.el.setAttribute('aria-label', 'Brain')
    this.el.innerHTML = `<div class="bm-bar">
        <h1 class="bm-title">Senth</h1>
        <p class="bm-sub"></p>
        <label class="bm-find"><span class="visually-hidden">Search the notes</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 11.2L14.5 14.5M12.4 7a5.4 5.4 0 1 1-10.8 0a5.4 5.4 0 1 1 10.8 0"/></svg><input type="search" placeholder="Search the notes" autocomplete="off" spellcheck="false"></label>
        <p class="bm-said" role="status" aria-live="polite"></p>
      </div>
      <div class="bm-stage"><svg class="bm-svg" role="group" aria-label="Notes by area and day"></svg></div>
      <div class="bm-time">
        <div class="bm-hist" aria-hidden="true"></div>
        <input class="bm-scrub" type="range" min="0" max="1" step="1" value="1" aria-label="Show the brain as it stood on">
        <div class="bm-ticks" aria-hidden="true"></div>
      </div>
      <div class="bm-legend" aria-label="What the marks mean">
        <span><svg viewBox="-8 -8 16 16"><path class="lg" d="M0 -6L6 0L0 6L-6 0Z"/></svg>Decision</span>
        <span><svg viewBox="-8 -8 16 16"><rect class="lg" x="-5" y="-5" width="10" height="10" rx="1.5"/></svg>Preference</span>
        <span><svg viewBox="-8 -8 16 16"><circle class="lg" r="5"/></svg>Fact or note</span>
        <span><svg viewBox="-8 -8 16 16"><circle class="lg big" r="6.5"/></svg>In the index</span>
        <span><svg viewBox="-8 -8 16 16"><circle class="lg halo" r="7"/><path class="lg" d="M0 -4L4 0L0 4L-4 0Z"/></svg>New in the last ${NEW_DAYS} days</span>
        <span><svg viewBox="-8 -8 16 16"><circle class="lg old" r="5"/></svg>Superseded</span>
        <span><svg viewBox="-8 -8 16 16"><circle class="lg" r="4"/><circle class="lg ring" r="7"/></svg>Imported, to review</span>
        <span><svg viewBox="0 0 16 10"><rect class="lg hatch" width="16" height="10"/></svg>Private area</span>
      </div>
      <aside class="bm-note panel" hidden aria-label="Note"></aside>
      <div class="bm-empty" hidden></div>`
    host.prepend(this.el)
    this.stage = this.el.querySelector('.bm-stage')
    this.svg = this.el.querySelector('.bm-svg')
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
    this.on = false
    this.drawMs = []
    this.find.addEventListener('input', () => { this.query = this.find.value; this._draw() })
    this.find.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const hit = [...(matches(this._visible(), this.query) || [])].at(-1)
      if (hit) this.open(hit)
    })
    this.scrub.addEventListener('input', () => { this.asOf = Number(this.scrub.value) >= Number(this.scrub.max) ? Infinity : this._from + Number(this.scrub.value) * DAY_MS; this._draw() })
    this.el.addEventListener('click', (e) => this._click(e))
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.note.hidden) { e.stopPropagation(); this.close() }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-note]') && e.target.tagName !== 'BUTTON') { e.preventDefault(); this.open(e.target.closest('[data-note]').dataset.note) }
    })
    this.svg.addEventListener('pointerover', (e) => this._hover(e.target.closest('[data-note]')?.dataset.note || ''))
    this.svg.addEventListener('pointerleave', () => this._hover(''))
    new ResizeObserver(() => this._draw()).observe(this.stage)
  }

  show(on) {
    this.on = on
    this.el.hidden = !on
    if (on) this.refresh()
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
    this._draw()
    if (this.chosen && !brain.notes.some((n) => n.id === this.chosen)) this.close()
  }

  _empty(why, canSet = false) {
    this.svg.innerHTML = ''
    this.empty.hidden = false
    this.empty.innerHTML = `<h2>Your notes go here</h2><p>${esc(why)}</p>${canSet ? `<p>Senth reads any folder of markdown notes, such as an Obsidian vault. It only reads; you edit the notes in their files.</p>
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
    this.el.querySelector('.bm-hist').innerHTML = count.map((c) => `<i style="height:${c ? 12 + (c / most) * 88 : 0}%"></i>`).join('')
    const room = Math.max(2, Math.floor((this._tickW || 900) / 64))
    const step = [1, 2, 3, 7, 14, 30, 61, 91, 182, 365].find((s) => days / s <= room) || 365
    let ticks = ''
    for (let d = 0; d <= days; d += step) ticks += `<span style="left:${(d / Math.max(1, days)) * 100}%">${short(this._from + d * DAY_MS)}</span>`
    this.el.querySelector('.bm-ticks').innerHTML = ticks
  }

  /** Draw it. Measured, so the 16 ms budget can be checked. */
  _draw() {
    if (!this.brain || !this.on) return
    const t0 = performance.now()
    const width = this.stage.clientWidth
    const height = this.stage.clientHeight
    if (!width || !height) return
    const side = this.note.hidden || width < 760 ? 0 : Math.min(420, width * 0.36)
    const L = layout(this.brain, { width, height, side })
    const visible = this._visible()
    const shown = new Set(visible.map((n) => n.id))
    const hits = matches(visible, this.query)
    const byId = new Map(this.brain.notes.map((n) => [n.id, n]))
    const newest = dayOf(this.asOf === Infinity ? this.brain.to : isoOf(this.asOf)) - NEW_DAYS * DAY_MS
    const lit = (id) => (!hits || hits.has(id)) && (!this.focusArea || byId.get(id)?.area === this.focusArea)
    const near = this.chosen ? new Set([this.chosen, ...(byId.get(this.chosen)?.links || []), ...this.brain.notes.filter((n) => n.links.includes(this.chosen)).map((n) => n.id), ...(byId.get(this.chosen)?.supersededBy || []), ...(byId.get(this.chosen)?.supersedes || [])]) : null

    let out = `<defs>
      <pattern id="bm-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.2" height="7" class="bm-hatch-ink"/></pattern>
      <radialGradient id="bm-glow"><stop offset="0" class="bm-glow-in"/><stop offset="1" class="bm-glow-out"/></radialGradient>
      <marker id="bm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.8L7.4 4L0 7.2Z" class="bm-arrow-ink"/></marker>
    </defs>`
    // The bands, with their names; a private area is hatched.
    for (const b of L.bands) {
      const dim = this.focusArea && this.focusArea !== b.id ? ' dim' : ''
      const n = visible.filter((x) => x.area === b.id).length
      out += `<g class="bm-band a${b.slot}${dim}"><rect class="bm-band-fill" x="0" y="${b.y}" width="${L.width}" height="${b.h}"/>${b.private ? `<rect x="${L.compact ? 0 : L.left - 10}" y="${b.y}" width="${L.width - (L.compact ? 0 : L.left - 10)}" height="${b.h}" fill="url(#bm-hatch)"/>` : ''}<line class="bm-band-rule" x1="0" x2="${L.width}" y1="${b.y + b.h}" y2="${b.y + b.h}"/>
        <g class="bm-band-name" data-area="${esc(b.id)}" role="button" tabindex="0" aria-pressed="${this.focusArea === b.id}" aria-label="${esc(b.name)}, ${plural(n, 'note')}${b.private ? ', private' : ''}. Show only this area.">${L.compact ? `<rect x="4" y="${b.y + 3}" width="${Math.min(170, b.name.length * 8 + 44)}" height="18" rx="4" class="bm-band-hit"/><rect x="6" y="${b.y + 7}" width="3" height="11" rx="1.5" class="bm-swatch"/><text x="13" y="${b.y + 13}" class="bm-band-text small">${esc(b.name)} <tspan class="bm-band-count small">${n}</tspan></text>` : `<rect x="8" y="${b.y + 4}" width="${L.left - 22}" height="${b.h - 8}" rx="6" class="bm-band-hit"/><rect x="12" y="${b.y + b.h / 2 - 9}" width="4" height="18" rx="2" class="bm-swatch"/><text x="24" y="${b.y + b.h / 2 + 1}" class="bm-band-text">${esc(b.name.length > (L.left < 150 ? 10 : 15) ? `${b.name.slice(0, L.left < 150 ? 9 : 14)}…` : b.name)}</text><text x="${L.left - 20}" y="${b.y + b.h / 2 + 1}" class="bm-band-count">${n}</text>`}</g></g>`
    }
    // A faint rule each week, so the strata read as time.
    const span = (L.to - L.from) / DAY_MS
    const every = span > 150 ? 28 : 7
    for (let d = Math.ceil((L.from - this._from) / DAY_MS / every) * every; this._from + d * DAY_MS <= L.to; d += every) {
      const gx = L.left + ((this._from + d * DAY_MS - L.from) / (L.to - L.from)) * L.plotW
      if (gx >= L.left) out += `<line class="bm-week" x1="${gx.toFixed(1)}" x2="${gx.toFixed(1)}" y1="0" y2="${L.height}"/>`
    }
    // The day the scrubber stands on.
    if (this.asOf !== Infinity) {
      const x = L.left + ((this.asOf - L.from) / (L.to - L.from)) * L.plotW
      out += `<line class="bm-now" x1="${x}" x2="${x}" y1="0" y2="${L.height}"/><rect class="bm-later" x="${x}" y="0" width="${Math.max(0, L.width - L.right - x + 28)}" height="${L.height}"/>`
    }
    // Links as arcs, then the superseded arrows on top of them.
    let lines = ''
    for (const n of visible) {
      const a = L.at.get(n.id)
      for (const to of n.links) {
        if (!shown.has(to)) continue
        const b = L.at.get(to)
        if (!b) continue
        const on = near ? near.has(n.id) && near.has(to) && (n.id === this.chosen || to === this.chosen) : lit(n.id) && lit(to)
        const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.32 + 8)
        lines += `<path class="bm-link a${a.slot}${on ? '' : ' faint'}${near && on ? ' strong' : ''}" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${((a.x + b.x) / 2).toFixed(1)} ${(Math.min(a.y, b.y) - lift).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}"/>`
      }
      for (const to of n.supersededBy) {
        if (!shown.has(to)) continue
        const b = L.at.get(to)
        if (!b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.max(1, Math.hypot(dx, dy))
        const on = near ? near.has(n.id) && near.has(to) : lit(n.id) || lit(to)
        lines += `<path class="bm-replaced${on ? '' : ' faint'}" marker-end="url(#bm-arrow)" d="M${(a.x + (dx / len) * (a.r + 3)).toFixed(1)} ${(a.y + (dy / len) * (a.r + 3)).toFixed(1)}L${(b.x - (dx / len) * (b.r + 6)).toFixed(1)} ${(b.y - (dy / len) * (b.r + 6)).toFixed(1)}"/>`
      }
    }
    out += `<g class="bm-lines">${lines}</g>`
    // The notes.
    const areaName = new Map(this.brain.areas.map((a) => [a.id, a.name]))
    let marks = ''
    for (const n of visible) {
      const p = L.at.get(n.id)
      const glow = n.kind === 'decision' && n.status !== 'superseded' && dayOf(n.date) >= newest
      const cls = ['bm-n', `a${p.slot}`, n.status === 'superseded' ? 'old' : '', n.kind === 'inbox' || n.kind === 'note' ? 'hollow' : '', lit(n.id) && (!near || near.has(n.id)) ? '' : 'faint', n.id === this.chosen ? 'chosen' : ''].filter(Boolean).join(' ')
      marks += `<g class="${cls}" data-note="${esc(n.id)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(noteSentence(n, areaName.get(n.area) || n.area))}">${glow ? `<circle class="bm-halo" r="${p.r * 3.2}"/>` : ''}<circle class="bm-hit" r="${Math.max(11, p.r + 5)}"/>${shape(n.kind, p.r)}${n.imported ? `<circle class="bm-ring" r="${p.r + 3.5}"/>` : ''}</g>`
    }
    out += `<g class="bm-marks">${marks}</g><g class="bm-tip" aria-hidden="true"></g>`
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    this.svg.innerHTML = out
    this._layout = L
    const time = this.el.querySelector('.bm-time')
    time.style.marginLeft = `${L.left}px`
    time.style.marginRight = `${L.right}px`
    if (this._tickW !== L.plotW) { this._tickW = L.plotW; this._timeline() }
    const total = this.brain.notes.length
    const when = this.asOf === Infinity ? '' : `As it stood on ${said(this.asOf)}: `
    this.said.textContent = hits ? `${when}${plural(hits.size, 'note matches', 'notes match')} “${this.query.trim()}”` : this.asOf === Infinity ? `${this.brain.notes.filter((n) => n.status === 'superseded').length} superseded, ${this.brain.notes.filter((n) => n.imported).length} to review` : `${when}${visible.length} of ${total} notes`
    this.drawMs.push(performance.now() - t0)
    if (this.drawMs.length > 20) this.drawMs.shift()
  }

  /** The note's name beside the pointer: one small label, drawn only on hover. */
  _hover(id) {
    const tip = this.svg.querySelector('.bm-tip')
    if (!tip) return
    const n = id && this.brain?.notes.find((x) => x.id === id)
    const p = n && this._layout?.at.get(id)
    if (!p) { tip.innerHTML = ''; return }
    const text = n.title.length > 64 ? `${n.title.slice(0, 63)}…` : n.title
    const w = Math.min(460, text.length * 7.3 + 86)
    const x = Math.min(this._layout.width - w - 8, Math.max(8, p.x - w / 2))
    const y = p.y - p.r - 38 < 4 ? p.y + p.r + 10 : p.y - p.r - 38
    tip.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="28" rx="6" class="bm-tip-box"/><text x="${x + 10}" y="${y + 18}" class="bm-tip-text"><tspan class="bm-tip-day">${short(dayOf(n.date))}</tspan>  ${esc(text)}</text>`
  }

  _click(e) {
    const area = e.target.closest('[data-area]')?.dataset.area
    if (area) { this.focusArea = this.focusArea === area ? '' : area; return this._draw() }
    const id = e.target.closest('[data-note]')?.dataset.note
    if (id) return this.open(id)
    if (e.target.closest('[data-act="close-note"]')) return this.close()
    if (e.target.closest('.bm-svg') && this.chosen) this.close()
  }

  /** Open a note's text on the side. */
  async open(id) {
    this.chosen = id
    this.note.hidden = false
    this.note.innerHTML = '<p class="bm-loading">Reading the note.</p>'
    this._draw()
    try {
      const res = await fetch(`/api/studio/brain/note?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
      const n = await res.json()
      if (!res.ok) throw new Error(n.error || `The note answered ${res.status}`)
      if (this.chosen !== id) return
      const byId = new Map(this.brain.notes.map((x) => [x.id, x]))
      const title = (x) => byId.get(x)?.title || x
      const chip = (x) => `<button type="button" class="bm-chip a${this._layout?.at.get(x)?.slot ?? 0}" data-note="${esc(x)}">${esc(title(x))}</button>`
      // [[links]] in the text become buttons to the note they name.
      const body = markdown(n.text.replace(/^#\s+.*\n?/, '').replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_, t, label) => `⟦${t.trim()}⟧${label ? `⟪${label}⟫` : ''}`))
        .replace(/⟦([^⟧]+)⟧(?:⟪([^⟫]*)⟫)?/g, (_, t, label) => byId.has(t) ? `<button type="button" class="bm-wl" data-note="${esc(t)}">${esc(label || title(t))}</button>` : `<span class="bm-wl missing">${esc(label || t)}</span>`)
      const area = this.brain.areas.find((a) => a.id === n.area)
      const backs = this.brain.notes.filter((x) => x.links.includes(id)).map((x) => x.id)
      this.note.innerHTML = `<header class="bm-note-head a${this._layout?.at.get(id)?.slot ?? 0}">
          <p class="bm-note-kind">${esc(KIND_WORD[n.kind] || 'Note')} in ${esc(area?.name || n.area)}${n.private ? ', private' : ''}</p>
          <h2>${esc(n.title)}</h2>
          <p class="bm-note-meta">${said(dayOf(n.date))}${n.status && n.status !== 'accepted' ? `, ${esc(n.status)}` : ''}${n.imported ? ', imported, to review' : ''}</p>
          <button type="button" class="bm-close" data-act="close-note" aria-label="Close the note"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>
        </header>
        ${n.supersededBy.length ? `<p class="bm-replaced-by">Replaced by ${n.supersededBy.map(chip).join(' ')}</p>` : ''}
        ${n.supersedes.length ? `<p class="bm-replaces">Replaces ${n.supersedes.map(chip).join(' ')}</p>` : ''}
        <div class="bm-text">${body}</div>
        ${backs.length ? `<div class="bm-backs"><h3>Named by</h3>${backs.map(chip).join('')}</div>` : ''}
        <p class="bm-path">${esc(n.path)}. Edit it in the file; this view only reads.</p>`
      this.note.scrollTop = 0
    } catch (err) {
      this.note.innerHTML = `<p class="bm-loading">${esc(err.message)}</p><button type="button" class="bm-close" data-act="close-note" aria-label="Close the note"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>`
    }
  }

  close() {
    this.chosen = ''
    this.note.hidden = true
    this._draw()
  }
}
