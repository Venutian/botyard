/**
 * What a person may choose about the map: day or night, how fine the picture is, and whether the
 * browser may notify them. Kept in this browser only; nothing here is the yard's own state.
 */
const KEY = 'botyard.map.v2'

export const QUALITIES = {
  low: { name: 'Low', pixels: 1, shadows: 0, smooth: false },
  mid: { name: 'Medium', pixels: 1.5, shadows: 1024, smooth: true },
  high: { name: 'High', pixels: 2, shadows: 2048, smooth: true },
}

const START = { shift: 'day', quality: 'mid', notify: false }

const tidy = (raw = {}) => ({
  shift: raw.shift === 'night' ? 'night' : 'day',
  quality: Object.hasOwn(QUALITIES, raw.quality) ? raw.quality : START.quality,
  notify: raw.notify === true,
})

export class MapSettings {
  /** @param {Storage} [store] where the choices are kept; a test gives its own */
  constructor(store = globalThis.localStorage) {
    this.store = store
    this.listeners = new Set()
    let kept = null
    try { kept = JSON.parse(store?.getItem(KEY) || 'null') } catch { /* a torn value starts afresh */ }
    this.values = tidy(kept || START)
  }

  get(name) { return this.values[name] }

  set(name, value) {
    const next = tidy({ ...this.values, [name]: value })
    if (next[name] === this.values[name]) return false
    this.values = next
    try { this.store?.setItem(KEY, JSON.stringify(next)) } catch { /* a private window keeps it for the visit */ }
    for (const tell of this.listeners) tell(name, next[name])
    return true
  }

  /** @param {(name: string, value: unknown) => void} tell called after every change */
  watch(tell) {
    this.listeners.add(tell)
    return () => this.listeners.delete(tell)
  }
}
