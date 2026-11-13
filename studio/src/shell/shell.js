import './base.css'
import { QUALITIES } from '../yard/settings.js'

/**
 * The page's frame round the yard: the layer the panels sit in, the opening plate, the map's own
 * two buttons, the map settings, the help sheet's frame (its words are the panels'), passing notes
 * and the one-line hint. Everything else on the page belongs to the panels (ui/studio.js).
 */

const icon = (path) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ICONS = {
  whole: icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z"/>'),
  next: icon('<path d="M5 12h12M13 7l5 5-5 5"/><circle cx="5" cy="12" r="1.6" fill="currentColor"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
}

const TEMPLATE = `
<div class="rail panel" aria-label="The map">
  <button class="btn icon" type="button" data-map="whole" title="See the whole yard (0)" aria-label="See the whole yard">${ICONS.whole}</button>
  <button class="btn icon" type="button" data-map="next" title="Go to the next bot that is stopped or waiting (N)" aria-label="Go to the next bot that is stopped or waiting">${ICONS.next}</button>
</div>
<aside class="settings panel" aria-label="Map settings" inert>
  <header>Map settings <button class="btn icon ghost" type="button" data-map="settings-close" title="Close" aria-label="Close the map settings">${ICONS.close}</button></header>
  <div class="body">
    <div class="row"><span class="label"><span>Day or night</span><span class="hint">The yard and every panel change together.</span></span></div>
    <div class="planets" role="group" aria-label="Day or night">
      <button class="planet" type="button" data-shift="day"><i class="orb" style="background:#dcd8cc"></i><span>Day</span></button>
      <button class="planet" type="button" data-shift="night"><i class="orb" style="background:#15181d"></i><span>Night</span></button>
    </div>
    <div class="row"><span class="label"><span>Picture quality</span><span class="hint">Lower it if the map feels slow on this computer. It changes shadows and sharpness, nothing else.</span></span>
      <select class="select" data-map="quality" aria-label="Picture quality">${Object.entries(QUALITIES).map(([id, q]) => `<option value="${id}">${q.name}</option>`).join('')}</select></div>
    <div class="row"><span class="label"><span>Browser notices</span><span class="hint">A notice when something new waits for you while this tab is in the background.</span></span>
      <button class="btn" type="button" data-map="notify"></button></div>
  </div>
</aside>
<div class="help" role="dialog" aria-modal="true" aria-label="Keys and help" inert><div class="sheet"></div></div>
<div class="toasts" role="status" aria-live="polite"></div>
<div class="hint-pill" aria-hidden="true"></div>
<div class="boot"><div class="inner"><h1>Botyard</h1><p>Opening the yard</p><div class="bar">${'<i></i>'.repeat(10)}</div></div></div>`

export class Shell {
  /**
   * @param {HTMLElement} app the page's own element
   * @param {import('../yard/settings.js').MapSettings} settings
   * @param {{ whole?: () => void, next?: () => void, notify?: () => void }} acts
   */
  constructor(app, settings, acts) {
    this.settings = settings
    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    app.append(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.el.addEventListener('click', (e) => {
      const button = e.target.closest('[data-map], [data-shift]')
      if (!button) return
      if (button.dataset.shift) return void settings.set('shift', button.dataset.shift)
      const what = button.dataset.map
      if (what === 'whole') acts.whole?.()
      if (what === 'next') acts.next?.()
      if (what === 'settings-close') this.toggleSettings(false)
      if (what === 'notify') acts.notify?.()
    })
    this.$('[data-map="quality"]').addEventListener('change', (e) => settings.set('quality', e.target.value))
    settings.watch(() => this.syncSettings())
    this.syncSettings()
  }

  syncSettings() {
    for (const b of this.el.querySelectorAll('[data-shift]')) b.setAttribute('aria-pressed', String(b.dataset.shift === this.settings.get('shift')))
    this.$('[data-map="quality"]').value = this.settings.get('quality')
    this.$('[data-map="notify"]').textContent = this.settings.get('notify') ? 'Turn notices off' : 'Turn notices on'
  }

  _open(part, open) {
    const el = this.$(part)
    const on = open ?? !el.classList.contains('open')
    el.classList.toggle('open', on)
    el.inert = !on
    return on
  }

  toggleSettings(open) {
    const on = this._open('.settings', open)
    if (on) this.$('.settings [data-shift][aria-pressed="true"]')?.focus({ preventScroll: true })
    return on
  }

  toggleHelp(open) {
    const on = this._open('.help', open)
    if (on) this.$('.help [data-part="help-close"]')?.focus({ preventScroll: true })
    return on
  }

  get helpOpen() { return this.$('.help').classList.contains('open') }
  get settingsOpen() { return this.$('.settings').classList.contains('open') }

  /** Hide everything over the yard but the yard, or bring it back. */
  toggleUi(show) {
    this.el.classList.toggle('hidden', show === undefined ? !this.el.classList.contains('hidden') : !show)
  }

  /** A passing note; `kind` 'err' for one that says something went wrong. */
  toast(text, kind = '') {
    const note = document.createElement('div')
    note.className = `toast ${kind === 'err' ? 'err' : ''}`
    note.textContent = String(text)
    this.$('.toasts').append(note)
    setTimeout(() => note.remove(), kind === 'err' ? 6000 : 3200)
  }

  /** One line low over the yard, for a moment. */
  hint(text) {
    const pill = this.$('.hint-pill')
    pill.textContent = text
    pill.classList.add('on')
    clearTimeout(this._hint)
    this._hint = setTimeout(() => pill.classList.remove('on'), 2600)
  }

  /** The opening plate: says it is still waiting, or goes once the yard has answered. */
  boot(state, text = '') {
    const plate = this.$('.boot')
    if (!plate) return
    if (state === 'gone') return void plate.remove()
    plate.classList.toggle('waiting', state === 'waiting')
    if (text) plate.querySelector('p').textContent = text
  }

  /** How much of each edge of the window the panels cover, for centring the yard in the rest. */
  covered() {
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    const edge = (sel) => { const el = this.$(sel); return el && el.offsetParent ? el.getBoundingClientRect() : null }
    const top = edge('.studio-top')
    const dock = edge('.studio-dock')
    const crew = edge('.studio-crew')
    const rail = edge('.rail')
    return {
      top: top ? top.bottom : 0,
      left: dock ? dock.right : 0,
      bottom: crew ? Math.max(0, h - crew.top) : 0,
      right: rail && w > 900 ? Math.max(0, w - rail.left) : 0,
    }
  }
}
