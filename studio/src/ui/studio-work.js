/**
 * The Jobs, Job, Routines and Library screens of the Studio sheet, and what a project's page adds,
 * as HTML. Pure functions of what the server sent, like `studio-crew.js`: the Studio class fetches,
 * routes clicks and asks for confirms. Each screen answers one question and keeps to one table.
 */
import { markdown, plainText } from './markdown.js'
import { duration, esc, jobLink, runRowHtml, tokens, when } from './studio-crew.js'
import { whenPicker } from './studio-shape.js'

const at = (iso) => when(typeof iso === 'number' ? iso : Date.parse(iso || '') || 0)
const STATE_CLASS = { in_progress: 'go', in_review: 'warn', blocked: 'bad', cancelled: 'dim', done: 'done' }
const stateHtml = (j) => `<span class="state ${STATE_CLASS[j.status] || ''}">${esc(j.state)}</span>`
const PRIORITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const fileUrl = (id) => `/api/studio/file?id=${encodeURIComponent(id)}`
const md = (text) => markdown(text, { jobs: true })

// ── Jobs ────────────────────────────────────────────────────────────────────────

export const PILES = [['active', 'Active'], ['backlog', 'Backlog'], ['done', 'Done'], ['', 'All']]

/** "Where is that job?" A pile, a project, a bot and words; one table; a pager. */
export function jobsScreen({ filter, data }) {
  const pick = (name, label, all, list) => `<label>${label} <select data-jobs="${name}"><option value="">${all}</option>${list.map((x) => `<option value="${esc(x.id)}" ${filter[name] === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
  const head = `<form class="filters" data-part="jobs-filter">
    <div class="seg" role="tablist">${PILES.map(([id, name]) => `<button type="button" role="tab" aria-selected="${filter.pile === id}" class="${filter.pile === id ? 'on' : ''}" data-act="jobs-pile" data-pile="${id}">${name}</button>`).join('')}</div>
    ${pick('project', 'Project', 'Every one', data.projects || [])}
    ${pick('bot', 'Bot', 'Everyone', data.bots || [])}
    <input class="search" type="search" name="q" value="${esc(filter.q)}" placeholder="Search titles, details and comments" maxlength="120" aria-label="Search jobs">
  </form>`
  const jobs = data.jobs || []
  const rows = jobs.map((j) => `<tr class="go-row" data-act="open-job" data-id="${esc(j.id)}" tabindex="0">
    <td class="nowrap"><b>${esc(j.ref)}</b></td>
    <td class="job">${esc(j.title)}${j.snippet ? `<small>${esc(j.snippet)}</small>` : ''}</td>
    <td>${stateHtml(j)}${j.priority === 'critical' || j.priority === 'high' ? `<small>${PRIORITY[j.priority]}</small>` : ''}</td>
    <td class="nowrap opt">${esc(j.bot)}</td>
    <td class="opt">${esc(j.project)}</td>
    <td class="t">${esc(at(j.at))}</td>
  </tr>`).join('')
  const pager = data.page > 0 || data.more ? `<div class="pager"><button class="btn ghost" data-act="jobs-page" data-by="-1" ${data.page === 0 ? 'disabled' : ''}>Newer</button><span>Page ${data.page + 1}</span><button class="btn ghost" data-act="jobs-page" data-by="1" ${data.more ? '' : 'disabled'}>Older</button></div>` : ''
  return head + (jobs.length
    ? `<div class="grid-wrap"><table class="grid jobs"><thead><tr><th>Job</th><th>What</th><th>State</th><th class="opt">Bot</th><th class="opt">Project</th><th>Last touched</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="none">${filter.q ? 'No job matches those words.' : 'No jobs here.'}</p>`) + pager
}

// ── one job ─────────────────────────────────────────────────────────────────────

const link = (j) => `<button class="link" data-act="open-job" data-id="${esc(j.id)}"><b>${esc(j.ref)}</b> ${esc(j.title)}</button>`

/** The branch's changes, as GitHub would show them: commits, then each file's patch, folded. */
export function changesHtml(c) {
  if (!c) return '<p class="none">This job has no branch to read.</p>'
  const line = (l) => `<span class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l)}</span>`
  return `<p class="hint">${c.files.length} file${c.files.length === 1 ? '' : 's'} on <code>${esc(c.branch)}</code> since <code>${esc(c.base)}</code>${c.cut ? '; the longest changes are cut short' : ''}.</p>
    ${c.commits.length ? `<ol class="commits">${c.commits.map((x) => `<li><code>${esc(x.sha)}</code> ${esc(x.subject)}</li>`).join('')}</ol>` : ''}
    ${c.files.map((f) => `<details class="patch"><summary><span class="path">${esc(f.path)}</span>${f.binary ? '<span class="dim">binary</span>' : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`}</summary>${f.binary ? '<p class="none">A binary file.</p>' : `<pre>${f.patch.split('\n').map(line).join('\n')}</pre>`}</details>`).join('')}`
}

/**
 * "Where does this job stand, and what did it make?" `line` is the map's own view of the job when it
 * is open; `crew` and `projects` fill the edit form.
 */
export function jobScreen(job, { line, steps, cards = '', bot, editing = false, crew = [], projects = [] }) {
  const facts = [
    ['State', `<span class="state ${STATE_CLASS[job.status] || ''}">${esc({ in_progress: 'Working', in_review: 'To review', blocked: 'Blocked', todo: 'Waiting', backlog: 'Backlog', done: 'Done', cancelled: 'Cancelled' }[job.status] || job.status)}</span>${job.run?.live ? `<small>Running now${job.run.bot ? `, ${esc(job.run.bot)}` : ''}</small>` : job.run?.why ? `<small class="bad">${esc(job.run.why)}</small>` : ''}`],
    ['Who', esc(job.bot || 'Nobody yet') + `<small>${esc(PRIORITY[job.priority] || job.priority)} priority${job.project ? `, ${esc(job.project)}` : ''}</small>`],
    ...(job.engineRef && job.engineRef !== job.ref ? [['Engine code', `<small>${esc(job.engineRef)}</small>`]] : []),
    ...(job.parent ? [['Part of', link(job.parent)]] : []),
    ...(job.blockedBy?.length ? [['Waits on', job.blockedBy.map((b) => `${link(b)} <span class="dim">${esc(b.state)}</span>`).join('<br>')]] : []),
    ...(job.blocks?.length ? [['Holds up', job.blocks.map(link).join('<br>')]] : []),
    ...(job.cost?.runs ? [['Used', `${job.cost.tokens ? `${tokens(job.cost.tokens)} tokens in ` : ''}${job.cost.runs} run${job.cost.runs === 1 ? '' : 's'}, ${esc(duration(job.cost.seconds))}${job.cost.tokens ? '' : ' so far'}${job.cost.cents ? `, $${(job.cost.cents / 100).toFixed(2)}` : ''}${job.cost.withSubJobs && job.children?.length ? '<small>Its sub-jobs included</small>' : ''}`]] : []),
    ...(job.branch ? [['Branch', `<code>${esc(job.branch.name)}</code>${job.branch.changes ? `<small>${job.branch.changes.files} files, <span class="add">+${job.branch.changes.added}</span> <span class="del">−${job.branch.changes.removed}</span> <button class="link" data-act="job-changes">See the changes</button></small>` : ''}`]] : []),
    ...(job.previews?.length ? [['Play', job.previews.map((p) => (p.ok ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> <span class="dim">${esc(p.commit)}, ${esc(at(p.builtAt))}</span>` : `<span class="bad">${esc(p.name)} did not build</span>${p.note ? `<small>${esc(p.note.split('\n').slice(-2).join(' '))}</small>` : ''}`)).join('<br>')]] : []),
  ]
  const open = !['done', 'cancelled'].includes(job.status)
  const acts = `<div class="acts">
    ${bot ? `<button class="btn" data-act="talk" data-id="${esc(bot.id)}">Talk to ${esc(bot.name.split(' ')[0])}</button>` : ''}
    <button class="btn" data-act="job-edit" aria-pressed="${editing}">Edit</button>
    <button class="btn" data-act="job-attach">Attach a file</button>
    ${job.run?.live ? '<button class="btn" data-act="job" data-do="stop">Stop the run</button>' : ''}
    ${open ? '<button class="btn ghost danger" data-act="job" data-do="cancel">Cancel the job…</button>' : '<button class="btn" data-act="job" data-do="reopen">Reopen…</button>'}
    <input type="file" data-part="attach" hidden>
  </div>`
  const edit = editing ? `<form class="fields job-edit" data-part="job-edit">
      <label class="stack">Title<input name="title" maxlength="200" required value="${esc(job.title)}"></label>
      <label class="stack">Details<textarea name="description" rows="8">${esc(job.description)}</textarea></label>
      <label>Priority <select name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${job.priority === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Project <select name="projectId"><option value="">None</option>${projects.map((p) => `<option value="${esc(p.id)}" ${job.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Bot <select name="botId">${crew.map((b) => `<option value="${esc(b.id)}" ${job.botId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <div class="acts"><button class="btn primary" type="submit">Save the job</button><button class="btn ghost" type="button" data-act="job-edit">Keep it as it is</button></div>
    </form>` : ''
  const images = job.files.filter((f) => f.kind === 'image')
  const others = job.files.filter((f) => f.kind !== 'image')
  const files = (images.length || others.length || job.products.length) ? `<h3>What it made</h3>
    ${images.length ? `<div class="thumbs">${images.map((f) => `<a class="view-img" href="${fileUrl(f.id)}" target="_blank" rel="noopener" title="${esc(f.name)}" data-name="${esc(f.name)}"><img src="${fileUrl(f.id)}" alt="${esc(f.name)}" loading="lazy"></a>`).join('')}</div>` : ''}
    ${others.length || job.products.length ? `<ul class="files">${others.map((f) => `<li><a href="${fileUrl(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a> <span class="dim">${size(f.size)}</span></li>`).join('')}${job.products.map((w) => `<li>${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(w.title)}</a>` : esc(w.title)}${w.summary ? ` <span class="dim">${esc(w.summary)}</span>` : ''}</li>`).join('')}</ul>` : ''}` : ''
  const docs = job.documents.length ? `<h3>Documents</h3>${job.documents.map((d) => `<details class="doc-box" data-doc="${esc(d.key)}"><summary><b>${esc(d.title)}</b> <span class="dim">version ${d.revision}, ${esc(d.by)}, ${esc(at(d.at))}</span></summary>
      <div class="acts"><button class="btn ghost" data-act="doc-edit" data-key="${esc(d.key)}" ${d.trimmed || d.locked ? 'disabled title="Too long or locked: edit it in the job\'s folder"' : ''}>Edit</button><button class="btn ghost" data-act="doc-history" data-key="${esc(d.key)}">Earlier versions</button></div>
      <div data-part="doc-history"></div>
      <div class="said doc" data-part="doc-text">${md(d.body)}${d.trimmed ? '<p class="hint">Cut short here: the rest is in the job.</p>' : ''}</div></details>`).join('')}` : ''
  // The engine's own notes ("Workspace Ready") are for bots: the owner reads what the crew said.
  const said = job.comments.filter((c) => !/^\s*#*\s*Workspace Ready\b/i.test(c.text || '')).slice(0, 6).reverse()
  return `${line ? `<p class="steps big">${line.steps.map((s, i) => `<span class="${esc(s)}"><i></i>${steps[i]}</span>`).join('')}</p>` : ''}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${acts}${edit}
    ${cards ? `<div class="asked">${cards}</div>` : ''}
    <div data-part="job-changes"></div>
    ${files}
    ${job.children?.length ? `<h3>Sub-jobs</h3><ul class="files">${job.children.map((c) => `<li>${link(c)} <span class="dim">${esc(c.state)}</span></li>`).join('')}</ul>` : ''}
    ${said.length ? `<h3>Last said</h3>${said.map((c) => `<div class="note-row"><span class="from">${esc(c.from)} <time>${esc(at(c.at))}</time></span><div class="said ${String(c.text || '').length > 700 ? 'clip' : ''}">${md(c.text)}</div>${String(c.text || '').length > 700 ? '<button class="link more" data-act="unclip">Show all of it</button>' : ''}</div>`).join('')}` : ''}
    <form class="fields comment"><label class="stack">Add a comment<textarea name="text" rows="2" required placeholder="The bot on it is woken to read it"></textarea></label><button class="btn primary" type="submit">Comment</button></form>
    ${job.description ? `<details class="doc-box"><summary><b>The brief</b></summary><div class="said doc">${md(job.description)}</div></details>` : ''}
    ${docs}
    ${job.runs.length ? `<h3>Runs</h3><div class="grid-wrap"><table class="grid runs"><thead><tr><th>When</th><th>Bot</th><th>How it ended</th><th class="n">Took</th><th class="n">Tokens</th></tr></thead><tbody>${job.runs.map((r) => runRowHtml(r, true, false)).join('')}</tbody></table></div>
      <div data-part="job-feed"></div>` : ''}`
}

/** A document's earlier versions, each one restorable. */
export function docHistory(key, revisions) {
  if (!revisions.length) return '<p class="none">No earlier versions.</p>'
  return `<table class="grid slim"><tbody>${revisions.map((r, i) => `<tr><td class="t">${esc(at(r.at))}</td><td>Version ${r.number}, ${esc(r.by)}${r.note ? `<small>${esc(r.note)}</small>` : ''}</td><td class="n">${i ? `<button class="btn ghost" data-act="doc-restore" data-key="${esc(key)}" data-id="${esc(r.id)}" data-n="${r.number}">Restore…</button>` : '<span class="dim">Current</span>'}</td></tr>`).join('')}</tbody></table>`
}

// ── a project's page, in the left panel ─────────────────────────────────────────

/** What a project's page adds to the map's counts: its folders, routines, spend and what it finished. */
/**
 * A project's goal, as the lead reads it from the project, so the owner sees what the crew is working
 * towards and can change it. With no goal, what the lead does instead.
 */
export function projectGoal(goal, { editing = false, standing = '' } = {}) {
  if (editing) {
    const g = goal || {}
    return `<form class="fields goal-edit" data-part="goal">
      <label class="stack">The goal<textarea name="goal" rows="3" maxlength="1500" placeholder="The outcome you want, in one or two lines">${esc(g.goal)}</textarea></label>
      <label class="stack">Done when<textarea name="doneWhen" rows="3" maxlength="1500" placeholder="The checks or numbers that prove it, read by a script or a critic">${esc(g.doneWhen)}</textarea></label>
      <label class="stack">The next step<input name="first" maxlength="600" value="${esc(g.first)}" placeholder="What the crew does first"></label>
      <label class="stack">Set aside for now<input name="parked" maxlength="600" value="${esc(g.parked)}" placeholder="What this goal pushes aside"></label>
      <label class="stack">What the project is<textarea name="about" rows="2" maxlength="1200">${esc(g.about)}</textarea></label>
      <label class="check"><input type="checkbox" name="tell" checked> Tell the lead in his chat, so he works toward it from now</label>
      <div class="acts"><button class="btn primary" type="submit">Save the goal</button><button class="btn ghost" type="button" data-act="goal-cancel">Keep it as it is</button></div>
    </form>`
  }
  if (!goal) return '<section class="goal-card"><p class="none">Reading the goal…</p></section>'
  const part = (name, text) => (text ? `<dt>${name}</dt><dd>${esc(text)}</dd>` : '')
  if (!goal.goal) {
    return `<section class="goal-card empty">
      <header><span class="kicker">Goal</span><button class="btn small" data-act="goal-edit">Set a goal</button></header>
      <p class="goal-line">No goal is set.</p>
      <p class="goal-instead">${esc(standing)}</p>
      ${goal.about ? `<dl>${part('What it is', goal.about)}</dl>` : ''}
    </section>`
  }
  return `<section class="goal-card">
    <header><span class="kicker">Goal</span>${goal.setBy ? `<small>set by ${esc(goal.setBy)}</small>` : ''}<button class="btn small" data-act="goal-edit">Edit</button></header>
    ${goalLines(goal.goal)}
    <dl>${part('Done when', goal.doneWhen)}${part('In the way now', goal.open)}${part('Next step', goal.first)}${part('Set aside', goal.parked)}</dl>
  </section>`
}

/**
 * A goal as a headline and the rest: its first clause large, what follows as plain text, so a goal of a
 * paragraph still reads at a glance.
 */
function goalLines(text) {
  const t = String(text || '').trim()
  const cut = t.search(/[;.](\s|$)/)
  const head = cut > 0 && cut < 160 ? t.slice(0, cut) : t.length <= 160 ? t : t.slice(0, t.lastIndexOf(' ', 150)) + '…'
  const rest = t.slice(head.replace(/…$/, '').length).replace(/^[;.]\s*/, '').trim()
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1)
  const long = rest.length > 240
  return `<p class="goal-line">${esc(cap(head))}</p>${rest ? `<p class="goal-more ${long ? 'clip' : ''}">${esc(cap(rest))}</p>${long ? '<button class="link more" data-act="unclip">Show all of it</button>' : ''}` : ''}`
}

/** The lead's newest plan for the project: what he is working through, with his own steps. */
export function projectPlan(plan) {
  if (!plan) return ''
  const state = { done: 'Planned', in_progress: 'Planning now', todo: 'Waiting to plan', blocked: 'Blocked', cancelled: 'Dropped' }[plan.status] || plan.status
  return `<h3>The lead's plan</h3>
    <div class="plan-card">
      <button class="line" data-act="open-plan" data-id="${esc(plan.id)}"><span class="ref">${esc(plan.ref || '')}</span><span class="title">${esc(plan.title)}</span><span></span><span class="note">${esc(state)}${plan.at ? `, ${esc(at(plan.at))}` : ''}</span></button>
      ${plan.goal ? `<p class="plan-goal"><b>Aim:</b> ${esc(plan.goal)}</p>` : ''}
      ${plan.report ? `<details class="plan-steps"><summary>His steps and why</summary><div class="said doc">${md(plan.report)}</div></details>` : '<p class="none">He has not written the steps yet.</p>'}
    </div>`
}

export function projectExtras(p) {
  if (!p) return '<p class="none">Reading…</p>'
  const budget = p.budget ? `<p class="trouble ${p.budget.share >= 90 ? 'bad' : p.budget.share >= 75 ? 'warn' : 'info'}"><i></i>Budget: ${Math.round(p.budget.share)}% used of ${esc(String(p.budget.amount))} a ${esc(p.budget.window || 'month')}</p>` : ''
  return `${budget}
    <details class="details-fold"><summary>Details: what it used, its folders</summary>
    <h3>Used in 7 days</h3><p class="fact">${tokens(p.spend.tokens)} tokens in ${p.spend.runs} run${p.spend.runs === 1 ? '' : 's'}${p.spend.cents ? `, $${(p.spend.cents / 100).toFixed(2)}` : ''}</p>
    ${p.routines.length ? `<h3>Routines</h3>${p.routines.map((r) => `<button class="line" data-routine="${esc(r.id)}"><span class="title">${esc(r.title)}</span><span class="note">${esc(r.paused ? 'Paused' : r.when)}${r.bot ? `, ${esc(r.bot)}` : ''}</span></button>`).join('')}` : ''}
    <h3>Folders</h3>${p.folders.map((f) => `<p class="fact"><code>${esc(f.folder)}</code>${f.primary && p.folders.length > 1 ? ' <span class="dim">main</span>' : ''}${f.repo ? ` <a href="${esc(f.repo)}" target="_blank" rel="noopener noreferrer">repository</a>` : ''}</p>`).join('') || '<p class="none">No folder on record.</p>'}
    </details>
    ${p.done.length ? `<h3>Finished lately</h3>${p.done.map((j) => `<button class="line done" data-line="${esc(j.id)}"><span class="ref">${esc(j.ref)}</span><span class="title">${esc(j.title)}</span><span></span><span class="note">${esc(j.bot)}, ${esc(at(j.at))}</span></button>`).join('')}` : ''}
    <div class="acts"><button class="btn" data-act="project-jobs" data-id="${esc(p.id)}">Every job of ${esc(p.name)}</button></div>`
}

// ── routines and timers ─────────────────────────────────────────────────────────


/** "What starts by itself, and when next?" The crew's routines, then the machine's own timers. */
export function routinesScreen(routines, timers, { adding = false, crew = [], projects = [] } = {}) {
  const rows = routines.map((r) => `<tr class="go-row ${r.paused ? 'paused' : ''}" data-act="open-routine" data-id="${esc(r.id)}" tabindex="0">
    <td><b>${esc(r.title)}</b>${r.project ? `<small>${esc(r.project)}</small>` : ''}</td>
    <td class="nowrap">${esc(r.bot)}</td>
    <td>${r.paused ? '<span class="state warn">Paused</span>' : `<span class="nowrap">${esc(r.nextAt ? at(r.nextAt) : '')}</span>`}<small>${esc(r.when)}</small></td>
    <td class="n"><button class="btn ghost" data-act="routine" data-do="run" data-id="${esc(r.id)}" aria-label="Run now: ${esc(r.title)}">Run now</button><button class="btn ghost" data-act="routine" data-do="${r.paused ? 'resume' : 'pause'}" data-id="${esc(r.id)}" aria-label="${r.paused ? 'Resume' : 'Pause'}: ${esc(r.title)}">${r.paused ? 'Resume' : 'Pause'}</button></td>
  </tr>`).join('')
  const add = adding ? `<form class="fields routine-add" data-part="routine-add">
      <label class="stack">What should be done each time<input name="title" maxlength="180" required placeholder="One line, the outcome you want"></label>
      <label class="stack">Details<textarea name="description" rows="3"></textarea></label>
      ${whenPicker(null)}
      <label>Who <select name="botId"><option value="">The bot that leads the crew</option>${crew.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>
      <label>Project <select name="projectId"><option value="">None</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="acts"><button class="btn primary" type="submit">Add the routine</button><button class="btn ghost" type="button" data-act="routine-add">Keep it as it is</button></div>
    </form>` : '<div class="acts"><button class="btn" data-act="routine-add">Add a routine</button></div>'
  const timerRows = (timers || []).map((t) => `<tr title="${esc(t.id)}"><td>${esc(t.name)}</td><td class="t">${t.next ? esc(when(t.next)) : '<span class="dim">Stopped</span>'}</td><td class="t">${t.last ? esc(when(t.last)) : ''}</td></tr>`).join('')
  return `${routines.length ? `<div class="grid-wrap"><table class="grid"><thead><tr><th>Routine</th><th>Who</th><th>Next</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="none">No routines yet.</p>'}
    ${add}
    <h3>Helpers</h3>
    <p class="hint">Small scripts Botyard runs for the crew: they move finished jobs on to their check, free stuck ones and watch the limits. None of them uses an AI unless it says so.</p>
    <div data-part="helpers"><p class="none">Reading…</p></div>
    ${timerRows ? `<details class="fold"><summary>Timers this computer still runs by itself <small>${timers.length}</small></summary>
      <p class="hint">Set up before Botyard ran the helpers itself. They are not changed here.</p>
      <div class="grid-wrap"><table class="grid slim"><thead><tr><th>What</th><th>Next</th><th>Last</th></tr></thead><tbody>${timerRows}</tbody></table></div></details>` : ''}`
}

/** One routine: when it runs and who does it, change the schedule, its runs and its versions. */
export function routineScreen(r, { crew = [], projects = [] } = {}) {
  const facts = [
    ['When', `${esc(r.when)}${r.timezone ? ` <span class="dim">${esc(r.timezone)}</span>` : ''}${r.paused ? '<small class="warnish">Paused: it does not run until resumed</small>' : r.nextAt ? `<small>Next ${esc(at(r.nextAt))}</small>` : ''}`],
    ['Who', esc(r.bot || 'Nobody')],
    ...(r.project ? [['Project', esc(r.project)]] : []),
  ]
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="acts">
      <button class="btn" data-act="routine" data-do="run" data-id="${esc(r.id)}">Run now</button>
      <button class="btn" data-act="routine" data-do="${r.paused ? 'resume' : 'pause'}" data-id="${esc(r.id)}">${r.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn ghost" data-act="routine-remove" data-id="${esc(r.id)}">Remove…</button>
    </div>
    ${r.description ? `<div class="said doc">${md(r.description)}</div>` : ''}
    <details class="fold change-when"><summary>Change when it runs</summary>
      <div class="fields">${whenPicker(r.plan)}
      <div class="acts"><button class="btn primary" data-act="routine-when" data-id="${esc(r.id)}">Save when it runs</button></div></div></details>
    <details class="fold"><summary>Change what it does, and who does it</summary>
      <form class="fields" data-part="routine-edit">
        <label class="stack">What should be done each time<input name="title" maxlength="180" required value="${esc(r.title)}"></label>
        <label class="stack">Details<textarea name="description" rows="4">${esc(r.description)}</textarea></label>
        <label>Who <select name="botId">${crew.map((b) => `<option value="${esc(b.id)}" ${b.id === r.botId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        <label>Project <select name="projectId"><option value="">None</option>${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === r.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <div class="acts"><button class="btn primary" type="submit">Save the routine</button></div>
      </form></details>
    <h3>Last runs</h3>
    ${r.runs.length ? `<table class="grid slim"><tbody>${r.runs.map((x) => `<tr><td class="t">${esc(at(x.at))}</td><td><span class="state ${x.failed ? 'bad' : ''}">${esc(x.state)}</span>${x.why ? `<small>${esc(x.why)}</small>` : ''}</td><td>${esc(x.by)}</td><td>${x.job ? jobLink(x.job) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="none">It has not run yet.</p>'}
    ${r.revisions.length ? `<details><summary>Versions (${r.revisions.length})</summary><table class="grid slim"><tbody>${r.revisions.map((v) => `<tr><td class="t">${esc(at(v.at))}</td><td>Version ${v.number}</td><td>${esc(v.by)}</td></tr>`).join('')}</tbody></table></details>` : ''}`
}

// ── the library ─────────────────────────────────────────────────────────────────

export const SHELVES = [['made', 'Made by the crew'], ['skills', 'Skills']]

const shelves = (on) => `<div class="filters"><div class="seg" role="tablist">${SHELVES.map(([id, name]) => `<button role="tab" aria-selected="${on === id}" class="${on === id ? 'on' : ''}" data-act="shelf" data-shelf="${id}">${name}</button>`).join('')}</div></div>`

/** "What has the crew made?" Pictures as pictures, the rest by name, each with the job it is for. */
export function madeScreen(items, { more = false } = {}) {
  const rows = items.map((a) => {
    const look = a.kind === 'image' && a.file ? `<a class="view-img" href="${fileUrl(a.file)}" target="_blank" rel="noopener" title="${esc(a.title)}" data-name="${esc(a.title)}"><img class="thumb" src="${fileUrl(a.file)}" alt="" loading="lazy"></a>`
      : `<span class="kind">${a.kind === 'document' ? 'Doc' : 'File'}</span>`
    const name = a.file && a.kind !== 'image' ? `<a href="${fileUrl(a.file)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : a.document && a.job ? `<button class="link" data-act="open-job" data-id="${esc(a.job.id)}">${esc(a.title)}</button>` : esc(a.title)
    return `<tr><td class="look">${look}</td><td>${name}${a.preview ? `<small>${esc(plainText(a.preview))}</small>` : ''}</td><td class="job">${a.job ? jobLink(a.job) : ''}</td><td class="nowrap opt">${esc(a.bot)}</td><td class="t">${esc(at(a.at))}</td></tr>`
  }).join('')
  return shelves('made') + (items.length
    ? `<div class="grid-wrap"><table class="grid made"><thead><tr><th></th><th>What</th><th>For</th><th class="opt">By</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="none">The crew has not attached anything yet.</p>')
    + (more ? '<div class="pager"><button class="btn ghost" data-act="made-more">Older</button></div>' : '')
}

/** "What can the crew be given, and can I change it?" */
export function skillsScreen(skills) {
  return shelves('skills') + (skills.length ? `<div class="grid-wrap"><table class="grid"><thead><tr><th>Skill</th><th>What it is for</th><th></th></tr></thead><tbody>${skills.map((s) => `<tr class="go-row" data-act="open-skill" data-id="${esc(s.id)}" tabindex="0">
      <td class="nowrap"><b>${esc(s.name)}</b><small>${s.files.length} file${s.files.length === 1 ? '' : 's'}</small></td>
      <td>${esc(s.description)}</td>
      <td class="nowrap">${s.editable ? '<span class="state go">Can change</span>' : `<span class="dim">${esc(s.locked)}</span>`}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="none">No skills in this studio.</p>')
    + '<p class="hint">Which bot is given which skill is chosen on the bot\'s own settings page, under Crew.</p>'
}

/** One skill: its files down the side, the one open read as written, and Edit where it may change. */
export function skillScreen(skill, file, { editing = false } = {}) {
  const body = !file ? '<p class="none">Reading…</p>'
    : editing ? `<div class="fields instr-edit"><textarea rows="20" spellcheck="false" data-part="skill-text">${esc(file.content)}</textarea>
        <div class="acts"><button class="btn primary" data-act="skill-save">Save…</button><button class="btn ghost" data-act="skill-cancel">Keep it as it is</button></div></div>`
    : `${skill.editable && file.editable ? '<div class="acts"><button class="btn" data-act="skill-edit">Edit this file</button></div>' : ''}
       <div class="said doc">${file.markdown || /\.md$/i.test(file.path) ? md(file.content) : `<pre>${esc(file.content)}</pre>`}${file.trimmed ? '<p class="hint">Cut short here.</p>' : ''}</div>`
  return `<p class="hint">${esc(skill.description)}</p>
    ${skill.files.length > 1 ? `<div class="filters"><label>File <select data-part="skill-file">${skill.files.map((f) => `<option ${file?.path === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label></div>` : ''}
    ${body}`
}

export const libraryShelves = shelves
