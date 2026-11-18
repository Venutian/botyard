/**
 * The change, read in chapters, inside the review sheet: the heart of it first, then what it touches,
 * how it is checked and the glue, each with its two-line overview above the real diff. Lines are
 * numbered as in the file after the change; selecting any of them leaves a mark that says the file,
 * the lines and the chapter, and goes with the review's other marks.
 */
import { addPieceKind } from './marks.js'
import { esc, selectionIn } from './marks-core.js'

const read = new Map()

async function call(url) {
  const res = await fetch(url)
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `The service answered ${res.status}`)
  return out
}

/** A patch as rows, each with the line it is in the file after the change (or before, for a line taken out). */
export function diffRows(patch) {
  const rows = []
  let oldAt = 0
  let newAt = 0
  for (const line of String(patch || '').replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) { oldAt = Number(hunk[1]); newAt = Number(hunk[2]); rows.push({ kind: 'hunk', text: hunk[3].trim() || '…', at: '' }); continue }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), at: newAt++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), at: oldAt++ })
    else { rows.push({ kind: 'ctx', text: line.slice(1), at: newAt++ }); oldAt++ }
  }
  return rows
}

function chapterHtml(c, startRow, marked) {
  let n = startRow
  const files = c.files.map((f) => {
    const rows = f.binary ? [] : diffRows(f.patch)
    const body = rows.map((r) => {
      n += 1
      const pins = marked.get(`${f.path}:${r.at}`) || []
      return `<div class="mk-line ${r.kind}${pins.length ? ' marked' : ''}" data-n="${n}" data-at="${r.at}" data-file="${esc(f.path)}" data-ch="${esc(c.id)}"><span class="mk-text">${esc(r.text) || '&#8203;'}</span>${pins.length ? `<span class="mk-pins">${pins.map((p) => `<b>${p}</b>`).join('')}</span>` : ''}</div>`
    }).join('')
    return `<details class="mk-file" open><summary><b>${esc(f.path)}</b> <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></summary>${f.binary ? '<p class="mk-none small">A binary file: not shown.</p>' : `<div class="mk-diff">${body}</div>`}</details>`
  }).join('')
  return { html: `<section class="mk-chapter ${esc(c.kind)}"><h3>${esc(c.title)}</h3><p class="mk-overview ${c.by === 'model' ? 'model' : ''}">${esc(c.overview).replace(/\n/g, '<br>')}</p>${files}</section>`, rows: n }
}

addPieceKind('change', {
  async draw(box, piece, marks, api) {
    const job = api.state.jobId
    const marked = new Map()
    for (const m of marks) for (let l = m.line; l <= (m.lineEnd || m.line); l++) marked.set(`${m.file}:${l}`, [...(marked.get(`${m.file}:${l}`) || []), m.n])
    const paint = (data) => {
      let row = 0
      const parts = data.chapters.map((c) => { const out = chapterHtml(c, row, marked); row = out.rows; return out.html })
      const asked = data.chapters.some((c) => c.by === 'model')
      box.innerHTML = `<p class="mk-hint">Read it in chapters, the heart first. Select lines to mark them; each mark says the file, the lines and the chapter.
        ${asked ? '' : '<button type="button" class="link" data-plain>Overviews in plain words</button>'}</p>
        <p class="mk-branch"><code>${esc(data.branch)}</code> against <code>${esc(data.base)}</code>${data.commits?.length ? ` · ${data.commits.length} commit${data.commits.length === 1 ? '' : 's'}: ${esc(data.commits.slice(0, 3).map((c) => c.subject).join('; '))}` : ''}</p>
        <nav class="mk-toc">${data.chapters.map((c, i) => `<a href="#" data-ch="${i}">${esc(c.title)} <span>${c.files.length}</span></a>`).join('')}</nav>
        <div class="mk-text-body mk-change">${parts.join('')}</div>
        ${data.cut ? '<p class="mk-none small">Some of this was too long to show here: read the rest in the job\'s folder.</p>' : ''}`
      box.querySelector('[data-plain]')?.addEventListener('click', async (e) => {
        e.target.textContent = 'Asking a small model…'
        e.target.disabled = true
        try { read.set(job, await call(`/api/studio/marks/change?job=${encodeURIComponent(job)}&overview=1`)) } catch { /* the script's words stay */ }
        if (api.state?.current === piece.id) paint(read.get(job))
      })
      box.querySelectorAll('.mk-toc a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); box.querySelectorAll('.mk-chapter')[Number(a.dataset.ch)]?.scrollIntoView({ block: 'start' }) }))
      const body = box.querySelector('.mk-change')
      const offer = () => {
        const found = selectionIn(body)
        if (!found) return
        const first = body.querySelector(`.mk-line[data-n="${found.line}"]`)
        const rows = [...body.querySelectorAll('.mk-line')].filter((r) => Number(r.dataset.n) >= found.line && Number(r.dataset.n) <= found.lineEnd && r.dataset.file === first.dataset.file && r.dataset.at)
        if (!rows.length) return
        const at = rows.map((r) => Number(r.dataset.at))
        const line = Math.min(...at)
        const lineEnd = Math.max(...at)
        const chapter = data.chapters.find((c) => c.id === first.dataset.ch)?.title || ''
        api.pending({ kind: 'text', pieceId: piece.id, quote: found.quote, file: first.dataset.file, line, lineEnd, chapter, where: `${first.dataset.file}, ${line === lineEnd ? `line ${line}` : `lines ${line}–${lineEnd}`}` }, found.rect)
      }
      body.addEventListener('mouseup', () => setTimeout(offer, 0))
      body.addEventListener('touchend', () => setTimeout(offer, 350))
    }
    if (read.has(job)) return paint(read.get(job))
    box.innerHTML = '<p class="mk-none">Reading the change…</p>'
    try {
      read.set(job, await call(`/api/studio/marks/change?job=${encodeURIComponent(job)}`))
      if (api.state?.current === piece.id) paint(read.get(job))
    } catch (err) {
      box.innerHTML = `<p class="mk-none">${esc(err.message)}</p>`
    }
  },
})
