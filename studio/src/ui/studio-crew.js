/**
 * The Bots, Runs and Models screens of the Studio sheet, as HTML. Pure functions of what the server
 * sent, so the Studio class only fetches, routes clicks and asks for confirms. Every screen answers
 * one question at the top and keeps the rest to one table.
 */
import { botStyle } from './crew-colours.js'
import { markdown } from './markdown.js'

export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 12 400 000 as "12.4M": the crew counts in millions, and a column of them must line up. */
export function tokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1e6) return `${Math.round(v / 1000)}k`
  if (v < 1e9) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`
  return `${(v / 1e9).toFixed(1)}B`
}

const pct = (share) => `${Math.round((Number(share) || 0) * 100)}%`
export const when = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
export const duration = (s) => (s == null ? '' : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`)
export const jobLink = (job) => (job ? `<button class="link" data-act="open-job" data-id="${esc(job.id)}" title="${esc(job.title)}"><b>${esc(job.ref)}</b> ${esc(job.title)}</button>` : '<span class="dim">No job</span>')

/** A bot's waste in one cell: share of runs, tokens, and the flag past 30 %. */
function wasteCell(w) {
  if (!w || !w.runs) return '<span class="dim">No runs</span>'
  if (!w.wasted) return `<span class="dim">None of ${w.runs}</span>`
  return `<span class="${w.flagged ? 'bad' : ''}" title="${esc(w.causes.map((c) => `${c.count}× ${c.text}`).join('\n'))}">${w.wasted} of ${w.runs} runs, ${tokens(w.wastedTokens)}</span>`
}

const stateClass = (b) => (b.status === 'running' ? 'go' : b.status === 'error' ? 'bad' : b.status === 'paused' ? 'warn' : '')

// ── Bots ────────────────────────────────────────────────────────────────────────

/**
 * "Who is on what, and is anyone stuck or wasting runs?" `live` is the map's own view of each bot,
 * which knows the job it is on this minute.
 */
export function botsScreen(list, live, face) {
  const flagged = list.bots.filter((b) => b.waste?.flagged)
  const flags = flagged.map((b) => `<p class="flag bad opt"><i></i><span><b>${esc(b.name)}</b>: ${pct(b.waste.share)} of its runs in the last day bought nothing (${b.waste.wasted} of ${b.waste.runs}, ${tokens(b.waste.wastedTokens)} tokens). ${esc(b.waste.causes.map((c) => `${c.text} ${c.count}×`).join('; '))}.</span></p>`).join('')
  const rows = list.bots.map((b) => {
    const now = live.get(b.id)
    const doing = now?.job ? (/[A-Z]+-\d+/.test(now.job.stage) ? esc(now.job.stage) : `${esc(now.job.stage)} <b>${esc(now.job.ref)}</b>`) : esc(b.state)
    return `<tr class="go-row bot-row" style="${botStyle(b.name)}" data-act="open-bot" data-id="${esc(b.id)}" tabindex="0">
      <td class="who">${face(b)}<span><b>${esc(b.name)}</b><small>${esc(b.title)}</small></span></td>
      <td><span class="state ${stateClass(b)}">${doing}</span></td>
      <td class="opt"><span>${esc(b.engine)}${b.model ? ` · ${esc(b.model)}` : ''}</span><small>${esc(b.why)}</small></td>
      <td class="n opt">${tokens(b.tokensToday)}</td>
      <td class="n wk opt">${tokens(b.tokensWeek)}</td>
      <td class="opt">${wasteCell(b.waste)}</td>
    </tr>`
  }).join('')
  const tree = (nodes) => (nodes.length ? `<ul>${nodes.map((n) => `<li><button class="link" data-act="open-bot" data-id="${esc(n.id)}">${esc(n.name)}</button>${tree(n.reports)}</li>`).join('')}</ul>` : '')
  if (!list.bots.length) return `<p class="none">This studio has no bots yet. A bot is one AI with a job: it reads its instructions, takes work and reports back.</p>
    <div class="acts"><button class="btn primary" data-act="bot-new">Add a bot</button></div>`
  return `${flags || '<p class="flag good opt"><i></i><span>No bot is past 30% wasted runs in the last day.</span></p>'}
    <div class="acts"><button class="btn" data-act="bot-new">Add a bot</button></div>
    <div class="grid-wrap"><table class="grid bots">
      <thead><tr><th>Bot</th><th>Now</th><th class="opt">Engine, and why</th><th class="n opt">Tokens today</th><th class="n wk opt">7 days</th><th class="opt" title="Runs that failed, timed out or were stopped, in the last day">Wasted, last day</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Tokens are new tokens in and out; reading from cache is not counted.${list.wasteStale && list.wasteAt ? ' The count of wasted runs is more than two hours old: the helper that counts them may be off (see Routines).' : list.wasteAt ? ` Waste counted ${esc(when(list.wasteAt))}.` : ''}</p>
    <details class="org"><summary>Who reports to whom</summary>${tree(list.org)}</details>`
}

