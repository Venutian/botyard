/**
 * A page left open keeps up with the service: after a restart on a new build, it reloads itself.
 *
 * The service's /api/health says which build it hands out (`page`, the hashed name of the entry
 * script); the page knows its own from its script tag. When they differ the page reloads, but never
 * under the owner's hands: not while a field has the focus or a dialog or question is open, and then
 * it tries again at the next look. A page served by the dev server (no hashed name) never reloads.
 */

/** This page's own build: the hashed entry script it was loaded with, or '' (the dev server). */
export function ownBuild(doc = document) {
  const src = [...doc.querySelectorAll('script[type="module"][src]')].map((s) => s.getAttribute('src')).find((s) => /assets\/[^/]+\.js$/.test(s)) || ''
  return src.replace(/^\//, '')
}

/** Whether the owner is in the middle of something a reload would lose. */
export function busy(doc = document) {
  const at = doc.activeElement
  if (at && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName))) return true
  return Boolean(doc.querySelector('[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden]), dialog[open]'))
}

/** Whether to reload now: the service hands out another build and the owner is not busy. */
export function shouldReload(own, served, isBusy) {
  return Boolean(own && served && own !== served && !isBusy)
}

/** Look every `every` ms. Returns a stop function. */
export function keepFresh({ every = 60_000, doc = document, fetcher = fetch, reload = () => location.reload() } = {}) {
  const own = ownBuild(doc)
  if (!own) return () => {}
  const look = async () => {
    try {
      const health = await (await fetcher('/api/health', { cache: 'no-store' })).json()
      if (shouldReload(own, health.page, busy(doc))) reload()
    } catch { /* the service is restarting: look again later */ }
  }
  const timer = setInterval(look, every)
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') look() })
  return () => clearInterval(timer)
}
