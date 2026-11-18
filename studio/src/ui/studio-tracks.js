/**
 * Tracks on the page (docs/tracks.md): the saved tracks drawn as diagrams, the requests on them with
 * their cost, and one trip step by step, where the owner answers a gate, sends work back with a note,
 * or runs a step again. Pure HTML of what the server sent, plus the few methods the Studio class
 * mixes in to fetch and act. The diagram is read-only: tracks are edited through the API for now.
 */
import { esc, when } from './studio-crew.js'

const KIND = { bot: 'Bot', script: 'Script', gate: 'You', track: 'Track' }
const STEP_STATE = { passed: ['Passed', 'go'], failed: ['Failed', 'bad'], working: ['Working', 'warn'], waiting: ['Next', 'warn'], 'not-started': ['Not yet', 'dim'] }
const TRIP_CLASS = { running: 'go', paused: 'warn', 'not-in-main': 'warn', done: 'done', stuck: 'bad', stopped: 'dim' }
const at = (iso) => (iso ? when(Date.parse(iso) || 0) : '')

/**
 * A track as a drawing: one box a step, top to bottom in order. A pass to the next step is a line
 * down the middle; a line that skips ahead runs down the right; a failed check's line back runs up
 * the left, dashed, with its rounds. `states` colours each box by how its step stands in a trip.
 */
export function trackDiagram(steps, lines, { states = {}, current = '', title = 'Track' } = {}) {
  const W = 360
  const H = 46
  const GAP = 26
  const top = 12
  const x0 = 78
  const x1 = W - 78
  const y = (i) => top + i * (H + GAP)
  const index = new Map(steps.map((s, i) => [s.id, i]))
  const parts = []
  let right = 0
  let left = 0
  for (const line of lines) {
    const a = index.get(line.from)
    const b = index.get(line.to)
    if (a === undefined || b === undefined) continue
    const fail = line.on === 'fail'
    const cls = `ln ${fail ? 'fail' : 'pass'}${line.on === 'always' ? ' always' : ''}`
    if (b === a + 1 && !fail) {
      parts.push(`<path class="${cls}" d="M${W / 2} ${y(a) + H} V${y(b) - 3}" marker-end="url(#tk-arrow)"/>`)
    } else if (b > a) {
      const x = x1 + 12 + (right++ % 4) * 11
      parts.push(`<path class="${cls}" d="M${x1} ${y(a) + H * 0.62} H${x} V${y(b) + H * 0.38} H${x1 + 3}" marker-end="url(#tk-arrow)"/>`)
    } else {
      const x = x0 - 12 - (left++ % 4) * 11
      const label = line.rounds ? `<text class="rounds" x="${x - 4}" y="${(y(a) + y(b) + H) / 2}" text-anchor="end">×${line.rounds}</text>` : ''
      parts.push(`<path class="${cls} back" d="M${x0} ${y(a) + H * 0.62} H${x} V${y(b) + H * 0.38} H${x0 - 3}" marker-end="url(#tk-arrow-back)"/>${label}`)
    }
  }
  const boxes = steps.map((s, i) => {
    const state = states[s.id] || ''
    const name = esc(s.title || s.id)
    return `<g class="step k-${esc(s.kind)} s-${esc(state)}${s.id === current ? ' now' : ''}">
      <rect x="${x0}" y="${y(i)}" width="${x1 - x0}" height="${H}" rx="9"/>
      <text class="kind" x="${x0 + 12}" y="${y(i) + 17}">${KIND[s.kind] || s.kind}${s.ruling ? ', ruling' : ''}</text>
      <text class="name" x="${x0 + 12}" y="${y(i) + 35}">${name.length > 30 ? `${name.slice(0, 29)}…` : name}</text>
    </g>`
  }).join('')
  const height = y(steps.length - 1) + H + top
  return `<svg class="track-diagram" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}: ${steps.map((s) => esc(s.title || s.id)).join(', then ')}">
    <defs>
      <marker id="tk-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="tip"/></marker>
      <marker id="tk-arrow-back" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="tip back"/></marker>
    </defs>${parts.join('')}${boxes}</svg>`
}

