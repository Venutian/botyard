/**
 * Pages of the owner's own on the map (server/lib/own-pages.mjs): the list for the rail, and putting
 * one on the sheet. A page's script is an ES module in the owner's home folder:
 *
 *   export function mount(el, tools) { ... }   // may return a function that tidies up
 *
 * `el` is the page's own box inside the sheet. `tools` is small on purpose: `call(path, payload)` asks
 * the page's own server file (GET, or POST when there is a payload) and gives back the JSON or throws
 * with the server's words; `url(path)` is that call's address, for a link that saves a file;
 * `markdown(text)` and `esc(text)` are the map's own; `toast(text)` says one line to the owner.
 */
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The rail's id of an own page, and back. A page's name can never be one of the map's own ids. */
export const ownId = (name) => `own:${name}`
export const ownName = (id) => (typeof id === 'string' && id.startsWith('own:') ? id.slice(4) : '')

/** The rail entries for the pages the server listed: after the map's own, in a group of their own. */
export const ownDock = (pages = []) => pages.map((p) => ({ id: ownId(p.name), name: p.title, icon: 'page', screen: true, group: 'own', title: p.does || p.title }))

/** The pages this yard has, or none: a yard without the folder, an older server and the demo all answer none. */
export async function loadOwnPages(fetcher = fetch) {
  try {
    const res = await fetcher('/api/studio/own')
    if (!res.ok) return []
    const { pages } = await res.json()
    return (Array.isArray(pages) ? pages : []).filter((p) => p && /^[a-z0-9][a-z0-9-]{0,31}$/.test(p.name) && typeof p.script === 'string' && p.script.startsWith(`/api/studio/own/${p.name}/files/`))
  } catch {
    return []
  }
}

/** What a page's script is handed. */
export function ownTools(page, { markdown, toast, fetcher = fetch } = {}) {
  const base = `/api/studio/own/${page.name}/api`
  const url = (path = '/') => `${base}${String(path).startsWith('/') ? path : `/${path}`}`
  return {
    name: page.name, esc, markdown, toast, url,
    async call(path, payload) {
      let res
      try {
        res = await fetcher(url(path), payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined)
      } catch {
        throw new Error('Botyard\'s own server is not answering. It may be restarting: try again in a moment')
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
      return body
    },
  }
}

/**
 * Put a page into `body` (the sheet's body). Its stylesheet is linked once; its script is loaded and
 * its `mount` called on a box of its own, so nothing it listens to outlives the box.
 * @returns {Promise<() => void>} what tidies the page up when the sheet moves on
 */
export async function mountOwnPage(page, body, tools, { doc = document, load = (src) => import(/* @vite-ignore */ src) } = {}) {
  if (page.style && !doc.querySelector(`link[data-own-page="${page.name}"]`)) {
    const link = doc.createElement('link')
    Object.assign(link, { rel: 'stylesheet', href: page.style })
    link.dataset.ownPage = page.name
    doc.head.append(link)
  }
  body.innerHTML = `<div class="own-page" data-own-page="${esc(page.name)}"><p class="none">Reading…</p></div>`
  const el = body.firstElementChild
  try {
    const mod = await load(page.script)
    const mount = mod.mount || mod.default
    if (typeof mount !== 'function') throw new Error('its script exports no mount(el, tools)')
    const tidy = await mount(el, tools)
    return typeof tidy === 'function' ? tidy : () => {}
  } catch (err) {
    if (el.isConnected !== false) el.innerHTML = `<p class="none">The page "${esc(page.title)}" could not be shown: ${esc(err?.message || err)}</p>`
    return () => {}
  }
}
