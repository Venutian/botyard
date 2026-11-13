/**
 * Pictures open in the map, not in a new window: a click on any link marked `view-img` shows that picture
 * large, with a close button, back and next through the other pictures beside it (the same list or job),
 * the arrow keys and Esc, and a link to open the full file on its own.
 */
import './lightbox.css'

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ICON = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
}

let box = null
let list = []
let at = 0
let before = null

function build() {
  box = document.createElement('div')
  box.className = 'lightbox'
  box.hidden = true
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', 'Picture')
  box.innerHTML = `<figure>
      <img alt="">
      <figcaption><span class="lb-name"></span><span class="lb-count"></span><a class="lb-open" target="_blank" rel="noopener">Open the file</a></figcaption>
    </figure>
    <button type="button" class="lb-btn lb-close" data-lb="close" title="Close (Esc)" aria-label="Close">${ICON.close}</button>
    <button type="button" class="lb-btn lb-prev" data-lb="prev" title="Back (←)" aria-label="Previous picture">${ICON.prev}</button>
    <button type="button" class="lb-btn lb-next" data-lb="next" title="Next (→)" aria-label="Next picture">${ICON.next}</button>`
  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-lb]')?.dataset.lb
    if (act === 'close') return close()
    if (act === 'prev') return show(at - 1)
    if (act === 'next') return show(at + 1)
    if (!e.target.closest('img, figcaption')) close()  // a click on the dark around the picture
  })
  document.body.append(box)
}

function show(i) {
  if (!list.length) return
  at = (i + list.length) % list.length
  const { src, name } = list[at]
  const img = box.querySelector('img')
  img.src = src
  img.alt = name
  box.querySelector('.lb-name').textContent = name
  box.querySelector('.lb-count').textContent = list.length > 1 ? `${at + 1} of ${list.length}` : ''
  box.querySelector('.lb-open').href = src
  box.classList.toggle('single', list.length < 2)
  // the next one is read ahead, so stepping through feels instant
  if (list.length > 1) new Image().src = list[(at + 1) % list.length].src
}

function close() {
  if (!box || box.hidden) return
  box.hidden = true
  box.querySelector('img').removeAttribute('src')
  before?.focus?.()
}

/** Open the viewer on this link, with every picture link in the same gallery (or the same screen). */
export function openPicture(link) {
  if (!box) build()
  const root = link.closest('[data-gallery]') || link.closest('.studio-sheet, .studio-panel, .studio-chat') || document
  const links = [...root.querySelectorAll('a.view-img')]
  list = links.map((a) => ({ src: a.getAttribute('href'), name: a.dataset.name || a.title || a.querySelector('img')?.alt || '' }))
  before = document.activeElement
  box.hidden = false
  show(Math.max(0, links.indexOf(link)))
  box.querySelector('.lb-close').focus()
}

export const pictureOpen = () => !!box && !box.hidden

document.addEventListener('click', (e) => {
  const link = e.target.closest?.('a.view-img')
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  openPicture(link)
})

// Capture first, so Esc closes the picture and not the sheet under it.
window.addEventListener('keydown', (e) => {
  if (!pictureOpen()) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') show(at - 1)
  else if (e.key === 'ArrowRight') show(at + 1)
  else if (e.key === 'Tab') { const b = [...box.querySelectorAll('button, a')]; const i = b.indexOf(document.activeElement); b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus() }
  else return
  e.preventDefault()
  e.stopImmediatePropagation()
}, true)