/** One request's row: what, its track, where it stands, what it cost. */
const requestRowHtml = (r) => `<tr class="go-row" data-act="open-trip" data-id="${esc(r.tripId)}" tabindex="0">
  <td class="nowrap"><b>${esc(r.job)}</b></td>
  <td class="job">${esc(r.title)}<small>${esc(r.track)}</small></td>
  <td><span class="state ${r.waitsForOwner ? 'warn' : TRIP_CLASS[r.tripStatus] || ''}">${esc(r.waitsForOwner ? 'Waits for you' : r.state)}</span>${r.at && r.status === 'working' ? `<small>${esc(r.at)}</small>` : ''}${r.reason && r.tripStatus === 'stuck' ? `<small>${esc(r.reason)}</small>` : ''}</td>
  <td class="n">${esc(r.cost)}</td>
</tr>`

/** The Tracks screen: requests first (what is moving, what waits for you), then each saved track drawn. */
export function tracksScreen({ tracks = [], requests = [] } = {}) {
  const waiting = requests.filter((r) => r.waitsForOwner).length
  const list = requests.length
    ? `<div class="grid-wrap"><table class="grid requests"><thead><tr><th>Job</th><th>What</th><th>Where it stands</th><th class="n">Cost</th></tr></thead><tbody>${requests.map(requestRowHtml).join('')}</tbody></table></div>`
    : '<p class="none">No request has moved along a track yet.</p>'
  const drawn = tracks.map((t) => `<details class="track-card"${tracks.length <= 2 ? ' open' : ''}>
    <summary><b>${esc(t.title)}</b> <span class="dim">${esc(t.key)} · version ${t.version}${t.builtIn ? ' · built in' : ''} · ${t.delivers === 'nothing' ? 'delivers no change' : 'finished when in main'}</span></summary>
    ${t.description ? `<p class="hint">${esc(t.description)}</p>` : ''}
    ${trackDiagram(t.steps, t.lines, { title: t.title })}
  </details>`).join('')
  return `<p class="hint">${waiting ? `<b>${waiting} wait${waiting === 1 ? 's' : ''} for you.</b> ` : ''}A request moves along its track step by step; a failed check goes back with its findings; it is finished only when its change is in main.</p>
    <h3>Requests</h3>${list}
    <h3>Tracks</h3><p class="hint">Read-only for now: a track is saved through the engine's API.</p>${drawn || '<p class="none">No tracks are saved.</p>'}`
}

const STEP_WORDS = (s) => (s.state === 'working' ? (s.kind === 'gate' ? 'Waits for you' : 'Working') : (STEP_STATE[s.state] || [s.state])[0])

const HIDDEN_LEAVES = ['workdir', 'branch', 'verdict']
/** What a step left: a commit by its short id, a short value in full, a long one folded. */
function leftHtml(s) {
  const names = s.leftNames.filter((k) => !HIDDEN_LEAVES.includes(k))
  if (!names.length) return ''
  const one = (k) => {
    const value = String(s.left[k] ?? '')
    if (k === 'commit') return `<p class="left"><b>${esc(k)}</b> <code>${esc(value.slice(0, 10))}</code></p>`
    return value.length <= 240 ? `<p class="left"><b>${esc(k)}</b> ${esc(value)}</p>` : `<details class="left"><summary><b>${esc(k)}</b> ${esc(value.slice(0, 120))}…</summary><pre>${esc(value)}</pre></details>`
  }
  return names.map(one).join('')
}

