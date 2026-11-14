/**
 * The top bar's usage list: for each AI the crew runs on, how much is used and how much is left where
 * that is known, as /api/studio/usage gives it. Pure HTML from the data, so it is tested in Node.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 12 400 000 as "12.4M". */
export function count(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1e6) return `${Math.round(v / 1000)}k`
  if (v < 1e9) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`
  return `${(v / 1e9).toFixed(1)}B`
}

/** 1087 seconds as "18 min"; 5400 as "1.5 h". */
export function span(seconds) {
  const m = Math.round((Number(seconds) || 0) / 60)
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`
}

/** An epoch second as a time of day, with the weekday when it is not today. */
export function at(stamp, now = Date.now()) {
  if (!stamp) return ''
  const d = new Date(stamp * 1000)
  const today = new Date(now).toDateString() === d.toDateString()
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Ten cells filled to a share, and its level: the same meter as the top bar's. */
function meter(label, share, says) {
  const s = Math.min(1, Math.max(0, share))
  const level = s >= 0.9 ? 'bad' : s >= 0.75 ? 'warn' : ''
  const cells = Array.from({ length: 10 }, (_, n) => `<u class="${s * 10 > n + 0.05 ? 'on' : ''}"></u>`).join('')
  return `<div class="u-meter ${level}"><span class="u-what">${esc(label)}</span><i class="cells" role="img" aria-label="${Math.round(s * 100)}% used">${cells}</i><em>${esc(says)}</em></div>`
}

const STATE = { answering: 'Answering', aside: 'Set aside', unchecked: 'Not tried yet' }

/** One free model's line: whether it answers, and what its own history says is left or when it is back. */
function modelLine(m, now) {
  let says = STATE[m.state] || m.state
  if (m.state === 'aside') says = m.back ? (m.back * 1000 < now ? 'Out, being tried again' : `Out, usually back about ${at(m.back, now)}`) : 'Out, back time not known yet'
  else if (m.usualSeconds) says = `${m.leftSeconds != null ? `about ${span(m.leftSeconds)} left` : 'answering'} of the ${span(m.usualSeconds)} it usually gives`
  else if (m.state === 'answering') says = 'Answering; its limit is not known yet'
  return `<li class="${esc(m.state)}" ${m.why ? `title="${esc(m.why)}"` : ''}><i aria-hidden="true"></i><span class="u-model">${esc(m.label)}</span><small>${esc(says)}${m.limit ? `. Its own limit: ${esc(m.limit)}` : ''}</small></li>`
}

/** One provider's block. */
function rowHtml(p, now) {
  const head = []
  if (p.week != null) head.push(meter('Week', p.week, `${Math.round(p.week * 100)}% used${p.resets ? `, resets ${at(p.resets, now)}` : ''}`))
  if (p.fiveHours != null) head.push(meter('5 hours', p.fiveHours, `${Math.round(p.fiveHours * 100)}% used${p.fiveHoursResets ? `, resets ${at(p.fiveHoursResets, now)}` : ''}`))
  if (p.day) head.push(meter('Today', p.day.share ?? 0, `${p.day.left.toLocaleString()} of ${p.day.limit.toLocaleString()} free requests left`))
  const t = p.tokens || {}
  const used = t['7d'] ? `<p class="u-tokens">Tokens: <b>${count(t['5h'])}</b> in 5 h · <b>${count(t['24h'])}</b> in a day · <b>${count(t['7d'])}</b> in a week</p>` : '<p class="u-tokens dim">No tokens this week</p>'
  const models = p.models || []
  const answering = models.filter((m) => m.state === 'answering').length
  const list = models.length ? `<details class="u-models" ${p.kind === 'free' && models.length <= 4 ? 'open' : ''}><summary>${p.kind === 'free' ? `${answering} of ${models.length} model${models.length === 1 ? '' : 's'} answering` : `${models.length} model${models.length === 1 ? '' : 's'} used up`}</summary><ul>${models.map((m) => modelLine(m, now)).join('')}</ul></details>` : ''
  const badge = p.kind === 'free' ? '<span class="u-tag">Free</span>' : p.kind === 'plan' ? '<span class="u-tag plan">Subscription</span>' : ''
  return `<section class="u-row ${esc(p.kind)}" data-provider="${esc(p.id)}">
    <header><b>${esc(p.name)}</b>${p.sub ? `<small>${esc(p.sub)}</small>` : ''}${badge}</header>
    ${head.join('')}${used}${list}
    ${p.note ? `<p class="u-note">${esc(p.note)}</p>` : ''}
  </section>`
}

/** The whole list. */
export function usageHtml(data, now = Date.now()) {
  const providers = data?.providers || []
  if (!providers.length) return '<p class="u-empty">No AI has been used yet: the list fills as the crew works.</p>'
  return `<div class="u-head"><strong>Usage of each AI</strong><small>Read at ${esc(new Date(data.at || now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}. Free limits are learned from each model's own history: typical, not promised.</small></div>
    ${providers.map((p) => rowHtml(p, now)).join('')}
    <p class="u-foot"><button type="button" class="link" data-act="usage-more">Models, limits and money</button></p>`
}
