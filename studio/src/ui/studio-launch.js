/**
 * The Launch screen (docs/launch.md): every product on every channel, each cell read from the channel itself,
 * with the next step and who it waits on; a product's page with its readiness list and history. Pure HTML from
 * what the server sent, plus the Studio class's methods for it.
 */
import { esc, when } from './studio-crew.js'

const HOW = { read: 'read', told: 'told', none: 'not known' }
const MARK = { pass: 'Done', fail: 'Missing', unknown: 'Not known', yours: 'Yours' }
const ago = (t) => (t ? when(t) : 'never')
const WEEK = 7 * 24 * 3600 * 1000

/* State marks (docs/design/launch/DESIGN.md): a shape per meaning, so a state never rests on colour alone. */
const G = {
  ok: '<svg class="g g-ok" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="currentColor" stroke="var(--edge)" stroke-width="1.5"/></svg>',
  go: '<svg class="g g-go" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="currentColor"/></svg>',
  yours: '<svg class="g g-yours" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .6l4.8 2.7v5.4L6 11.4 1.2 8.7V3.3z" fill="currentColor" stroke="var(--edge)" stroke-width="1.4"/></svg>',
  bad: '<svg class="g g-bad" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9l5.3 9.6H.7z" fill="currentColor" stroke="var(--edge)" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  none: '<svg class="g g-none" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 1.8"/></svg>',
}
/** Which mark a cell gets: by what it means, not by how it was stored. */
export const markOf = (c) => (c.how === 'none' ? 'none' : c.tone === 'ok' ? 'ok' : c.tone === 'bad' ? 'bad' : c.tone === 'look' && c.how !== 'told' ? 'yours' : c.tone === 'go' ? 'go' : 'none')

/** The button of a step that waits for the owner, and what it opens: the words are the client's, keyed on the case. */
export function stepButton(c) {
  const next = c.next || ''
  if (/\bkey\b/i.test(next)) return { label: 'Add the key', go: 'connectors' }
  if (c.how === 'told' && c.at) return { label: 'Say again', go: 'product' }
  if (/^Say (its|the)\b/i.test(next) || /\bid\b/.test(next)) return { label: /\bid\b/.test(next) ? 'Add the id' : 'Say where it stands', go: 'product' }
  if (/^Say where/i.test(next)) return { label: 'Say where it stands', go: 'product' }
  if (/^Name /i.test(next)) return { label: 'Open the product', go: 'product' }
  if (c.tone === 'look' || c.tone === 'go' || /^Your yes|^Decide/i.test(next)) return { label: 'Open Needs you', go: 'needs' }
  return { label: 'Open the product', go: 'product' }
}

/** Every step that waits for the owner, in plan then channel order. */
export function yoursOf(data) {
  const out = []
  for (const r of data.rows) for (const ch of data.channels) {
    const c = r.cells[ch.id]
    if (c && c.waits === 'owner' && c.next) out.push({ product: r.name, channel: ch.name, c })
  }
  return out
}

function noteOf(c, now) {
  if (c.how === 'told' && c.at) return `<small class="${now - c.at > WEEK ? 'old' : ''}">Told ${esc(ago(c.at))}</small>`
  if (c.detail && c.tone !== 'bad') return `<small>${esc(c.detail)}</small>`
  return ''
}

function cellHtml(c, channel, now) {
  if (!c) return `<td class="empty" data-ch="${esc(channel)}"></td>`
  const k = markOf(c)
  return `<td class="${k === 'none' ? 'unread' : k === 'bad' ? 'bad' : ''}" data-ch="${esc(channel)}"><span class="st">${G[k]}<span>${esc(c.state)}</span></span>${noteOf(c, now)}</td>`
}

const plural = (n) => `${n} ${n === 1 ? 'step waits' : 'steps wait'} for you`

