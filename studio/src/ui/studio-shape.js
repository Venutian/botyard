/**
 * The screens that shape a studio, as HTML: a bot's editor and its instructions, adding a bot,
 * Setup, the first run, a project's own settings, and when a routine runs. Pure functions of what
 * the server sent, like `studio-crew.js`; the Studio class fetches, routes clicks and asks first.
 */
import { botStyle } from './crew-colours.js'
import { esc, when } from './studio-crew.js'

const opt = (value, name, picked) => `<option value="${esc(value)}" ${String(picked ?? '') === String(value) ? 'selected' : ''}>${esc(name)}</option>`
const tag = (cls, words) => `<span class="state ${cls}">${esc(words)}</span>`

// ── when a routine runs ─────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The plain choices of when, one line each, with the five-field form behind "Advanced". `plan` is
 * what the routine runs on now; a new routine starts on "every day at 07:00".
 */
export function whenPicker(plan) {
  const p = plan || { kind: 'daily', at: '07:00' }
  const on = (kind) => (p.kind === kind ? 'checked' : '')
  const at = (kind) => esc(p.kind === kind ? p.at : '07:00')
  const row = (kind, inner) => `<label class="when-row"><input type="radio" name="kind" value="${kind}" ${on(kind)}><span>${inner}</span></label>`
  return `<fieldset class="when" data-part="when">
    <legend>When it runs</legend>
    ${row('minutes', `Every <input type="number" name="n-minutes" min="5" max="59" value="${p.kind === 'minutes' ? p.n : 30}" aria-label="Minutes"> minutes`)}
    ${row('hours', `Every <input type="number" name="n-hours" min="1" max="23" value="${p.kind === 'hours' ? p.n : 4}" aria-label="Hours"> hours, on the hour`)}
    ${row('daily', `Every day at <input type="time" name="at-daily" value="${at('daily')}" aria-label="Time of day">`)}
    ${row('weekdays', `Monday to Friday at <input type="time" name="at-weekdays" value="${at('weekdays')}" aria-label="Time on weekdays">`)}
    ${row('weekly', `Every <select name="day" aria-label="Day of the week">${DAYS.map((d, n) => opt(n, d, p.kind === 'weekly' ? p.day : 1)).join('')}</select> at <input type="time" name="at-weekly" value="${at('weekly')}" aria-label="Time on that day">`)}
    <details class="advanced" ${p.kind === 'cron' ? 'open' : ''}><summary>Advanced: write the timetable yourself</summary>
      ${row('cron', `<input name="cron" value="${esc(p.kind === 'cron' ? p.cron : '')}" placeholder="30 7 * * 1-5" spellcheck="false" autocomplete="off" aria-label="Timetable in five parts">`)}
      <p class="hint">Five parts: minute, hour, day of the month, month, day of the week. <code>30 7 * * 1-5</code> is 07:30 on weekdays.</p>
    </details>
  </fieldset>`
}

/** The plan a picker holds, as the server takes it. */
export function readWhen(root) {
  const el = root.querySelector('[data-part="when"]')
  const kind = el?.querySelector('input[name="kind"]:checked')?.value
  const v = (name) => el.querySelector(`[name="${name}"]`)?.value ?? ''
  if (kind === 'minutes') return { kind, n: Number(v('n-minutes')) }
  if (kind === 'hours') return { kind, n: Number(v('n-hours')) }
  if (kind === 'daily' || kind === 'weekdays') return { kind, at: v(`at-${kind}`) }
  if (kind === 'weekly') return { kind, day: Number(v('day')), at: v('at-weekly') }
  if (kind === 'cron') return { kind, cron: v('cron') }
  return null
}

