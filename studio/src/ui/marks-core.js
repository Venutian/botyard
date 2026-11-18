/**
 * The review sheet's own reckoning, apart from the page so the tests can read it: numbered lines, a
 * selection's place, a box from a drag, and what the engine is sent.
 */
export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Text as numbered lines; the number is drawn by CSS, so a selection never carries it. */
export function linesHtml(text, marked = new Map()) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line, i) => {
    const n = i + 1
    const pins = marked.get(n) || []
    const head = /^#{1,6}\s/.test(line) ? ' head' : ''
    return `<div class="mk-line${pins.length ? ' marked' : ''}${head}" data-n="${n}"><span class="mk-text">${esc(line) || '&#8203;'}</span>${pins.length ? `<span class="mk-pins">${pins.map((p) => `<b>${p}</b>`).join('')}</span>` : ''}</div>`
  }).join('')
}

/** Where a selection is in the numbered lines: the words and the first and last line, or null. */
export function selectionIn(root, sel = window.getSelection()) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const lineOf = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest('.mk-line')
  const a = lineOf(range.startContainer)
  const b = lineOf(range.endContainer)
  // The words alone: a mark's number badge on a line is not part of what the bot wrote.
  const part = range.cloneContents()
  part.querySelectorAll('.mk-pins').forEach((n) => n.remove())
  const rows = part.querySelectorAll('.mk-line')
  const quote = (rows.length ? [...rows].map((l) => l.querySelector('.mk-text')?.textContent || '').join('\n') : part.textContent).replace(/\u200b/g, '').trim()
  if (!quote || !a || !b) return null
  const from = Number(a.dataset.n)
  // A selection that runs to the very start of the next line (a triple click) ends on the line before.
  const to = Number(b.dataset.n) - (rows.length > 1 && !rows[rows.length - 1].querySelector('.mk-text')?.textContent.replace(/\u200b/g, '') ? 1 : 0)
  return { quote, line: Math.min(from, to), lineEnd: Math.max(from, to), rect: range.getBoundingClientRect() }
}

/** A box on a picture from two points, as fractions of the shown picture. */
export function boxFrom(a, b, rect) {
  const fx = (x) => Math.min(1, Math.max(0, (x - rect.left) / rect.width))
  const fy = (y) => Math.min(1, Math.max(0, (y - rect.top) / rect.height))
  const x1 = fx(a.x)
  const y1 = fy(a.y)
  const x2 = fx(b.x)
  const y2 = fy(b.y)
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
  // A drag under a few pixels is a tap: a point.
  if (box.w * rect.width < 6 && box.h * rect.height < 6) return { x: x1, y: y1, w: 0, h: 0 }
  return box
}

/** Where a mark is, said short, for the list on the right. */
export function markWhere(m) {
  if (m.kind === 'picture') return m.box.w || m.box.h ? 'a box on the picture' : 'a point on the picture'
  if (m.kind === 'page') return m.element || 'an element of the page'
  const lines = m.lineEnd && m.lineEnd !== m.line ? `lines ${m.line}–${m.lineEnd}` : `line ${m.line}`
  return m.file ? `${m.file}, ${lines}` : lines
}

/** What the engine is sent: each mark with its own piece. */
export function payloadOf(state, verdict, gateTo) {
  const pieces = new Set(state.marks.map((m) => m.pieceId))
  const only = pieces.size === 1 ? state.pieces.find((p) => p.id === [...pieces][0]) : null
  const first = only || state.pieces.find((p) => p.id === state.current) || state.pieces[0]
  const piece = only || !state.marks.length
    ? { kind: first?.kind || 'work', ref: first?.ref || '', title: first?.title || state.title }
    : { kind: 'work', ref: '', title: `${state.ref ? `${state.ref} ` : ''}${state.title}`.trim() }
  return {
    jobId: state.jobId,
    piece,
    verdict,
    note: state.note.trim(),
    ...(state.gate && verdict !== 'note' ? { gate: { tripId: state.gate.tripId, ...(gateTo ? { to: gateTo } : {}) } } : {}),
    marks: state.marks.map((m) => {
      const p = state.pieces.find((x) => x.id === m.pieceId) || {}
      const base = { kind: m.kind, comment: m.comment, piece: { kind: p.kind, ref: p.ref } }
      if (m.kind === 'text') return { ...base, quote: m.quote, line: m.line, lineEnd: m.lineEnd, ...(m.file ? { file: m.file } : {}), ...(m.chapter ? { chapter: m.chapter } : {}) }
      if (m.kind === 'picture') return { ...base, attachmentId: p.ref, box: m.box }
      return { ...base, url: m.url, element: m.element, text: m.text, box: m.box, ...(m.shotId ? { shotId: m.shotId } : {}) }
    }),
  }
}