export function launchScreen(data, { now = Date.now() } = {}) {
  if (!data.planFound) {
    return `<div class="launch-empty"><h2>No launch plan yet</h2><p>Launch shows where each product stands on each store and channel. It needs a plan first: one file with each product and its id on each channel (its package name, bundle id, address or repository).</p>
      <p>Write it at <code>${esc(data.planFile)}</code>. docs/launch.md says how.</p></div>`
  }
  const head = `<div class="launch-head"><p class="read">Read from each channel <b>${esc(ago(data.checkedAt))}</b></p>
    <button class="btn" data-act="launch-check">Check now</button></div>`
  const mine = yoursOf(data)
  const lead = mine.length
    ? `<section class="launch-yours" aria-labelledby="launch-yours-h"><h3 id="launch-yours-h">${plural(mine.length)}</h3><ol>${mine.map((m, i) => {
      const b = stepButton(m.c)
      const same = i && mine[i - 1].product === m.product
      return `<li class="${same ? 'same' : ''}"><span class="p">${esc(m.product)}</span><span class="c">${esc(m.channel)}</span><span class="s">${esc(m.c.next)}</span>
        <button class="btn" type="button" data-act="launch-step" data-go="${b.go}" data-name="${esc(m.product)}">${esc(b.label)}</button></li>`
    }).join('')}</ol></section>`
    : '<p class="launch-clear"><b>Nothing waits for you.</b> The crew and the stores have the next steps.</p>'
  const key = `<p class="key"><span>${G.ok}Live</span><span>${G.go}Moving</span><span>${G.yours}Your step</span><span>${G.bad}Down</span><span>${G.none}Not read</span></p>`
  const rows = data.rows.map((r) => {
    const cells = Object.values(r.cells).filter(Boolean)
    const n = cells.filter((c) => c.waits === 'owner' && c.next).length
    const other = cells.find((c) => c.next && c.waits && c.waits !== 'owner')
    const who = other ? { crew: 'the crew', store: 'the store' }[other.waits] || other.waits : ''
    return `<tr class="go-row" data-act="launch-product" data-name="${esc(r.name)}" tabindex="0">
      <th scope="row"><b>${esc(r.name)}</b>${r.kind ? `<small>${esc(r.kind)}</small>` : ''}${n ? `<span class="yours-n">${G.yours}${plural(n)}</span>` : ''}${other ? `<p class="crew"><em>Waits for ${esc(who)}:</em> ${esc(other.next)}</p>` : ''}</th>
      ${data.channels.map((c) => cellHtml(r.cells[c.id], c.name, now)).join('')}</tr>`
  }).join('')
  return `${head}${lead}<div class="board-head"><h3>Every product</h3><p class="blank">A blank cell: the product is not on that channel.</p>${key}</div>
    <table class="launch"><thead><tr><th>Product</th>${data.channels.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
}

const nextHtml = (n) => (n ? `<small class="next">Next: ${esc(n.text)}${n.waits ? ` <b>Waits for ${esc(n.waits)}</b>` : ''}</small>` : '<small class="next">Nothing waits</small>')

export function productScreen(data, name) {
  const r = data.rows.find((x) => x.name === name)
  if (!r) return '<p class="none">That product is not in the launch plan.</p>'
  const cells = data.channels.filter((c) => r.cells[c.id]).map((c) => {
    const x = r.cells[c.id]
    const tell = x.how !== 'read' ? `<form class="tell" data-part="launch-tell" data-product="${esc(r.name)}" data-channel="${esc(c.id)}">
        <label>Where it stands now <input name="state" maxlength="200" placeholder="Like: In QA since Monday"></label>
        <button class="btn" type="button" data-act="launch-tell">Save</button></form>` : ''
    return `<li><b>${esc(c.name)}</b> <span class="cell ${esc(x.tone || 'wait')} how-${esc(x.how || 'read')}">${esc(x.state)}</span>
      <small>${esc(HOW[x.how] || '')}${x.checkedAt ? `, ${esc(ago(x.checkedAt))}` : ''}${x.by ? `, by ${esc(x.by)}` : ''}</small>
      ${x.detail ? `<p class="hint">${esc(x.detail)}</p>` : ''}${x.next ? `<p class="hint">Next: ${esc(x.next)}</p>` : ''}${tell}</li>`
  }).join('')
  const groups = [...new Set(r.readiness.map((i) => i.group))]
  const ready = groups.map((g) => `<h4>${esc(g)}</h4><ul class="ready">${r.readiness.filter((i) => i.group === g).map((i) => `<li class="${esc(i.state)}"><span class="mark">${esc(MARK[i.state] || i.state)}</span>${esc(i.text)}${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</li>`).join('')}</ul>`).join('')
  const history = r.history.length
    ? `<ol class="history">${r.history.map((h) => `<li><time>${esc(ago(h.at))}</time> ${esc(data.channels.find((c) => c.id === h.channel)?.name || h.channel)}: ${h.from ? `${esc(h.from)} → ` : ''}<b>${esc(h.to)}</b>${h.how === 'told' ? ' <small>(told)</small>' : ''}</li>`).join('')}</ol>`
    : '<p class="none">Nothing has changed since the first check.</p>'
  return `${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
    <p>${nextHtml(r.next)}</p>
    <h3>Channels</h3><ul class="launch-cells">${cells || '<li class="none">No channels in its plan yet.</li>'}</ul>
    <h3>Ready for its next release</h3>${ready}
    <h3>History</h3>${history}`
}

/** The Studio class's methods for these screens. */
export function launchMethods({ call }) {
  return {
    async openLaunch({ force = false } = {}) {
      if (this.screen !== 'launch') this._openSheet('launch', 'Launch', 'Every product on every store and channel: where it stands, and what it waits on', { wide: true })
      this._reopen = () => this.openLaunch()
      const seq = ++this._sheetSeq
      const data = await (force ? call('/api/studio/launch', { action: 'check' }) : call('/api/studio/launch')).catch((err) => { this.actions.toast(err.message, 'err'); return null })
      const col = this._colOf('launch')
      if (!col || seq !== col.seq) return
      this._launch = data
      col.el.querySelector('.sheet-body').innerHTML = data ? launchScreen(data) : '<p class="none">The launch board could not be read.</p>'
    },

    openLaunchProduct(name) {
      this._openSheet('launch-product', name, 'Its channels, what it needs before its next release, and what changed', { wide: false })
      this._reopen = () => this.openLaunchProduct(name)
      const col = this._colOf('launch-product')
      if (col) col.el.querySelector('.sheet-body').innerHTML = this._launch ? productScreen(this._launch, name) : '<p class="none">Open Launch first.</p>'
    },

    async _launchTell(form) {
      const said = String(new FormData(form).get('state') || '').trim()
      if (!said) { this.actions.toast('Say where it stands first', 'err'); return }
      try {
        this._launch = await call('/api/studio/launch', { action: 'tell', product: form.dataset.product, channel: form.dataset.channel, state: said })
        this.openLaunchProduct(form.dataset.product)
        const col = this._colOf('launch')
        if (col) col.el.querySelector('.sheet-body').innerHTML = launchScreen(this._launch)
        this.actions.toast('Saved')
      } catch (err) {
        this.actions.toast(err.message, 'err')
      }
    },

    /** @returns {boolean} whether the click was one of these screens' own */
    _launchAct(el) {
      const { act } = el.dataset
      if (act === 'launch-check') { this.actions.toast('Reading every channel…'); this.openLaunch({ force: true }); return true }
      if (act === 'launch-product') { this._go(() => this.openLaunchProduct(el.dataset.name)); return true }
      if (act === 'launch-step') {
        const go = el.dataset.go
        if (go === 'connectors') this._go(() => this.openConnectors())
        else if (go === 'needs') this.show('attention')
        else this._go(() => this.openLaunchProduct(el.dataset.name))
        return true
      }
      if (act === 'launch-tell') { this._launchTell(el.closest('form')); return true }
      return false
    },
  }
}