/** The helper scripts the service runs for the crew: each one's last run, its next, run now, and on or off. */
export function helpersTable(h) {
  if (!h) return '<p class="none">Reading…</p>'
  if (!h.available) return `<p class="none">${esc(h.why)}</p>`
  if (!h.jobs.length) return `<p class="none">${esc(h.why || 'This studio has no helpers.')}</p>`
  const off = h.state !== 'on'
  const rows = h.jobs.map((j) => {
    const state = !j.ready ? tag('dim', 'Not ready') : j.running ? tag('go', 'Running') : !j.on || off ? tag('dim', 'Off') : j.lastAt && !j.lastOk ? tag('bad', 'Failed') : tag('done', 'On')
    const last = j.lastAt ? `${esc(when(j.lastAt))}${j.lastOk ? '' : `<small class="warnish">${esc(j.lastError || 'It ended with an error')}</small>`}` : '<span class="dim">Not yet</span>'
    return `<tr><td><b>${esc(j.name)}</b><small>${esc(j.what)}</small>${j.notReady ? `<small class="warnish">${esc(j.notReady)}</small>` : ''}</td>
      <td>${state}<small>${esc(j.when)}</small></td>
      <td class="t opt">${last}</td>
      <td class="t opt">${j.nextAt && j.on && !off ? esc(when(j.nextAt)) : ''}</td>
      <td class="n nowrap"><button class="btn ghost" data-act="helper" data-do="run" data-name="${esc(j.name)}" aria-label="Run ${esc(j.name)} now" ${j.running || !j.ready ? 'disabled' : ''}>Run now</button><button class="btn ghost" data-act="helper" data-do="${j.on ? 'off' : 'on'}" data-name="${esc(j.name)}" aria-label="${j.on ? 'Turn off' : 'Turn on'} ${esc(j.name)}">${j.on ? 'Turn off' : 'Turn on'}</button></td></tr>`
  }).join('')
  return `${off ? `<p class="flag warn"><i></i><span>The helper timetable is off${h.why ? `: ${esc(h.why)}` : '.'} “Run now” still works.</span></p>` : ''}
    <div class="acts"><button class="btn" data-act="helper" data-do="${off ? 'on' : 'off'}">${off ? 'Turn the timetable on' : 'Turn the whole timetable off'}</button></div>
    <div class="grid-wrap"><table class="grid slim helpers"><thead><tr><th>Helper</th><th>Now</th><th class="opt">Last run</th><th class="opt">Next</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
}

// ── a bot's form: the editor, and "Add a bot" ───────────────────────────────────────

/** What depends on which AI is picked: its models, its effort, its turns. Drawn again when the AI changes. */
export function aiDetail(s, choices, aiId) {
  const ai = choices.ais.find((a) => a.id === aiId)
  if (!ai) return '<p class="hint">Pick which AI runs it first.</p>'
  const mine = aiId === s.ai
  const model = mine ? s.model : ai.models[0]?.id || ''
  const known = ai.models.some((m) => m.id === model)
  return `<label class="stack">Model
      <select name="modelPick">${ai.models.map((m) => opt(m.id, m.name, known ? model : '')).join('')}<option value="" ${known ? '' : 'selected'}>Another model…</option></select></label>
    <label class="stack other-model" ${known ? 'hidden' : ''}>Its id, as the tool names it<input name="modelOther" value="${esc(known ? '' : model)}" maxlength="120" spellcheck="false" autocomplete="off" placeholder="provider/model-name"></label>
    ${ai.effort ? `<label class="stack">Effort<select name="effort">${opt('', 'The tool\'s own', mine ? s.effort : '')}${choices.efforts.map((e) => opt(e.id, e.name, mine ? s.effort : '')).join('')}</select></label>` : ''}
    ${ai.turns ? `<label class="stack">Most turns in one run<input type="number" name="turns" min="1" max="2000" value="${esc(s.turns ?? '')}" placeholder="No limit"></label>` : ''}`
}

/**
 * The form both the editor and "Add a bot" show. `ready` says which AIs are signed in (from Setup),
 * so a bot is not put on one that cannot run.
 */
export function botForm(s, choices, { adding = false, ready = null } = {}) {
  const aiState = (ai) => {
    if (!ready || !(ai.setup in ready)) return ''
    const st = ready[ai.setup]
    return st === 'ok' ? tag('done', 'Ready') : st === 'unknown' ? tag('dim', 'Installed') : `${tag('warn', st === 'missing' ? 'Not installed' : 'Not signed in')}`
  }
  const ais = choices.ais.map((ai) => `<label class="ai-plate"><input type="radio" name="ai" value="${ai.id}" ${s.ai === ai.id ? 'checked' : ''} required>
      <span><b>${esc(ai.name)}</b>${aiState(ai)}<small>${esc(ai.about)}</small></span></label>`).join('')
  const top = (s.mayNot || ['push']).at(-1)
  const mayNot = choices.mayNot.map((m, n) => `<label class="may-row"><input type="${n ? 'radio' : 'checkbox'}" ${n ? `name="mayNot" value="${m.id}" ${top === m.id ? 'checked' : ''}` : 'checked disabled'}>
      <span><b>${esc(m.name)}</b><small>${esc(m.about)}</small></span></label>`).join('')
  return `<form class="fields bot-form" data-part="${adding ? 'bot-add' : 'bot-edit'}" novalidate>
    <section class="plate-sec"><h3>Who it is</h3>
      <div class="two"><label class="stack">Name<input name="name" value="${esc(s.name)}" maxlength="80" required autocomplete="off"></label>
      <label class="stack">Title<input name="title" value="${esc(s.title)}" maxlength="160" placeholder="A few words under its name" autocomplete="off"></label></div>
      <label class="stack">What it does<textarea name="does" rows="2" maxlength="600" placeholder="One or two lines. The bot that hands out work reads this to decide who gets a job.">${esc(s.does)}</textarea></label>
      <div class="two"><label class="stack">Kind of work<select name="role">${choices.roles.map((r) => opt(r.id, r.name, s.role)).join('')}</select></label>
      <label class="stack">Answers to<select name="reportsTo">${opt('', 'Nobody: it leads the crew', s.reportsTo)}${choices.bosses.map((b) => opt(b.id, b.name, s.reportsTo)).join('')}</select></label></div>
    </section>
    <section class="plate-sec"><h3>Which AI runs it</h3>
      <div class="ai-plates" role="radiogroup" aria-label="Which AI runs it">${ais}</div>
      <div class="two ai-detail" data-part="ai-detail">${aiDetail(s, choices, s.ai)}</div>
      ${adding ? '' : '<p class="hint">Moving a bot to another AI keeps its instructions, variables and limits. Its next run starts a fresh conversation there.</p>'}
    </section>
    <section class="plate-sec"><h3>Limits</h3>
      <div class="two"><label class="stack">Longest one run may take<span class="unit"><input type="number" name="minutes" min="1" max="600" value="${esc(s.minutes)}" required> minutes</span></label>
      <label class="stack">Jobs at once<span class="unit"><input type="number" name="atOnce" min="1" max="10" value="${esc(s.atOnce || 1)}" required> side by side</span></label></div>
    </section>
    <section class="plate-sec"><h3>What it may not do</h3>
      <div class="may-rows">${mayNot}<label class="may-row"><input type="radio" name="mayNot" value="push" ${top === 'push' ? 'checked' : ''}><span><b>Nothing more</b><small>It may change files and commit its work.</small></span></label></div>
      ${s.ai && !s.mayNotKept && !adding ? '<p class="hint">Kept on every AI: git refuses its push, and its commit where it may not commit. On this AI a bot that may not change files can still write in the job\'s own folder, but nothing it writes reaches the branch.</p>' : ''}
    </section>
    ${adding ? '' : skillsPart(s.skills)}
    <div class="save-bar"><span class="changed" data-part="changed" hidden>Changed since last save</span>
      <button class="btn primary" type="submit">${adding ? 'Add the bot' : 'Save changes'}</button>
      ${adding ? '' : '<button class="btn ghost" type="button" data-act="bot-edit-undo">Put it back as it was</button>'}</div>
  </form>`
}

function skillsPart(skills) {
  if (!skills) return ''
  const list = skills.all.length
    ? `<div class="skill-ticks" data-part="skill-list" ${skills.mode === 'list' ? '' : 'hidden'}>${skills.all.map((k) => `<label title="${esc(k.about)}"><input type="checkbox" name="skill" value="${esc(k.name)}" ${k.on ? 'checked' : ''}><span>${esc(k.name)}</span></label>`).join('')}</div>`
    : ''
  return `<section class="plate-sec"><h3>Skills</h3>
    <div class="seg" role="radiogroup" aria-label="Which skills it is given">
      <label><input type="radio" name="skillsMode" value="set" ${skills.mode === 'set' ? 'checked' : ''}><span>What its job needs</span></label>
      <label><input type="radio" name="skillsMode" value="all" ${skills.mode === 'all' ? 'checked' : ''}><span>Every skill</span></label>
      ${skills.all.length ? `<label><input type="radio" name="skillsMode" value="list" ${skills.mode === 'list' ? 'checked' : ''}><span>Only the ones I tick</span></label>` : ''}
    </div>
    ${list}
    <p class="hint">${skills.all.length ? `${skills.all.filter((k) => k.on).length} of ${skills.all.length} skills on this computer are given to it now.` : 'No skills are on this computer yet.'} A skill is a folder of instructions a bot reads when a job calls for it; the Library lists them.</p>
  </section>`
}

/** What the form holds, as the fields the server takes. */
export function readBotForm(form) {
  const v = (name) => form.elements[name]?.value ?? ''
  const ai = form.querySelector('input[name="ai"]:checked')?.value || ''
  const out = {
    name: v('name').trim(), title: v('title').trim(), does: v('does').trim(), role: v('role'), reportsTo: v('reportsTo'),
    ai, model: (v('modelPick') || v('modelOther')).trim(), minutes: Number(v('minutes')), atOnce: Number(v('atOnce')),
    mayNot: [form.querySelector('input[name="mayNot"]:checked')?.value || 'push'],
  }
  if (form.elements.effort) out.effort = v('effort')
  if (form.elements.turns) out.turns = v('turns') === '' ? null : Number(v('turns'))
  const mode = form.querySelector('input[name="skillsMode"]:checked')?.value
  if (mode) out.skills = mode === 'list' ? [...form.querySelectorAll('input[name="skill"]:checked')].map((i) => i.value) : mode
  return out
}

/** Only what differs from the bot as it was read: a save touches nothing else. */
export function changedFields(now, was) {
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '')
  const before = {
    name: was.name, title: was.title, does: was.does, role: was.role, reportsTo: was.reportsTo || '', ai: was.ai, model: was.model,
    minutes: was.minutes, atOnce: was.atOnce, mayNot: [(was.mayNot || ['push']).at(-1)], effort: was.effort || '', turns: was.turns ?? null,
    skills: was.skills ? (was.skills.mode === 'list' ? was.skills.all.filter((k) => k.on).map((k) => k.name) : was.skills.mode) : undefined,
  }
  const out = {}
  for (const [key, value] of Object.entries(now)) if (!same(value, before[key])) out[key] = value
  // A new AI always comes with its model, and the old AI's effort means nothing there.
  if (out.ai) { out.model = now.model; if (now.effort !== undefined) out.effort = now.effort }
  if (out.effort === '') delete out.effort
  if (out.turns === null) delete out.turns
  return out
}

/** One bot's editor: the form, then what is saved by itself (connectors, variables), then removing it. */
export function botEditScreen(s, { ready = null } = {}) {
  const LEVEL = { off: 'No', read: 'May look', write: 'May change things' }
  const connectors = s.connectors.length
    ? `<div class="grid-wrap"><table class="grid slim"><tbody>${s.connectors.map((c) => `<tr class="go-row" data-act="open-connector" data-id="${esc(c.id)}" tabindex="0"><td><b>${esc(c.name)}</b></td><td>${tag(c.level === 'off' ? 'dim' : c.level === 'write' ? 'warn' : 'done', LEVEL[c.level] || c.level)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="none">Nothing is connected yet.</p>'
  const variables = s.variables.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td>${v.set ? tag('done', 'Set') : tag('warn', 'No value')}</td>
      <td class="n nowrap"><button class="btn ghost" data-act="var-replace" data-name="${esc(v.name)}">Replace</button><button class="btn ghost" data-act="var-remove" data-name="${esc(v.name)}">Remove</button></td></tr>`).join('')
  return `<div class="bot-edit" style="${botStyle(s.name)}">
    ${botForm(s, s.choices, { ready })}
    <section class="plate-sec"><h3>Connectors it may use</h3>
      ${connectors}
      <div class="acts"><button class="btn" data-act="to-connectors">Open Connectors</button></div>
    </section>
    <section class="plate-sec"><h3>Variables</h3>
      <p class="hint">Named values its runs are given, like a key for a service. A value is written once and never shown again, here or anywhere: replace it if it changes.</p>
      ${variables ? `<div class="grid-wrap"><table class="grid slim vars"><tbody>${variables}</tbody></table></div>` : '<p class="none">It has none.</p>'}
      <form class="fields var-add" data-part="var-add" autocomplete="off">
        <label class="stack">Name<input name="name" maxlength="64" required pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="SHOP_API_KEY" spellcheck="false" autocomplete="off"></label>
        <label class="stack">Value<input name="value" type="password" required maxlength="8000" autocomplete="new-password" placeholder="Written once, never shown"></label>
        <button class="btn" type="submit">Set it</button>
      </form>
    </section>
    <section class="plate-sec danger-sec"><h3>Remove ${esc(s.name)}</h3>
      <p class="hint">Its runs stop and it is given nothing more. Its past jobs, runs and conversations stay in the studio's history.${s.openJobs ? ` It has ${s.openJobs} open job${s.openJobs === 1 ? '' : 's'}.` : ''}</p>
      <div class="acts"><button class="btn danger" data-act="bot-remove">Remove this bot…</button></div>
    </section>
  </div>`
}

// ── a bot's instructions ────────────────────────────────────────────────────────────

const size = (bytes) => (bytes ? (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`) : '')

/** A real editor for what the bot reads before every run, and every earlier version one click away. */
export function rulesScreen(bot) {
  const ins = bot.instructions
  if (!ins) return `<p class="none">${bot.pending ? 'Its instructions are still being read. This page fills in a moment.' : 'This bot has no instructions yet.'}</p>`
  if (!ins.managed) return `<p class="flag warn"><i></i><span>These instructions cannot be changed in Botyard on this engine yet. They are shown as the bot reads them.</span></p><pre class="rules-read">${esc(ins.content)}</pre>`
  const history = ins.history.length
    ? `<ol class="versions">${ins.history.map((h, i) => `<li>
        <span><b>${esc(when(Date.parse(h.at)))}</b><small>${esc(h.by)}${h.bytes ? `, ${esc(size(h.bytes))}` : ''}</small></span>
        ${i === 0 ? tag('done', 'Current') : `<button class="btn" data-act="rules-restore" data-id="${esc(h.id)}">Take this back</button>`}
        ${i < ins.history.length - 1 ? `<button class="btn ghost" data-act="rules-diff" data-from="${esc(ins.history[i + 1].id)}" data-to="${esc(h.id)}">What it changed</button>` : ''}
      </li>`).join('')}</ol>`
    : '<p class="none">No earlier versions yet. Every save keeps the one before it.</p>'
  return `<div class="rules" style="${botStyle(bot.name)}">
    <div class="rules-edit">
      <textarea data-part="rules-text" spellcheck="false" aria-label="${esc(bot.name)}'s instructions" maxlength="200000">${esc(ins.content)}</textarea>
      <div class="save-bar"><span class="count" data-part="rules-count"></span><span class="changed" data-part="changed" hidden>Changed since last save</span>
        <button class="btn primary" data-act="rules-save">Save</button><button class="btn ghost" data-act="rules-undo">Put it back as it was</button></div>
    </div>
    <aside class="rules-side"><h3>Versions</h3>
      <p class="hint">Every save keeps the one before it. A save takes effect on the bot's next run.</p>
      ${history}
      <div data-part="rules-diff"></div>
    </aside>
  </div>`
}

// ── adding a bot ────────────────────────────────────────────────────────────────────

/** First what to start from: nothing, or one of the templates the repository ships. */
export function botNewScreen(d) {
  const sets = [...new Set(d.templates.map((t) => t.setName))]
  const group = (name) => `<h3>${esc(name)}</h3><div class="pick-list">${d.templates.filter((t) => t.setName === name).map((t) => `<button class="pick-row" data-act="bot-new-from" data-from="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.does || t.title)}</span><i>${esc(t.aiName)}</i></button>`).join('')}</div>`
  return `<div class="pick-list"><button class="pick-row other" data-act="bot-new-from" data-from=""><b>A blank bot</b><span>You say what it is for and write its instructions.</span><i>Blank</i></button></div>
    ${sets.map(group).join('') || '<p class="hint">This copy of Botyard ships no templates yet.</p>'}`
}

/** A blank bot's starting fields, or a template's. */
export function newBotFields(d, from) {
  const t = d.templates.find((x) => x.id === from)
  const base = { name: '', title: '', does: '', role: 'general', reportsTo: d.lead || '', ai: 'free', model: 'auto', effort: '', minutes: 60, turns: null, atOnce: 1, mayNot: ['push'], mayNotKept: true }
  if (!t) return base
  const f = t.fields || {}
  return { ...base, ...f, reportsTo: f.role === 'ceo' ? '' : d.lead || '', effort: f.effort || '', turns: f.turns ?? null, atOnce: f.atOnce || 1 }
}

// ── Setup ───────────────────────────────────────────────────────────────────────────

const STATE_TAG = { ok: 'done', missing: 'bad', 'signed-out': 'warn', unknown: 'dim' }
const GROUPS = [
  ['free', 'Free models', 'Work with no account and cost nothing. Enough to run a whole crew; a key raises the daily limits.'],
  ['ai', 'Your own AI subscriptions', 'Each is signed in through its own tool, on its own page. Botyard never sees a password.'],
  ['needs', 'What Botyard itself needs', ''],
]

function setupRow(r, open) {
  const a = r.action
  // A thing that is optional and missing is not an alarm: only what Botyard cannot work without is red.
  const tone = r.state === 'missing' && !r.needed ? 'dim' : STATE_TAG[r.state] || 'dim'
  let act = ''
  if (a?.kind === 'key') act = `<button class="btn ${r.state === 'ok' ? '' : 'primary'}" data-act="setup-key" data-id="${esc(r.id)}" aria-expanded="${open === r.id}">${esc(a.label)}</button>`
  else if (a?.kind === 'start') act = a.here === false ? '' : `<button class="btn primary" data-act="setup-start" data-id="${esc(r.id)}">${esc(a.label)}</button>`
  else if (a?.kind === 'link') act = `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.label)}</a>`
  const keyForm = a?.kind === 'key' && open === r.id ? `<form class="fields key-form" data-part="setup-key" data-id="${esc(r.id)}" autocomplete="off">
      <label class="stack">The key<input name="key" type="password" required minlength="8" maxlength="4000" autocomplete="new-password" spellcheck="false"></label>
      <button class="btn primary" type="submit">Save the key</button>
      <p class="hint">It is kept in a file only you can read on this computer, and is never shown again.${a.keysPage ? ` <a href="${esc(a.keysPage)}" target="_blank" rel="noopener noreferrer">Where keys are made</a>` : ''}</p>
    </form>` : ''
  const byHand = a?.kind === 'start' && a.command ? `<small class="by-hand">${a.here === false ? 'On the computer Botyard runs on, run' : 'Or run it yourself:'} <code>${esc(a.command)}</code></small>` : ''
  return `<div class="setup-row ${r.state}" data-setup="${esc(r.id)}">
    <div class="what"><b>${esc(r.name)}</b><span>${esc(r.what)}</span>${r.detail ? `<small>${esc(r.detail)}</small>` : ''}${byHand}</div>
    ${tag(tone, r.stateWords)}
    <div class="do">${act}${r.forget ? `<button class="btn ghost" data-act="setup-forget" data-id="${esc(r.id)}">Forget the key</button>` : ''}</div>
    ${keyForm}
  </div>`
}

/** One row per thing a studio needs: what it is for, how it stands, and the one thing to do. Free models first. */
export function setupRows(d, { open = '' } = {}) {
  if (!d) return '<p class="none">Reading…</p>'
  if (!d.available) return `<p class="none">${esc(d.summary)}</p>`
  return GROUPS.map(([kind, title, about]) => {
    const rows = d.rows.filter((r) => r.kind === kind)
    return rows.length ? `<section class="setup-group"><h3>${title}</h3>${about ? `<p class="hint">${about}</p>` : ''}${rows.map((r) => setupRow(r, open)).join('')}</section>` : ''
  }).join('')
}

const STEP_NAMES = { name: 'Name your yard', setup: 'Connect an AI', crew: 'Pick a crew', chat: 'Say hello to a bot', project: 'Add a project', job: 'Give a first job', phone: 'Pair a phone' }
/** Where the phone app is to be had: the release page of the repository this copy came from. */
const APP_PAGE = 'https://github.com/Venutian/botyard/releases/latest'

/** What to try when a step does not go as it says, in a fold of its own under the step. */
const stuck = (title, tips) => `<details class="first-stuck"><summary>${esc(title)}</summary><ul>${tips.map((tip) => `<li>${tip}</li>`).join('')}</ul></details>`
/** A warning when no AI tool is ready: no bot can run until one is. */
const noAi = (setup) => (setup?.available && !setup.ready ? `<p class="flag warn"><i></i><span>${esc(setup.summary)} Until one is ready, no bot can run. <button class="link" type="button" data-act="first-open" data-step="setup">Go to Connect an AI</button></span></p>` : '')

/** The Setup page: how the studio stands in a sentence, its rows, then the rest of setting up. */
export function setupScreen(d, first, opts) {
  const left = (first?.left || [])
  return `${d?.available ? `<p class="flag ${d.ready ? 'good' : 'warn'}"><i></i><span>${esc(d.summary)}</span></p>` : ''}
    ${left.length ? `<section class="setup-group pick-up"><h3>Still to do from the first run</h3>
      ${left.map((s) => `<div class="setup-row"><div class="what"><b>${STEP_NAMES[s]}</b></div><span></span><div class="do"><button class="btn" data-act="first-open" data-step="${s}">Do it now</button></div></div>`).join('')}</section>` : ''}
    ${setupRows(d, opts)}
    ${d?.available ? `<div class="acts"><button class="btn ghost" data-act="setup-check">Check everything again</button>${d.checkedAt ? `<span class="dim checked">Checked ${esc(when(d.checkedAt))}</span>` : ''}</div>` : ''}
    <section class="setup-group"><h3>The rest of setting up</h3>
      <div class="setup-row"><div class="what"><b>Connectors</b><span>Services the crew may reach outside this computer, like GitHub or a shop, and who may use each.</span></div><span></span><div class="do"><button class="btn" data-act="to-connectors">Open Connectors</button></div></div>
      <div class="setup-row"><div class="what"><b>The crew</b><span>Add a bot, change which AI runs one, edit its instructions.</span></div><span></span><div class="do"><button class="btn" data-act="to-crew">Open Crew</button></div></div>
      <div class="setup-row"><div class="what"><b>Helpers</b><span>The small scripts that keep the crew moving, and when each runs.</span></div><span></span><div class="do"><button class="btn" data-act="to-routines">Open Routines</button></div></div>
    </section>`
}

// ── the first run ───────────────────────────────────────────────────────────────────

/** The five steps as a job card: a punched hole for each one done, the open one painted. */
function stepCard(first, at) {
  return `<ol class="step-card" aria-label="Steps">${first.steps.map((s, n) => `<li class="${s.state} ${s.id === at ? 'now' : ''}">
    <button data-act="first-open" data-step="${s.id}" ${s.id === at ? 'aria-current="step"' : ''}>
      <i aria-hidden="true">${s.state === 'done' ? '✓' : n + 1}</i><span>${STEP_NAMES[s.id]}</span><small>${s.state === 'done' ? 'Done' : s.state === 'skipped' ? 'Skipped' : s.id === at ? 'Now' : ''}</small>
    </button></li>`).join('')}</ol>`
}

const skip = (step, words = 'Skip this step') => `<button class="btn ghost" type="button" data-act="first-skip" data-step="${step}">${words}</button>`

/**
 * The first run: the card of steps, and the open step's own page. `x` carries what a step needs:
 * the setup rows, the templates, the crew and projects made so far, and the first job as the map sees it.
 */
export function firstScreen(first, at, x = {}) {
  const done = first.steps.find((s) => s.id === at)?.state === 'done'
  let body = ''
  if (!at) {
    body = `<section class="first-step"><h2>Your yard is set up</h2>
      <p class="lead">Everything here stays in Setup. The map is your yard from now on: a bay for each project, the crew standing where their work is.</p>
      <div class="acts"><button class="btn primary" data-act="first-close">Go to the map</button><button class="btn" data-act="to-setup">Open Setup</button></div></section>`
  } else if (at === 'name') {
    body = `<section class="first-step"><h2>What is your yard called?</h2>
      <p class="lead">A yard is your crew of AI bots and the projects they work on. Its name hangs over the gate on the map and is in what the bots are told.</p>
      <form class="fields" data-part="first-name"><label class="stack">Yard name<input name="name" value="${esc(first.studio.name === 'My studio' ? '' : first.studio.name)}" maxlength="80" required placeholder="Like “Tea Shop Yard”" autocomplete="off"></label>
      <div class="acts"><button class="btn primary" type="submit">${done ? 'Change the name' : 'Name the yard'}</button>${done ? '<button class="btn" type="button" data-act="first-next">Next step</button>' : skip('name', 'Keep “My studio” for now')}</div></form></section>`
  } else if (at === 'setup') {
    body = `<section class="first-step"><h2>Connect an AI, or start on free models</h2>
      <p class="lead">Bots need an AI to run on. Free models need no account, so a crew can start today; sign in your own subscriptions when you want stronger ones.</p>
      ${x.setup?.available ? `<p class="flag ${x.setup.ready ? 'good' : 'warn'}"><i></i><span>${esc(x.setup.summary)}</span></p>` : ''}
      <div class="acts"><button class="btn primary" data-act="first-seen" data-step="setup">${x.setup?.ready ? 'Next step' : 'Carry on anyway'}</button>${x.setup?.available ? '<button class="btn ghost" data-act="setup-check">Check again</button>' : ''}</div>
      ${setupRows(x.setup, { open: x.open })}
      ${stuck('If a sign-in does not work', [
        'A sign-in opens in a terminal window. Finish it there, close it, then press <b>Check again</b>.',
        'No terminal opened? Run the command shown in the row yourself, in any terminal on this computer, then check again.',
        '<b>Install</b> commands use npm, which comes with Node.js. If <code>npm</code> is not found, install Node.js 22.13 or newer from nodejs.org first.',
        'A tool you just installed is not found? Close and open Botyard again, so it reads the new PATH.',
        'Git missing: every job ends in a commit, so Botyard needs it. Get it from git-scm.com, then check again.',
      ])}</section>`
  } else if (at === 'crew') {
    const starter = (x.templates || []).filter((t) => t.default)
    const have = first.crew.length ? `<p class="flag good"><i></i><span>The crew so far: ${esc(first.crew.map((b) => `${b.name}${b.paused ? ' (off)' : ''}`).join(', '))}.</span></p>` : ''
    body = `<section class="first-step"><h2>Pick a crew</h2>
      <p class="lead">A crew is a set of bots with different jobs: a lead hands out the work, builders do it, a checker checks it. Start with the default crew or with nothing; every bot can be changed later.</p>
      ${have}
      <div class="choice-plates">
        <div class="choice-plate"><h3>The default crew</h3>
          ${starter.length ? `<ul>${starter.map((t) => `<li><b>${esc(t.name)}</b><span>${esc(t.does || t.title)}</span><i>${esc(t.aiName)}${t.needs ? ', off until signed in' : ''}</i></li>`).join('')}</ul>
          <button class="btn primary" data-act="first-starter">Add the default crew</button>` : '<p class="none">This copy of Botyard has no default crew: its crew/bots folder is empty. Start blank instead.</p>'}
        </div>
        <div class="choice-plate"><h3>Start blank</h3>
          <p class="hint">Make your own bots one at a time: you name each, pick its AI and write what it does.</p>
          <button class="btn" data-act="bot-new">Add a bot</button>
        </div>
      </div>
      <div class="acts">${done ? '<button class="btn primary" data-act="first-next">Next step</button>' : skip('crew')}</div></section>`
  } else if (at === 'chat') {
    const greet = first.greet
    const chat = first.chat
    const said = chat?.answered
      ? `<p class="flag good"><i></i><span>${esc(chat.bot)} answered: “${esc(chat.text.length > 240 ? `${chat.text.slice(0, 240)}…` : chat.text)}”</span></p>`
      : chat ? `<p class="flag"><i></i><span>${esc(chat.bot)} has your message. A first answer can take a minute or two while its AI starts up. This page checks by itself.</span></p>` : ''
    body = `<section class="first-step"><h2>${chat?.answered ? 'A bot answered you' : 'Say hello to a bot'}</h2>
      <p class="lead">This is the quickest proof that everything works: the bot's AI starts on this computer, reads what you wrote and answers in the chat. Ask it what it can do, or who is in the crew.</p>
      ${greet ? '' : '<p class="flag warn"><i></i><span>There is no bot switched on to talk to yet. Go back a step and pick a crew first.</span></p>'}
      ${noAi(x.setup)}${said}
      <div class="acts">${greet ? `<button class="btn ${chat?.answered ? '' : 'primary'}" data-act="first-chat" data-id="${esc(chat?.botId || greet.id)}">${chat ? `Open the chat with ${esc(chat.bot)}` : `Say hello to ${esc(greet.name)}`}</button>` : '<button class="btn" data-act="first-open" data-step="crew">Pick a crew</button>'}
        ${done ? '<button class="btn primary" data-act="first-next">Next step</button>' : skip('chat')}</div>
      ${stuck('If no answer comes', [
        'Give it five minutes: a free model may have to wait its turn, and the first start of an AI tool is slow.',
        'Open <b>Setup</b> and check that the AI this bot runs on says <b>Ready</b>. A bot on Claude, Codex or Gemini needs that tool installed and signed in.',
        'A bot marked <b>Off</b> does not answer. Switch it on in <b>Crew</b>, or say hello to another one.',
        'In <b>Crew</b>, open the bot and its last run: the log shows what its AI said, and a sign-in or limit error shows there first.',
      ])}</section>`
  } else if (at === 'phone') {
    const p = x.pair
    const qr = x.pairQr
    const addresses = p?.addresses || []
    body = `<section class="first-step"><h2>${first.phones && !qr ? 'A phone is paired' : 'Pair a phone'}</h2>
      <p class="lead">Follow the crew, answer its questions and give it jobs from your phone. The phone talks to this computer through a locked door of its own, with a key for each phone. This step is optional.</p>
      ${first.phones && !qr ? `<p class="flag good"><i></i><span>${first.phones === 1 ? 'One phone has' : `${first.phones} phones have`} a key${p?.open === false && p?.why ? `, but the door is closed: ${esc(p.why)}` : ''}. Keys can be taken back in Settings, under Phones.</span></p>` : ''}
      ${qr ? `<div class="pair-code">
          <div class="qr" role="img" aria-label="Pairing code for the phone">${qr}</div>
          <ol class="pair-how">
            <li>Install the Botyard app on the phone (Android): the APK is on the <a href="${APP_PAGE}" target="_blank" rel="noopener">release page</a>.</li>
            <li>Point the phone's camera at this code and open the link it finds. The app opens and connects.</li>
            <li>The phone has to be on the same Wi-Fi as this computer, which it finds at <code>${esc(x.pairAt || '')}</code>.</li>
          </ol>
          <p class="flag warn"><i></i><span>This code is a key to your yard. Close it once the phone is connected, and do not share a picture of it.</span></p>
        </div>
        <div class="acts"><button class="btn primary" data-act="first-pair-done">The phone is connected</button><button class="btn ghost" data-act="first-pair-hide">Hide the code</button></div>`
      : `<form class="fields" data-part="first-pair">
          <div class="two"><label class="stack">Name of the phone<input name="name" maxlength="40" placeholder="Like “My Pixel”" autocomplete="off"></label>
          ${addresses.length > 1 ? `<label class="stack">This computer's address<select name="host">${addresses.map((a, n) => opt(a, a, n === 0 ? a : '')).join('')}</select></label>` : ''}</div>
          ${p && !addresses.length ? '<p class="flag warn"><i></i><span>This computer is on no network a phone could reach. Connect it to your Wi-Fi, then come back.</span></p>' : ''}
          <div class="acts"><button class="btn ${first.phones ? '' : 'primary'}" type="submit" ${p && !addresses.length ? 'disabled' : ''}>${first.phones ? 'Pair another phone' : 'Make a pairing code'}</button>
          ${done ? '<button class="btn primary" type="button" data-act="first-next">Finish</button>' : skip('phone', 'No phone for now')}</div></form>`}
      ${stuck('If the phone cannot connect', [
        'Check that the phone is on the same Wi-Fi as this computer, not on mobile data.',
        `The computer's firewall may block the door. Allow incoming connections on port <code>${esc(String(p?.port || 5288))}</code> for your home network (on Windows, say yes when it asks about Botyard).`,
        'The address can change when the computer joins another network. Make a new code; the old phone key can be taken back in Settings, under Phones.',
        'Away from home, the phone needs WireGuard or a Cloudflare link: see <b>Away from home</b> in the README.',
      ])}</section>`
  } else if (at === 'project') {
    const have = first.projects.length ? `<p class="flag good"><i></i><span>Projects so far: ${esc(first.projects.map((p) => p.name).join(', '))}.</span></p>` : ''
    body = `<section class="first-step"><h2>Add a project</h2>
      <p class="lead">A project is a folder of code the crew works in. Each job gets its own branch there, so nothing touches your work until you take it.</p>
      ${have}${projectAddForm()}
      <div class="acts">${done ? '<button class="btn primary" data-act="first-next">Next step</button>' : skip('project')}</div>
      ${stuck('If the project is not added', [
        'A folder has to be a git repository. If it is not yet, Botyard offers to start git in it.',
        'Have no project at hand? Make an empty folder, add it here, and let the first job be \u201cWrite a README for this project\u201d.',
        'A private GitHub address needs GitHub signed in first, in <b>Setup</b>.',
        'On Windows, write the folder in full, like <code>C:\\Users\\you\\projects\\tea-shop</code>.',
      ])}</section>`
  } else if (at === 'job') {
    const line = x.line
    const watch = first.firstJob ? `<div class="watch"><h3>Your first job</h3>
        <button class="line" data-line="${esc(first.firstJob.id)}"><span class="ref">${esc(line?.ref || first.firstJob.ref)}</span><span class="title">${esc(line?.title || first.firstJob.title)}</span>
        <span class="stage ${line ? esc(x.stage?.[1] || '') : 'wait'}">${esc(line ? x.stage?.[0] || line.stage : 'Waiting')}</span><span class="note">${esc(line ? [line.bot, line.note].filter(Boolean).join(': ') : 'Nobody has taken it yet')}</span></button>
        <p class="hint">${line?.bot ? `${esc(line.bot)} has it. Open it to read what the bot says and see its changes; this line follows it as it moves.` : first.crew.some((b) => !b.paused) ? 'A bot takes it within a minute. This line follows it as it moves.' : 'No bot is switched on to take it. Add one, or switch one on, from Crew.'}</p>
        <div class="acts"><button class="btn primary" data-act="first-close">Go to the map</button><button class="btn" data-act="open-job" data-id="${esc(first.firstJob.id)}">Open the job</button></div></div>` : ''
    body = `<section class="first-step"><h2>${first.firstJob ? 'The crew has your first job' : 'Give a first job'}</h2>
      <p class="lead">${first.firstJob ? 'On the map, the sign over the project\u2019s bay counts the job as it is built and checked, and the bot that has it stands in the bay. When it is done, its commits wait for you on a branch of their own: nothing is merged without your yes.' : 'Say what you want done, as you would to a person. The bot that leads the crew takes it and hands it on, unless you pick who does it. Start with something small, so you can see the whole way from job to commit.'}</p>
      ${noAi(x.setup)}
      ${watch ? `${watch}${first.steps.some((s) => s.id === 'phone' && s.state !== 'done') ? '<div class="acts"><button class="btn" data-act="first-open" data-step="phone">Pair a phone next</button></div>' : ''}` : `<form class="fields" data-part="first-job">
        <label class="stack">What should be done<input name="title" maxlength="180" required placeholder="Like “Add a README that says what this project is”" autocomplete="off"></label>
        <label class="stack">Details<textarea name="description" rows="4" placeholder="What done looks like, where to look, what not to touch"></textarea></label>
        <div class="two"><label class="stack">Project<select name="projectId">${opt('', 'None', '')}${first.projects.map((p, n) => opt(p.id, p.name, n === 0 ? p.id : '')).join('')}</select></label>
        <label class="stack">Who<select name="botId">${opt('', first.crew.length ? 'The lead decides' : 'Nobody yet', '')}${first.crew.map((b) => opt(b.id, `${b.name}${b.paused ? ' (off)' : ''}`, '')).join('')}</select></label></div>
        ${first.crew.length ? '' : '<p class="flag warn"><i></i><span>There is no bot to take a job yet. Go back a step and pick a crew first.</span></p>'}
        <div class="acts"><button class="btn primary" type="submit" ${first.crew.length ? '' : 'disabled'}>Give the job</button>${skip('job')}</div>
      </form>`}
      ${stuck('If the job does not move', [
        'Nobody takes it after a few minutes: check in <b>Setup</b> that the AI the lead runs on is ready, and in <b>Crew</b> that the lead is switched on.',
        'A job waits in <b>Needs you</b> when a bot asks you something: answer the card with stripes and it carries on.',
        'Open the job and its runs to read what the bot did and said. A run that ended badly says why.',
        'The work is on a branch of its own in your project, under <code>.botyard/worktrees/</code>; your own checkout is never touched.',
      ])}</section>`
  }
  return `<div class="first-run">${stepCard(first, at)}${body}</div>`
}

// ── projects ────────────────────────────────────────────────────────────────────────

/** Add a project: a folder that is already on this computer, or a repository's address to copy here. */
export function projectAddForm({ from = 'folder', error = null } = {}) {
  return `<form class="fields project-add" data-part="project-add">
    <div class="seg" role="radiogroup" aria-label="Where the project is">
      <label><input type="radio" name="from" value="folder" ${from === 'folder' ? 'checked' : ''}><span>A folder on this computer</span></label>
      <label><input type="radio" name="from" value="repo" ${from === 'repo' ? 'checked' : ''}><span>A GitHub address</span></label>
    </div>
    <label class="stack from-folder" ${from === 'folder' ? '' : 'hidden'}>Folder<input name="folder" placeholder="~/projects/tea-shop" spellcheck="false" autocomplete="off"></label>
    <label class="stack from-repo" ${from === 'repo' ? '' : 'hidden'}>Address<input name="repo" placeholder="https://github.com/you/tea-shop" spellcheck="false" autocomplete="off"></label>
    <label class="stack">Name<input name="name" maxlength="80" placeholder="Leave empty to use the folder's name" autocomplete="off"></label>
    <p class="hint from-repo" ${from === 'repo' ? '' : 'hidden'}>It is copied into the <code>projects</code> folder inside Botyard's own folder. A private one needs GitHub signed in first, in Setup.</p>
    ${error?.canInit ? `<p class="flag warn"><i></i><span>${esc(error.message)}. <button class="link" type="button" data-act="project-init">Start git in that folder and add it</button></span></p>` : ''}
    <div class="acts"><button class="btn primary" type="submit">Add the project</button></div>
  </form>`
}

/** A project's own settings: its name, its folder, and putting it away. */
export function projectEditScreen(p, { error = null } = {}) {
  const main = p.folders.find((f) => f.primary) || p.folders[0]
  return `<form class="fields" data-part="project-rename"><section class="plate-sec"><h3>Name</h3>
      <label class="stack">Project name<input name="name" value="${esc(p.name)}" maxlength="80" required autocomplete="off"></label>
      <div class="acts"><button class="btn primary" type="submit">Save the name</button></div></section></form>
    <form class="fields" data-part="project-move"><section class="plate-sec"><h3>Folder</h3>
      <p class="hint">Where its code is on this computer. New jobs branch from here; jobs already going stay where they are.</p>
      <label class="stack">Folder<input name="folder" value="${esc(main?.folder || '')}" required spellcheck="false" autocomplete="off" placeholder="~/projects/tea-shop"></label>
      ${error?.canInit ? `<p class="flag warn"><i></i><span>${esc(error.message)}. <button class="link" type="button" data-act="project-move-init">Start git in that folder and use it</button></span></p>` : ''}
      <div class="acts"><button class="btn" type="submit">Use this folder</button></div></section></form>
    <section class="plate-sec danger-sec"><h3>${p.archived ? 'Bring it back' : 'Archive'}</h3>
      <p class="hint">${p.archived ? 'It is archived: off the map and out of every list. Its jobs and folder are as you left them.' : 'Takes it off the map and out of every list. Nothing is deleted: its jobs, history and folder stay, and it can be brought back from Setup.'}</p>
      <div class="acts">${p.archived ? `<button class="btn primary" data-act="project-restore" data-id="${esc(p.id)}">Bring ${esc(p.name)} back</button>` : `<button class="btn danger" data-act="project-archive" data-id="${esc(p.id)}">Archive ${esc(p.name)}…</button>`}</div>
    </section>`
}
