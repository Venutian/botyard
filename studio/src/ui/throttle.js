/**
 * The top bar's PC load control: a radio group of five levels (None, Light, Medium, Heavy, Full),
 * a state line, and a small popover to set Day and Night apart. Pure HTML from the state, so it is
 * tested in Node; `mountThrottle` wires it to the server's /api/studio/throttle.
 * Full is the only level that asks first, and while it holds the control offers Resume.
 * A yard with no throttle tool (the server answers `configured: false`) shows no control at all.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const LEVELS = ['none', 'light', 'medium', 'heavy', 'full']
export const NAMES = { none: 'None', light: 'Light', medium: 'Medium', heavy: 'Heavy', full: 'Full' }
export const CONFIRM = 'Pause all heavy work and stop new builds? Tony and checks keep running. You can resume any time.'
const STOP = '<svg class="ld-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
const HINTS = {
  none: 'None: the crew uses the PC freely', light: 'Light: a little work at a time', medium: 'Medium: half the usual work',
  heavy: 'Heavy: most work allowed', full: 'Full: all heavy work paused, no new builds',
}

/** The buttons and the state line. `ui` is `{ confirming, busy, error }`. */
export function throttleHtml(state, ui = {}) {
  const now = state?.now || ''
  const full = now === 'full'
  const seg = LEVELS.map((id) => {
    const on = id === now
    return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on || (!now && id === 'none') ? 0 : -1}" class="ld-seg ld-${id}${on ? ' on' : ''}" data-level="${id}" title="${esc(HINTS[id])}"${ui.busy ? ' aria-disabled="true"' : ''}>${id === 'full' ? STOP : ''}<span>${NAMES[id]}</span></button>`
  }).join('')
  const resume = full ? '<button type="button" class="ld-resume" data-act="load-resume">Resume</button>' : ''
  return `<span class="ld-label" id="ld-label">PC load</span>
<div class="ld-group${full ? ' is-full' : ''}" role="radiogroup" aria-labelledby="ld-label">${seg}</div>
${resume}<button type="button" class="ld-more" data-act="load-more" aria-expanded="${Boolean(ui.more)}" aria-controls="ld-pop" title="Set day and night apart" aria-label="Day and night settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
<span class="ld-line" role="status" aria-live="polite">${esc(ui.error || state?.line || '')}</span>
`
}

/** The popover and the question, drawn outside the bar (which clips) in their own layer. */
export function throttleLayerHtml(state, ui = {}) {
  const scope = ui.scope || 'both'
  const scopes = [['both', 'Day and night'], ['day', 'Day only'], ['night', 'Night only']]
    .map(([id, name]) => `<label class="ld-scope"><input type="radio" name="ld-scope" value="${id}"${scope === id ? ' checked' : ''}> ${name}</label>`).join('')
  const split = state?.day && state?.night ? `Day: ${esc(NAMES[state.day] || state.day)}. Night: ${esc(NAMES[state.night] || state.night)}.` : ''
  const confirm = ui.confirming
    ? `<div class="ld-confirm panel" role="alertdialog" aria-label="Full PC load"><p>${CONFIRM}</p><div class="ld-acts"><button type="button" class="btn primary" data-act="load-full-yes">Pause all</button><button type="button" class="btn ghost" data-act="load-full-no">Cancel</button></div></div>`
    : ''
  return `<div class="ld-pop panel" id="ld-pop" role="dialog" aria-label="Day and night load"${ui.more ? '' : ' hidden'}><p>${split}</p><fieldset><legend>A press sets</legend>${scopes}</fieldset></div>${confirm}`
}

/** Wire the control into `host`. `call(url, payload)` talks to the server. Returns `{ refresh, destroy }`. */
export function mountThrottle(host, { call, layer = host, every = 30_000 } = {}) {
  const ui = { scope: 'both', more: false, confirming: false, busy: false, error: '' }
  let state = null
  let timer = 0
  let before = 'none'
  const draw = () => {
    // Hidden until the server says this yard has a throttle tool, so a yard without one never sees it.
    const shown = state?.configured === true
    host.hidden = !shown; layer.hidden = !shown
    if (!shown) { host.innerHTML = ''; layer.innerHTML = ''; return }
    host.innerHTML = throttleHtml(state, ui); host.dataset.level = state?.now || ''
    layer.innerHTML = throttleLayerHtml(state, ui)
    const at = host.getBoundingClientRect(); const home = (layer.offsetParent || document.body).getBoundingClientRect()
    layer.style.top = `${Math.round(at.bottom - home.top + 10)}px`
    layer.style.right = `${Math.max(8, Math.round(home.right - at.right))}px`
  }
  const refresh = async () => {
    try { state = await call('/api/studio/throttle'); ui.error = '' } catch (err) { if (state) ui.error = err.message || 'The load could not be read' }
    draw()
  }
  const set = async (level) => {
    if (ui.busy) return
    if (state?.now && state.now !== 'full') before = state.now
    ui.busy = true; ui.confirming = false; draw()
    try { state = await call('/api/studio/throttle', { level, scope: ui.scope }); ui.error = '' } catch (err) { ui.error = err.message || 'The load could not be set' }
    ui.busy = false; draw()
    host.querySelector('.ld-seg.on')?.focus()
  }
  const onClick = (e) => {
    const level = e.target.closest('[data-level]')?.dataset.level
    if (level) return level === 'full' && state?.now !== 'full' ? (ui.confirming = true, draw()) : set(level)
    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'load-full-yes') return set('full')
    if (act === 'load-full-no') { ui.confirming = false; draw() }
    if (act === 'load-resume') return set(before)
    if (act === 'load-more') { ui.more = !ui.more; draw() }
  }
  host.addEventListener('click', onClick)
  if (layer !== host) layer.addEventListener('click', onClick)
  layer.addEventListener('change', (e) => { if (e.target.name === 'ld-scope') ui.scope = e.target.value })
  const onKey = (e) => {
    if (e.key === 'Escape' && (ui.more || ui.confirming)) { ui.more = ui.confirming = false; draw(); return }
    const i = LEVELS.indexOf(e.target.closest?.('[data-level]')?.dataset.level)
    if (i < 0 || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return
    e.preventDefault()
    const next = LEVELS[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : LEVELS.length - 1)) % LEVELS.length]
    host.querySelector(`[data-level="${next}"]`)?.focus()
  }
  host.addEventListener('keydown', onKey)
  if (layer !== host) layer.addEventListener('keydown', onKey)
  draw()
  refresh()
  timer = setInterval(refresh, every)
  return { refresh, close: () => { if (ui.more || ui.confirming) { ui.more = ui.confirming = false; draw() } }, destroy: () => clearInterval(timer) }
}