/** One step of a trip in the run view. */
function stepHtml(s, n) {
  const [, cls] = STEP_STATE[s.state] || ['', '']
  const said = [s.findings && s.state === 'failed' ? `<details class="findings" open><summary>Findings</summary><pre>${esc(s.findings)}</pre></details>` : '',
    s.handedFindings && s.state !== 'not-started' ? `<details class="findings"><summary>Handed the last check's findings</summary><pre>${esc(s.handedFindings)}</pre></details>` : '',
    s.note ? `<p class="owner-note"><b>Your note:</b> ${esc(s.note)}</p>` : '',
    s.summary && s.kind === 'script' ? `<details><summary>What it printed</summary><pre>${esc(s.summary)}</pre></details>` : '',
    Object.keys(s.numbers || {}).length ? `<p class="dim">${Object.entries(s.numbers).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</p>` : '',
    leftHtml(s),
  ].join('')
  return `<li class="trip-step ${s.current ? 'now' : ''}" data-step="${esc(s.id)}">
    <div class="trip-step-head">
      <span class="n">${n + 1}</span>
      <span class="kind">${KIND[s.kind] || s.kind}</span>
      <b>${esc(s.title)}</b>
      <span class="state ${s.state === 'working' && s.kind === 'gate' ? 'warn' : cls}">${esc(STEP_WORDS(s))}</span>
      ${s.tries > 1 ? `<span class="dim">round ${s.tries}</span>` : ''}
      <span class="cost">${s.costUsd ? esc(s.cost) : ''}</span>
    </div>
    ${s.job ? `<p class="dim">${s.bot ? `${esc(s.bot.replace(/^\$/, ''))} · ` : ''}<button class="link" data-act="open-job" data-id="${esc(s.jobId)}"><b>${esc(s.job)}</b></button>${s.finishedAt ? ` · ended ${esc(at(s.finishedAt))}` : s.startedAt ? ` · started ${esc(at(s.startedAt))}` : ''}</p>` : ''}
    ${said}
  </li>`
}