/** One bot: what it is doing and on what, what it costs, its runs, and what it is told. */
export function botScreen(b, live) {
  const stage = live?.job ? `<small>${esc(live.job.stage)}${live.job.minutes ? `, ${live.job.minutes} min in` : ''}</small>` : ''
  const facts = [
    ['Now', `<span class="state ${stateClass(b)}">${esc(b.state)}</span>${b.restingWhy ? ` <small>${esc(b.restingWhy)}</small>` : ''}`],
    ['On', b.job ? `${jobLink(b.job)}${stage}` : live?.job ? `${jobLink({ id: live.job.id, ref: live.job.ref, title: live.job.title })}${stage}` : '<span class="dim">No job now</span>'],
    ['Engine', `${esc(b.engine)}${b.model ? ` · ${esc(b.model)}` : ''}<small>${esc(b.why)}</small>`],
    ['Used', `${tokens(b.today.tokens)} today, ${tokens(b.week.tokens)} in 7 days${b.week.cents ? `, $${(b.week.cents / 100).toFixed(2)}` : ''}`],
    ['Wasted', b.waste?.runs ? `${wasteCell(b.waste)}${b.waste.causes.length ? `<small>${esc(b.waste.causes.map((c) => `${c.text} ${c.count}×`).join('; '))}</small>` : ''}` : '<span class="dim">No runs in the last day</span>'],
    ['Reports to', esc(b.reportsTo || 'Nobody: it leads the crew') + (b.reports.length ? `<small>${esc(b.reports.join(', '))} report${b.reports.length === 1 ? 's' : ''} to it</small>` : '')],
  ]
  const ins = b.instructions
  const paused = b.status === 'paused'
  const runs = b.runs.length ? `<div class="grid-wrap"><table class="grid">
      <thead><tr><th>When</th><th>Job</th><th>How it ended</th><th class="n">Took</th><th class="n">Tokens</th></tr></thead>
      <tbody>${b.runs.map((r) => runRowHtml(r, false)).join('')}</tbody></table></div>` : '<p class="none">No runs yet.</p>'
  const instructions = !ins && b.pending ? '<p class="hint">Its instructions are still being read.</p>' : ins ? `<details class="instructions"><summary>What it is told (${ins.content.split('\n').length} lines)</summary>
      <div class="said doc" data-part="instr-text">${markdown(ins.content)}</div></details>` : ''
  const revisions = b.revisions.length ? `<details><summary>Settings history (${b.revisions.length})</summary><table class="grid slim"><tbody>${b.revisions.map((r, i) => `<tr><td>${esc(when(Date.parse(r.at)))}</td><td>${esc(r.what)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}<small>${esc(r.by)}</small></td><td class="n">${i ? `<button class="btn ghost" data-act="rollback" data-id="${esc(r.id)}">Roll back to this</button>` : '<span class="dim">Current</span>'}</td></tr>`).join('')}</tbody></table></details>` : ''
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="acts">
      <button class="btn" data-act="pause" data-bot="${esc(b.id)}">${paused ? 'Resume' : 'Pause'}</button>
      <button class="btn" data-act="talk" data-id="${esc(b.id)}">Talk to ${esc(b.name.split(' ')[0])}</button>
      <button class="btn" data-act="bot-edit" data-id="${esc(b.id)}">Change its settings</button>
      <button class="btn" data-act="bot-rules" data-id="${esc(b.id)}">${ins?.managed === false ? 'Read' : 'Edit'} its instructions</button>
      <button class="btn" data-act="reset" title="${b.sessions} saved conversation${b.sessions === 1 ? '' : 's'}">Start fresh conversations</button>
      <button class="btn ghost" data-act="bot-runs" data-id="${esc(b.id)}">All its runs</button>
    </div>
    <h3>${b.runs.length ? `Last ${b.runs.length} run${b.runs.length === 1 ? '' : 's'}` : 'Runs'}</h3>${runs}
    ${instructions}
    ${b.skills.length ? `<p class="hint"><b>Skills:</b> ${esc(b.skills.join(', '))}</p>` : b.skillsPending ? '<p class="hint"><b>Skills:</b> still being read, they show on the next open.</p>' : ''}
    ${revisions}`
}

/** The confirm a change of instructions shows first: what goes and what comes in. */
export function diffHtml(d) {
  return `<div class="diff"><pre>${esc(d.before)}<del>${esc(d.removed)}</del><ins>${esc(d.added)}</ins>${esc(d.after)}</pre></div>`
}

/** A line-level summary of an edit, for the confirm before saving. */
export function editSummary(before, after) {
  const a = before.split('\n'), b = after.split('\n')
  const setA = new Set(a), setB = new Set(b)
  const gone = a.filter((l) => !setB.has(l)).length
  const came = b.filter((l) => !setA.has(l)).length
  return `${came} line${came === 1 ? '' : 's'} added or changed, ${gone} removed`
}

// ── Runs and activity ───────────────────────────────────────────────────────────

export function runRowHtml(r, withBot = true) {
  return `<tr class="go-row ${r.failed ? 'failed' : ''}" data-act="open-run" data-id="${esc(r.id)}" tabindex="0">
    <td class="t">${esc(when(r.at))}</td>
    ${withBot ? `<td class="nowrap">${esc(r.bot)}</td>` : ''}
    <td class="job">${r.job ? `<b>${esc(r.job.ref)}</b> ${esc(r.job.title)}` : '<span class="dim">No job</span>'}</td>
    <td><span class="state ${r.failed ? 'bad' : r.status === 'running' ? 'go' : ''}">${esc(r.state)}</span>${r.why ? `<small>${esc(r.why)}</small>` : ''}</td>
    <td class="n">${esc(duration(r.seconds))}</td>
    <td class="n">${r.tokens ? tokens(r.tokens) : ''}</td>
  </tr>`
}

const STATUS_FILTERS = [['', 'All'], ['failed', 'Failed or stopped'], ['running', 'Running'], ['succeeded', 'Done']]

/** "What ran, and what went wrong?" Filters, one table of runs or the timeline, and a pager. */
export function runsScreen({ view, filter, data }) {
  const bots = data.bots || []
  const head = `<div class="filters">
    <div class="seg" role="tablist">${[['runs', 'Runs'], ['activity', 'Activity']].map(([id, name]) => `<button role="tab" aria-selected="${view === id}" class="${view === id ? 'on' : ''}" data-act="runs-view" data-view="${id}">${name}</button>`).join('')}</div>
    <label>Bot <select data-filter="bot"><option value="">Everyone</option>${bots.map((b) => `<option value="${esc(b.id)}" ${filter.bot === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
    ${view === 'runs' ? `<label>Ended <select data-filter="status">${STATUS_FILTERS.map(([id, name]) => `<option value="${id}" ${filter.status === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>` : ''}
  </div>`
  const pager = data.pages > 1 ? `<div class="pager"><button class="btn ghost" data-act="page" data-by="-1" ${data.page === 0 ? 'disabled' : ''}>Newer</button><span>Page ${data.page + 1} of ${data.pages}</span><button class="btn ghost" data-act="page" data-by="1" ${data.page >= data.pages - 1 ? 'disabled' : ''}>Older</button></div>` : ''
  if (view === 'activity') {
    const items = data.items || []
    return head + (items.length ? `<table class="grid activity"><tbody>${items.map((i) => `<tr>
      <td class="t">${esc(when(i.at))}</td>
      <td><b>${esc(i.who)}</b> ${esc(i.what)} ${i.job ? `<button class="link" data-act="open-job" data-id="${esc(i.job.id)}">${esc(i.job.ref)}</button> <span class="dim">${esc(i.job.title)}</span>` : ''}${i.to ? ` for ${esc(i.to)}` : ''}${i.times > 1 ? ` <span class="dim">(${i.times} times)</span>` : ''}${i.run ? ` <button class="link" data-act="open-run" data-id="${esc(i.run)}">See the run</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="none">Nothing happened in the last week.</p>') + pager
  }
  const runs = data.runs || []
  return head + (runs.length ? `<div class="grid-wrap"><table class="grid">
    <thead><tr><th>When</th><th>Bot</th><th>Job</th><th>How it ended</th><th class="n">Took</th><th class="n">Tokens</th></tr></thead>
    <tbody>${runs.map((r) => runRowHtml(r)).join('')}</tbody></table></div>` : '<p class="none">No runs match.</p>') + pager
}

/** One run: how it ended and why, what it used, its job, and the end of its log. */
export function runScreen(r) {
  const facts = [
    ['Ended', `<span class="state ${r.failed ? 'bad' : r.status === 'running' ? 'go' : ''}">${esc(r.state)}</span>${r.why ? `<small>${esc(r.why)}</small>` : ''}`],
    ['Job', r.job ? jobLink(r.job) : '<span class="dim">No job</span>'],
    ['Started', `${esc(when(r.at))}${r.started ? `, ${esc(r.started.toLowerCase())}` : ''}${r.seconds != null ? `; took ${esc(duration(r.seconds))}` : ''}`],
    ['Used', `${tokens(r.tokens)} tokens${r.cached ? `, ${tokens(r.cached)} read from cache` : ''}${r.usd ? `; $${r.usd.toFixed(2)} at API prices` : ''}`],
    ...(r.model ? [['Model', esc(r.model)]] : []),
  ]
  const SIGN = { said: '', tool: '›', note: '·', error: '!' }
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="acts"><button class="btn" data-act="open-bot" data-id="${esc(r.botId)}">${esc(r.bot)}'s page</button></div>
    <h3>${r.trimmed ? 'The end of its log' : 'Its log'}</h3>
    ${r.log.length ? `<ol class="log">${r.log.map((l) => `<li class="${l.kind}"><i>${SIGN[l.kind]}</i><span>${esc(l.text)}</span></li>`).join('')}</ol>` : '<p class="none">The run wrote nothing a person reads.</p>'}`
}

// ── Models, limits and money ────────────────────────────────────────────────────

/** Ten cells filled to a share: the same meter as the top bar's, wherever a part of a whole is shown. */
export const cellsHtml = (share) => `<i class="cells" role="img" aria-label="${Math.round(Math.min(1, Math.max(0, share)) * 100)}%">${Array.from({ length: 10 }, (_, n) => `<u class="${Math.min(1, Math.max(0, share)) * 10 > n + 0.05 ? 'on' : ''}"></u>`).join('')}</i>`

/** A table of names and token counts, each with a bar against the biggest: a chart that is also a table. */
function shareTable(title, rows, limit = 8) {
  if (!rows.length) return ''
  const top = rows[0].tokens || 1
  return `<div class="share"><h3>${title}</h3><table class="grid slim"><tbody>${rows.slice(0, limit).map((r) => `<tr><td>${esc(r.name)}</td><td class="bar">${cellsHtml(r.tokens / top)}</td><td class="n">${tokens(r.tokens)}</td></tr>`).join('')}</tbody></table></div>`
}

/** "How close is the crew to its limits, and what is using them?" */
export function moneyScreen(m, plans) {
  const meter = (name, plan) => {
    if (!plan) return ''
    const share = Math.min(1, Math.max(0, plan.week || 0))
    const level = share >= 0.9 ? 'bad' : share >= 0.75 ? 'warn' : ''
    return `<div class="limit ${level}"><b>${name}</b>${cellsHtml(share)}<em>${pct(share)} of the week</em></div>`
  }
  const p = m.pace
  const pace = p ? (() => {
    const fast = p.perHourAllowed && p.perHourNow > p.perHourAllowed
    return `<p class="flag ${fast ? 'warn' : 'good'}"><i></i><span>Claude pace: ${(p.perHourNow * 100).toFixed(1)}% of the week an hour now, ${(p.perHourAllowed * 100).toFixed(1)}% allowed to last until the reset${p.resets ? ` (${esc(when(p.resets))})` : ''}.${fast ? ' The token guard is slowing the crew.' : ''}</span></p>`
  })() : ''
  const quotas = m.quotas.map((q) => q.windows.map((w) => `<div class="limit"><b>${esc(q.name)} ${esc(w.label)}</b>${cellsHtml(w.used / 100)}<em>${Math.round(w.used)}%</em></div>`).join('')).join('')
  const windows = m.windows.rows.length ? `<h3>Tokens in each window the providers count</h3><table class="grid slim"><thead><tr><th>Provider</th><th class="n">5 hours</th><th class="n">24 hours</th><th class="n">7 days</th></tr></thead><tbody>${m.windows.rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${tokens(r['5h'])}</td><td class="n">${tokens(r['24h'])}</td><td class="n">${tokens(r['7d'])}</td></tr>`).join('')}</tbody></table>` : ''
  return `<div class="limits">${plans ? meter('Claude', plans.claude) + meter('Codex', plans.codex) : ''}${quotas}</div>
    ${pace}
    <h3>Each bot, last 7 days</h3>
    <div class="grid-wrap"><table class="grid">
      <thead><tr><th>Bot</th><th>Engine now</th><th class="n">Today</th><th class="n">7 days</th><th class="n">Runs</th><th class="n" title="Tokens of runs that bought nothing">Wasted, last day</th></tr></thead>
      <tbody>${m.bots.map((b) => `<tr class="go-row" data-act="open-bot" data-id="${esc(b.id)}" tabindex="0"><td><b>${esc(b.name)}</b></td><td>${esc(b.engine)}${b.model ? ` · ${esc(b.model)}` : ''}</td><td class="n">${tokens(b.today)}</td><td class="n">${tokens(b.tokens)}</td><td class="n">${b.runs}</td><td class="n ${b.waste ? 'warnish' : 'dim'}">${b.waste ? tokens(b.waste) : '0'}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="shares">${shareTable('By model', m.models)}${shareTable('By provider', m.providers)}${shareTable('By project', m.projects)}</div>
    ${windows}
    <p class="hint">The crew runs on subscriptions and free models, so it is counted in new tokens (in and out), not money${m.priced ? '; dollars show where a run was priced' : ''}.</p>
    <h3>Models</h3>
    <div data-part="settings-models"><p class="none">Reading…</p></div>`
}
