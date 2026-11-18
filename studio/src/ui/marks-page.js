/**
 * A live page on this computer, inside the review sheet: the owner opens a local address, uses the
 * page as usual to get where they want, then presses "Point at something" and clicks an element. The
 * mark carries the element, the page's address and a screenshot taken at the same size and scroll.
 * Only local addresses are taken (lib/look.mjs).
 */
import { addPieceKind } from './marks.js'
import { esc } from './marks-core.js'

const KEEP = 'botyard.look.recent'
const recent = () => { try { return JSON.parse(localStorage.getItem(KEEP) || '[]') } catch { return [] } }
const remember = (url) => { try { localStorage.setItem(KEEP, JSON.stringify([url, ...recent().filter((u) => u !== url)].slice(0, 6))) } catch { /* fine without */ } }
let open = null
let listening = null

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `The service answered ${res.status}`)
  return out
}

/** The element's box as fractions of the page's view, the way a picture's box is kept. */
export function boxOfPick(pick) {
  const f = (v, of) => Math.min(1, Math.max(0, v / of))
  const x = f(pick.rect.x, pick.view.w)
  const y = f(pick.rect.y, pick.view.h)
  return { x, y, w: Math.min(1 - x, f(pick.rect.w, pick.view.w)), h: Math.min(1 - y, f(pick.rect.h, pick.view.h)) }
}

addPieceKind('page', {
  draw(box, piece, marks, api) {
    const list = recent()
    box.innerHTML = `<p class="mk-hint">Open a page running on this computer, use it to get where you want, then press Point at something and click it.</p>
      <form class="mk-look-bar"><label class="mk-label" for="mk-look-url">Page address</label>
        <input id="mk-look-url" name="url" type="url" required placeholder="http://localhost:5173/" value="${esc(open?.url || list[0] || '')}" list="mk-look-recent">
        <datalist id="mk-look-recent">${list.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
        <button class="btn" type="submit">Open</button>
        <button class="btn primary" type="button" data-point aria-pressed="false" ${open ? '' : 'disabled'}>Point at something</button></form>
      <p class="mk-look-note"></p>
      ${marks.length ? `<p class="mk-none small">Marked on this page: ${marks.map((m) => `${m.n} (${esc(m.element || 'an element')})`).join(', ')}</p>` : ''}
      <div class="mk-look-frame">${open ? `<iframe title="The page" src="${esc(open.relay)}"></iframe>` : '<p class="mk-none">No page open yet.</p>'}</div>`
    const note = box.querySelector('.mk-look-note')
    const frame = () => box.querySelector('iframe')
    const pointer = box.querySelector('[data-point]')
    const point = (on) => { pointer.setAttribute('aria-pressed', String(on)); pointer.textContent = on ? 'Pointing: click the element' : 'Point at something'; frame()?.contentWindow?.postMessage({ type: 'botyard-look', on }, '*') }
    box.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      note.textContent = 'Opening…'
      try {
        open = await post('/api/studio/look', { url: e.target.url.value })
        remember(open.url)
        api.state && this.draw(box, piece, marks, api)
      } catch (err) { note.textContent = err.message }
    })
    pointer.addEventListener('click', () => point(pointer.getAttribute('aria-pressed') !== 'true'))
    if (listening) window.removeEventListener('message', listening)
    listening = (e) => {
      const pick = e.data
      if (!pick || pick.type !== 'botyard-look-pick' || !open || e.source !== frame()?.contentWindow) return
      point(false)
      const at = frame().getBoundingClientRect()
      const url = new URL(pick.path, open.origin).href
      const rect = { left: at.left + pick.rect.x, top: at.top + pick.rect.y, bottom: at.top + pick.rect.y + pick.rect.h }
      api.pending({
        kind: 'page', pieceId: piece.id, url, element: pick.element, text: pick.text, box: boxOfPick(pick),
        look: { url, width: pick.view.w, height: pick.view.h, scrollX: pick.scroll.x, scrollY: pick.scroll.y },
        where: `${pick.element}${pick.text ? ` (“${pick.text.slice(0, 40)}”)` : ''}`,
      }, rect)
    }
    window.addEventListener('message', listening)
  },
})