/** The gate's three answers: approve, send back to a step with a note, or add context and run the step before again. */
function gateHtml(gate) {
  if (!gate) return ''
  const before = gate.backTo.at(-1)
  return `<section class="gate-card" data-part="gate">
    <h3>Waits for you: ${esc(gate.title)}</h3>
    <div class="gate-acts">
      <button class="btn primary" data-act="trip-gate" data-do="approve">Approve</button>
    </div>
    <form class="fields" data-part="gate-note">
      <label class="stack">Note for the work <textarea name="note" rows="3" maxlength="4000" placeholder="What to change, or what the step should know"></textarea></label>
      <div class="gate-acts">
        ${before ? `<button class="btn" type="button" data-act="trip-gate" data-do="context">Add this and run “${esc(before.title)}” again</button>` : ''}
        ${gate.backTo.length ? `<label class="inline">Send back to <select name="to">${gate.backTo.map((s) => `<option value="${esc(s.id)}" ${s.id === before?.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label>
        <button class="btn" type="button" data-act="trip-gate" data-do="back">Send back</button>` : ''}
      </div>
    </form>
  </section>`
}

/** A trip, as the run view shows it: where it stands, the gate when it waits, the drawing, each step. */
export function tripScreen(t) {
  const states = Object.fromEntries(t.steps.map((s) => [s.id, s.state]))
  const r = t.request
  const head = `<div class="trip-head">
    <span class="state ${TRIP_CLASS[t.status] || ''}">${esc(t.state)}</span>
    <span>${esc(r.job)} · ${esc(t.track.key)} v${t.track.version}</span>
    <span class="cost" title="Every step, round and rerun of this request">${esc(r.cost)} for the request</span>
  </div>
  ${t.reason ? `<p class="${t.status === 'stuck' ? 'bad' : 'hint'}">${esc(t.reason)}</p>` : ''}
  ${t.status === 'not-in-main' ? `<p class="hint">The steps are done. It is finished when commit <code>${esc(String(t.commit).slice(0, 10))}</code> is in ${esc(t.track.main)}; the engine looks again every minute.</p>` : ''}`
  const controls = `<form class="fields trip-controls" data-part="trip-rerun">
    <div class="gate-acts">
      ${t.can.pause ? '<button class="btn" type="button" data-act="trip" data-do="pause">Pause</button>' : ''}
      ${t.can.resume ? '<button class="btn primary" type="button" data-act="trip" data-do="resume">Resume</button>' : ''}
      ${t.can.stop ? '<button class="btn ghost" type="button" data-act="trip" data-do="stop">Stop</button>' : ''}
    </div>
    <label class="inline">Run again from <select name="step">${t.steps.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}</select></label>
    <label class="stack">Context for that step (optional) <textarea name="note" rows="2" maxlength="4000"></textarea></label>
    <button class="btn" type="button" data-act="trip" data-do="rerun">Run again from there</button>
    <p class="hint">What the steps before it left is kept, so they are not paid for again.</p>
  </form>`
  return `${head}${gateHtml(t.gate)}
    <div class="trip-body">
      <div class="trip-drawing">${trackDiagram(t.steps, t.lines, { states, current: t.current, title: t.track.title })}</div>
      <ol class="trip-steps">${t.steps.map(stepHtml).join('')}</ol>
    </div>
    <h3>Change its course</h3>${controls}`
}

/** The Studio class's own methods for these screens. */
export function trackMethods({ call }) {
  return {
    async openTracks() {
      if (this.screen !== 'tracks') this._openSheet('tracks', 'Tracks', 'The way each request moves: who builds, what checks, where a fail goes, when it is finished', { wide: true })
      this._reopen = () => this.openTracks()
      const seq = ++this._sheetSeq
      const data = await call('/api/studio/tracks').catch((err) => { this.actions.toast(err.message, 'err'); return null })
      const col = this._colOf('tracks')
      if (!col || seq !== col.seq) return
      col.el.querySelector('.sheet-body').innerHTML = data ? tracksScreen(data) : '<p class="none">The tracks could not be read.</p>'
    },

    async openTrip(id) {
      this._openSheet('trip', 'Trip', 'One request on its track, step by step', { wide: true })
      this._reopen = () => this.openTrip(id)
      this._trip = { id }
      const seq = ++this._sheetSeq
      const trip = await call(`/api/studio/trip?id=${encodeURIComponent(id)}`).catch((err) => { this.actions.toast(err.message, 'err'); return null })
      const col = this._colOf('trip')
      if (!col || seq !== col.seq) return
      if (!trip) { col.el.querySelector('.sheet-body').innerHTML = '<p class="none">This trip could not be read.</p>'; return }
      this._trip = trip
      col.el.querySelector('.col-head strong').textContent = trip.request.title
      col.el.querySelector('.sheet-body').innerHTML = tripScreen(trip)
    },

    async _tripAct(action, form) {
      const id = this._trip?.id
      if (!id) return
      const data = form ? Object.fromEntries(new FormData(form)) : {}
      if ((action === 'back' || action === 'context') && !String(data.note || '').trim()) {
        this.actions.toast('Write a note first: it goes with the work', 'err')
        form?.querySelector('textarea')?.focus()
        return
      }
      try {
        const trip = await call('/api/studio/trip', { id, action, step: data.step || '', to: data.to || '', note: data.note || '' })
        this._trip = trip
        const col = this._colOf('trip')
        if (col) col.el.querySelector('.sheet-body').innerHTML = tripScreen(trip)
        // The next step starts on the engine's next turn: look once more, so the view shows the move.
        clearTimeout(this._tripLook)
        this._tripLook = setTimeout(() => { if (this._trip?.id === id && this._colOf('trip')) this.openTrip(id) }, 6000)
        this.actions.toast({ approve: 'Approved: the trip goes on', back: 'Sent back with your note', context: 'Running it again with your note', rerun: 'Running again from that step', pause: 'Paused', resume: 'Going on', stop: 'Stopped' }[action] || 'Done')
      } catch (err) {
        this.actions.toast(err.message, 'err')
      }
    },

    /** @returns {boolean} whether the click was one of these screens' own */
    _tracksAct(el) {
      const { act } = el.dataset
      if (act === 'open-trip') { if (el.dataset.id) this._go(() => this.openTrip(el.dataset.id)); return true }
      if (act === 'trip-gate') { this._tripAct(el.dataset.do, el.dataset.do === 'approve' ? null : el.closest('section')?.querySelector('[data-part="gate-note"]')); return true }
      if (act === 'trip') { this._tripAct(el.dataset.do, el.dataset.do === 'rerun' ? el.closest('form') : null); return true }
      return false
    },
  }
}
