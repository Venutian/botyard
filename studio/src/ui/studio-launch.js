/**
 * The Launch screen (docs/launch.md): every product on every channel, each cell read from the channel itself,
 * with the next step and who it waits on; a product's page with its readiness list and history. Pure HTML from
 * what the server sent, plus the Studio class's methods for it.
 */
import { esc, when } from './studio-crew.js'

const HOW = { read: 'read', told: 'told', none: 'not known' }
const MARK = { pass: 'Done', fail: 'Missing', unknown: 'Not known', yours: 'Yours' }
const ago = (t) => (t ? when(t) : 'never')

function cellHtml(c, channel) {
  if (!c) return '<td class="na" aria-label="Not on this channel">–</td>'
  return `<td data-label="${esc(channel)}"><span class="cell ${esc(c.tone || 'wait')} how-${esc(c.how || 'read')}">${esc(c.state)}</span>
    <small>${esc(HOW[c.how] || c.how || '')}${c.checkedAt ? `, ${esc(ago(c.checkedAt))}` : ''}</small></td>`
}

const nextHtml = (n) => (n ? `<small class="next">Next: ${esc(n.text)}${n.waits ? ` <b>Waits for ${esc(n.waits)}</b>` : ''}</small>` : '<small class="next">Nothing waits</small>')

export function launchScreen(data) {
  if (!data.planFound) {
    return `<p class="none">No launch plan yet. Write one at <code>${esc(data.planFile)}</code>: each product, and its ids on each channel (see docs/launch.md).</p>`
  }
  const head = `<div class="launch-head"><p class="hint">Each cell is read from the channel itself, told by a person, or not known; nothing unread is shown as live. Checked ${esc(ago(data.checkedAt))}.</p>
    <button class="btn" data-act="launch-check">Check now</button></div>`
  const rows = data.rows.map((r) => `<tr class="go-row" data-act="launch-product" data-name="${esc(r.name)}" tabindex="0">
      <th scope="row"><b>${esc(r.name)}</b>${nextHtml(r.next)}</th>
      ${data.channels.map((c) => cellHtml(r.cells[c.id], c.name)).join('')}
    </tr>`).join('')
  return `${head}<div class="grid-wrap"><table class="grid launch"><thead><tr><th>Product</th>${data.channels.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
}

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
      if (act === 'launch-tell') { this._launchTell(el.closest('form')); return true }
      return false
    },
  }
}
