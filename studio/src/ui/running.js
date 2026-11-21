/**
 * What runs on this computer now (server/lib/heavy.mjs): a chip in the top bar with what the crew takes of the PC,
 * and a list under it of the crew's work by bot and job, each with its heaviest programs, then the other heavy
 * programs. Pure HTML from the answer, so it is tested in Node.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 7300 MB → "7.1 GB", 300 → "300 MB". */
export const mem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`)
/** 392% of one core → "3.9 cores", 40 → "40% of a core". */
export const cpu = (pct) => (pct >= 100 ? `${(pct / 100).toFixed(1)} cores` : `${Math.round(pct)}% of a core`)
/** Seconds → "4 min", "2 h 10 min". */
export function age(s) {
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** The chip's words: how much of the PC the crew takes now. Empty until read. */
export function chipText(data) {
  if (!data?.readable) return ''
  const c = data.crew || {}
  if (!c.count) return 'PC: quiet'
  return `PC: ${Math.round((c.cpu / Math.max(1, data.cores)) )}% · ${mem(c.memMB)}`
}

/** How heavy the crew is on this PC now: 'calm', 'busy' or 'hot', for the chip's colour. */
export function chipLevel(data) {
  if (!data?.readable) return ''
  const share = (data.crew?.cpu || 0) / Math.max(1, data.cores)
  const memShare = (data.crew?.memMB || 0) / Math.max(1, data.totalMB)
  return share >= 60 || memShare >= 0.6 ? 'hot' : share >= 25 || memShare >= 0.3 ? 'busy' : 'calm'
}

const who = (w) => (w.kind === 'helper' ? `Timetable: ${esc(w.helper)}` : esc(w.bot || 'A bot'))
const what = (w) => (w.job ? `<span class="r-job">${esc(w.job.ref)}</span> ${esc(w.job.title)}` : w.kind === 'helper' ? 'a timetable helper' : 'no job named')

function workHtml(w) {
  const top = w.top.map((t) => `<li><span class="r-what">${esc(t.what)}${t.count > 1 ? ` <b>×${t.count}</b>` : ''}</span><small>${esc(cpu(t.cpu))} · ${esc(mem(t.memMB))}</small></li>`).join('')
  const open = w.runId && /^[0-9a-f-]{36}$/.test(w.runId) ? ` data-act="running-run" data-run="${esc(w.runId)}"` : ''
  return `<section class="u-row r-row${w.heavy ? ' is-heavy' : ''}">
    <header><b>${who(w)}</b><small>${esc(age(w.ageS))}</small>${w.leftOver ? '<span class="u-tag r-left" title="Its run has ended; Botyard stops what it left running ten minutes after the run">Left over</span>' : w.heavy ? '<span class="u-tag r-heavy">Heavy</span>' : ''}</header>
    <p class="r-for">${what(w)}</p>
    <p class="r-sum">${esc(cpu(w.cpu))} · ${esc(mem(w.memMB))} · ${w.count} program${w.count === 1 ? '' : 's'}${open ? ` · <button type="button" class="link"${open}>Open the run</button>` : ''}</p>
    <ul class="r-top">${top}</ul>
  </section>`
}

/** The list under the chip. */
export function runningHtml(data, now = Date.now()) {
  if (!data) return '<p class="u-empty">Reading what runs now…</p>'
  if (!data.readable) return `<p class="u-empty">${esc(data.why || 'What runs could not be read.')}</p>`
  const c = data.crew || {}
  const head = `<div class="u-head"><strong>Running now</strong><small>${c.count ? `The crew takes ${esc(cpu(c.cpu))} of ${data.cores} and ${esc(mem(c.memMB))} of ${esc(mem(data.totalMB))}. ${c.heavy} heavy.` : 'The crew is running nothing on this PC.'} Read at ${esc(new Date(data.at || now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}.</small></div>`
  const work = (data.work || []).map(workHtml).join('')
  const others = (data.others || []).filter((o) => !o.self)
  const rest = others.length
    ? `<section class="u-row r-others"><header><b>Other programs</b><small>not the crew's</small></header><ul class="r-top">${others.map((o) => `<li><span class="r-what">${esc(o.what)}</span><small>${esc(cpu(o.cpu))} · ${esc(mem(o.memMB))}</small></li>`).join('')}</ul></section>`
    : ''
  return head + work + rest
}
