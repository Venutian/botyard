/**
 * What the Studio class does on the screens that shape a studio (see `studio-shape.js` for their
 * HTML): it fetches, routes clicks and forms, asks before anything that cannot be taken back, and
 * guards an edit that is not saved yet. Given to the class as methods, so they read `this` like
 * every other screen's.
 */
import qrcode from 'qrcode-generator'
import { diffHtml, editSummary, esc } from './studio-crew.js'
import {
  aiDetail, botEditScreen, botForm, botNewScreen, changedFields, firstScreen, helpersTable, newBotFields, projectAddForm,
  projectEditScreen, readBotForm, readWhen, rulesScreen, setupScreen,
} from './studio-shape.js'

/** The pairing link as a code for the phone's camera, drawn here: the link holds a key and never leaves this page. */
const qrSvg = (text) => {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true })
}

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

export function shapeMethods({ call, STAGE }) {
  /** A POST that keeps what the server said beside the error (whether git can be started in a folder). */
  const post = async (url, payload) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => null)
    if (!res) throw new Error('Botyard\'s own server is not answering. It may be restarting: try again in a moment')
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { canInit: Boolean(body.canInit) })
    return body
  }

  return {
    /** The map's own view is worked out behind its poll: ask now, and again once it has had time to catch up. */
    _refreshSoon() {
      this.actions.refresh()
      setTimeout(() => this.actions.refresh(), 2500)
      setTimeout(() => this.actions.refresh(), 7000)
    },

    // ── an edit that is not saved yet ──────────────────────────────────────────────

    /** The column whose editor holds changes that are not saved, if any. */
    _unsaved() {
      return [this.cols.b, this.cols.a].find((c) => c.el && !c.el.hidden && c.dirty) || null
    },

    /** Mark the open editor changed or saved; the tag by its Save button says so. */
    _setDirty(col, dirty) {
      col.dirty = dirty
      const mark = col.el.querySelector('[data-part="changed"]')
      if (mark) mark.hidden = !dirty
    },

    /** Do `next` at once, or ask first when it would throw away an edit. */
    _guard(next) {
      const col = this._unsaved()
      if (!col) return next()
      this.cur = col
      this._confirmAsk(`<b>Leave without saving?</b> What you changed on ${esc(col.el.querySelector('.col-head strong').textContent)} since the last save is lost.`, 'Leave without saving', () => { col.dirty = false; next() })
    },

    // ── the crew editor ────────────────────────────────────────────────────────────

    /** Which AIs can run a bot now, by Setup's own ids; read once a minute at most. */
    async _aiReady() {
      if (this._ready && Date.now() - this._ready.at < 60_000) return this._ready.map
      const d = await call('/api/studio/setup-rows').catch(() => null)
      const map = d?.available ? Object.fromEntries(d.rows.map((r) => [r.id, r.state])) : null
      this._ready = { at: Date.now(), map }
      return map
    },

    /**
     * What is known now of which AIs can run a bot, without waiting: the check takes a second or two the
     * first time, so the form shows at once and is drawn again with the tags when the answer comes,
     * unless something was typed in it meanwhile.
     */
    _readyNow(col, redraw) {
      if (this._ready && Date.now() - this._ready.at < 60_000) return this._ready.map
      const screen = col.screen
      this._aiReady().then((map) => {
        if (!map || col.screen !== screen || col.el.hidden || col.dirty) return
        const was = this.cur
        this.cur = col
        this._navigating = true
        try { redraw() } finally { this._navigating = false; if (was !== col) this.cur = was }
      })
      return null
    },

    async openBotEdit(id) {
      const known = this._liveBots().get(id)
      this._openSheet('bot-edit', known ? `${known.name}: settings` : 'Settings', 'Who it is, which AI runs it, what it may and may not do', { wide: true })
      this._reopen = () => this.openBotEdit(id)
      const col = this.cur
      this._setDirty(col, false)
      const seq = ++this._sheetSeq
      const ready = this._readyNow(col, () => this.openBotEdit(id))
      const s = await this._fill('bot-edit', seq, () => call(`/api/studio/bot/settings?id=${encodeURIComponent(id)}`), (d) => botEditScreen(d, { ready }))
      if (!s) return
      this._botEdit = s
      col.el.querySelector('.col-head strong').textContent = `${s.name}: settings`
    },

    async _saveBotEdit(form) {
      const s = this._botEdit
      if (!s || this._saving) return
      if (!form.reportValidity()) return
      const changes = changedFields(readBotForm(form), s)
      if (!Object.keys(changes).length) return this.actions.toast('Nothing changed')
      const col = this.cur
      const save = async () => {
        this._saving = true
        try {
          await call('/api/studio/bot', { action: 'save', bot: s.id, changes })
          this._setDirty(col, false)
          this.actions.toast(`${changes.name || s.name} saved. It takes effect on its next run`)
          this._refreshSoon()
          this.cur = col
          this.openBotEdit(s.id)
        } catch (err) {
          this.actions.toast(err.message || 'The settings were not saved', 'err')
        }
        this._saving = false
      }
      // Moving a bot to another AI is the one change with a cost: its conversation starts over there.
      if (changes.ai) {
        const to = s.choices.ais.find((a) => a.id === changes.ai)?.name || changes.ai
        return this._confirmAsk(`<b>Move ${esc(s.name)} to ${esc(to)}?</b> Its next run starts a fresh conversation there. Its instructions, variables and limits stay.`, `Move to ${to}`, save)
      }
      save()
    },

    _removeBot() {
      const s = this._botEdit
      if (!s) return
      const jobs = s.openJobs ? `Its ${s.openJobs} open job${s.openJobs === 1 ? ' stays' : 's stay'} open with nobody working on ${s.openJobs === 1 ? 'it' : 'them'} until you give ${s.openJobs === 1 ? 'it' : 'them'} to another bot.` : 'It has no open jobs.'
      const reports = s.reports.length ? ` ${esc(s.reports.join(', '))} answer${s.reports.length === 1 ? 's' : ''} to it and will answer to nobody.` : ''
      this._confirmAsk(`<b>Remove ${esc(s.name)}?</b> Any run it has going is stopped. ${jobs}${reports} Its history stays. This cannot be undone here.`, `Remove ${s.name}`, async () => {
        try {
          const col = this.cur
          await call('/api/studio/bot', { action: 'remove', bot: s.id })
          this._setDirty(col, false)
          this.actions.toast(`${s.name} is removed`)
          this._refreshSoon()
          this._closeCol(this.cols.b)
          if (this.cols.a.screen === 'bots') { this.cur = this.cols.a; this.openBots() }
        } catch (err) {
          this.actions.toast(err.message || 'The bot was not removed', 'err')
        }
      })
    },

    /** A variable's value goes to the server in the request and nowhere else: the field is emptied before the answer comes. */
    async _setVariable(form) {
      const s = this._botEdit
      if (!s || !form.reportValidity()) return
      const name = form.elements.name.value.trim()
      const value = form.elements.value.value
      form.elements.value.value = ''
      try {
        await call('/api/studio/bot', { action: 'variable', bot: s.id, name, value })
        this.actions.toast(`${name} is set. Its runs get it from the next one`)
        this._refreshVariables()
      } catch (err) {
        this.actions.toast(err.message || 'The variable was not set', 'err')
      }
    },

    _removeVariable(name) {
      const s = this._botEdit
      if (!s) return
      this._confirmAsk(`<b>Remove ${esc(name)} from ${esc(s.name)}?</b> Its runs no longer get it. The value is deleted.`, 'Remove it', async () => {
        try {
          await call('/api/studio/bot', { action: 'variable-remove', bot: s.id, name })
          this.actions.toast(`${name} is removed`)
          this._refreshVariables()
        } catch (err) {
          this.actions.toast(err.message || 'That did not work', 'err')
        }
      })
    },

    /** Read the variables again without drawing the form over what is being typed in it. */
    async _refreshVariables() {
      const s = this._botEdit
      const col = this._colOf('bot-edit')
      if (!s || !col) return
      if (!col.dirty) { this.cur = col; return this.openBotEdit(s.id) }
      const fresh = await call(`/api/studio/bot/settings?id=${encodeURIComponent(s.id)}`).catch(() => null)
      if (!fresh || this._botEdit?.id !== s.id) return
      s.variables = fresh.variables
      const holder = document.createElement('div')
      holder.innerHTML = botEditScreen({ ...s }, {})
      const now = col.el.querySelector('.plate-sec .vars')?.closest('.plate-sec') || col.el.querySelector('[data-part="var-add"]')?.closest('.plate-sec')
      const next = holder.querySelector('[data-part="var-add"]')?.closest('.plate-sec')
      if (now && next) now.replaceWith(next)
    },

    // ── a bot's instructions ───────────────────────────────────────────────────────

    async openRules(id) {
      const known = this._liveBots().get(id)
      this._openSheet('bot-rules', known ? `${known.name}: instructions` : 'Instructions', 'What it reads before every run', { wide: true })
      this._reopen = () => this.openRules(id)
      const col = this.cur
      this._setDirty(col, false)
      const seq = ++this._sheetSeq
      const bot = await this._fill('bot-rules', seq, () => call(`/api/studio/bot?id=${encodeURIComponent(id)}`), rulesScreen)
      if (!bot) return
      this._rules = bot
      col.el.querySelector('.col-head strong').textContent = `${bot.name}: instructions`
      col.el.querySelector('.sheet-body').classList.add('tall')
      this._countRules(col)
      // The engine may still be reading them: fill in when they come.
      if (!bot.instructions && bot.pending) setTimeout(() => { if (this._colOf('bot-rules') === col && this._rules?.id === id && !col.dirty) { this.cur = col; this._navigating = true; try { this.openRules(id) } finally { this._navigating = false } } }, 2500)
    },

    _countRules(col) {
      const text = col.el.querySelector('[data-part="rules-text"]')
      const count = col.el.querySelector('[data-part="rules-count"]')
      if (text && count) count.textContent = `${text.value.split('\n').length} lines, ${text.value.length.toLocaleString()} characters`
    },

    async _saveRules() {
      const b = this._rules
      const col = this._colOf('bot-rules')
      const text = col?.el.querySelector('[data-part="rules-text"]')?.value
      if (!b?.instructions || text == null || this._saving) return
      if (text === b.instructions.content) return this.actions.toast('Nothing changed')
      if (!text.trim()) return this.actions.toast('The instructions are empty', 'err')
      this._saving = true
      try {
        await call('/api/studio/instructions', { action: 'save', bot: b.id, content: text, base: b.instructions.revisionId })
        this._setDirty(col, false)
        this.actions.toast(`Saved: ${editSummary(b.instructions.content, text)}. ${b.name} reads them on its next run`)
        this.cur = col
        this.openRules(b.id)
      } catch (err) {
        // Someone else saved in between (a bot, a script, another window): nothing typed here is thrown away.
        this.actions.toast(/newest|conflict|409/i.test(err.message) ? 'These instructions were changed somewhere else since you opened them. Copy your text, reopen the page, and put it back in' : err.message || 'The instructions were not saved', 'err')
      }
      this._saving = false
    },

    _restoreRules(revision) {
      const b = this._rules
      const col = this._colOf('bot-rules')
      const h = b?.instructions?.history.find((x) => x.id === revision)
      if (!h || !col) return
      this.cur = col
      this._confirmAsk(`<b>Take ${esc(b.name)}'s instructions back</b> to how they were on ${esc(new Date(h.at).toLocaleString())}? It is saved as a new version, so nothing is lost.${col.dirty ? ' What you changed here since the last save is not kept.' : ''}`, 'Take it back', async () => {
        try {
          await call('/api/studio/instructions', { action: 'restore', bot: b.id, revision, base: b.instructions.revisionId })
          this._setDirty(col, false)
          this.actions.toast('That version is the current one again')
          this.cur = col
          this.openRules(b.id)
        } catch (err) {
          this.actions.toast(err.message || 'That did not work', 'err')
        }
      })
    },

    async _diffRules(from, to) {
      const b = this._rules
      const el = this._colOf('bot-rules')?.el.querySelector('[data-part="rules-diff"]')
      if (!b || !el) return
      try {
        el.innerHTML = `<h3>What that version changed</h3>${diffHtml(await call(`/api/studio/instructions/diff?bot=${b.id}&from=${from}&to=${to}`))}`
      } catch (err) {
        el.innerHTML = `<p class="none">${esc(err.message)}</p>`
      }
      el.scrollIntoView({ block: 'nearest' })
    },

    // ── adding a bot ───────────────────────────────────────────────────────────────

    async openBotNew(from = null) {
      this._openSheet('bot-new', 'Add a bot', from === null ? 'Start from nothing, or from a bot that is already written' : 'Change anything; it can all be changed later too', { wide: true })
      this._reopen = () => this.openBotNew(from)
      const col = this.cur
      this._setDirty(col, false)
      const seq = ++this._sheetSeq
      const ready = this._readyNow(col, () => this.openBotNew(from))
      const d = await this._fill('bot-new', seq, () => (this._botNew ? Promise.resolve(this._botNew) : call('/api/studio/bot/new')), (data) => {
        if (from === null) return botNewScreen(data)
        const fields = newBotFields(data, from)
        this._newFrom = { from, fields }
        const t = data.templates.find((x) => x.id === from)
        return `${t ? `<p class="flag good"><i></i><span>From the template <b>${esc(t.name)}</b>. Its instructions come with it; you can edit them once it is added.${t.needs ? ` It starts switched off until ${esc(t.aiName)} is signed in.` : ''}</span></p>` : ''}
          <div class="bot-edit">${botForm(fields, data.choices, { adding: true, ready })}</div>`
      })
      if (d) this._botNew = d
      if (from !== null) col.el.querySelector('input[name="name"]')?.focus()
    },

    async _addBot(form) {
      if (!form.reportValidity() || this._saving || !this._newFrom) return
      const fields = readBotForm(form)
      if (!fields.ai) return this.actions.toast('Choose which AI runs it', 'err')
      const col = this.cur
      this._saving = true
      try {
        const made = await call('/api/studio/bot', { action: 'add', fields: { ...fields, ...(this._newFrom.from ? { from: this._newFrom.from } : {}) } })
        this._setDirty(col, false)
        this._botNew = null
        this.actions.toast(made.paused ? `${made.name} is added, switched off for now` : `${made.name} is added`)
        this._refreshSoon()
        this._firstRefresh()
        if (this.cols.a.screen === 'bots') { const b = this.cur; this.cur = this.cols.a; this.openBots(); this.cur = b }
        this.cur = col
        col.stack = []
        // Straight to what a new bot needs next: what it is told.
        this.openRules(made.id)
      } catch (err) {
        this.actions.toast(err.message || 'The bot was not added', 'err')
      }
      this._saving = false
    },

    // ── Setup ──────────────────────────────────────────────────────────────────────

    async openSetup({ fresh = false } = {}) {
      if (this.screen !== 'setup') this._openSheet('setup', 'Setup', 'What this studio needs to run, and how each stands', { wide: true })
      this._reopen = () => this.openSetup()
      const seq = ++this._sheetSeq
      const d = await this._fill('setup', seq, () => Promise.all([call(`/api/studio/setup-rows${fresh ? '?fresh=1' : ''}`), call('/api/studio/first-run').catch(() => null)]), ([rows, first]) => {
        this._first = first || this._first
        return setupScreen(rows, first, { open: this._setupOpen }) + this._archivedHtml(first)
      })
      if (d) { this._setup = d[0]; this._ready = null }
    },

    _archivedHtml(first) {
      const gone = first?.archived || []
      return gone.length ? `<section class="setup-group"><h3>Archived projects</h3>${gone.map((p) => `<div class="setup-row"><div class="what"><b>${esc(p.name)}</b><span>Off the map. Its jobs and folder are as you left them.</span></div><span></span><div class="do"><button class="btn" data-act="project-restore" data-id="${esc(p.id)}">Bring it back</button></div></div>`).join('')}</section>` : ''
    },

    /** Draw whichever page shows the setup rows again: Setup itself, or the first run's second step. */
    _redrawSetup(state) {
      if (state) this._setup = state
      this._ready = null
      const col = this._colOf('setup')
      if (col) { this.cur = col; return this.openSetup() }
      if (this._colOf('first')) this._putFirst()
    },

    async _setupDo(action, id, button) {
      if (button) button.disabled = true
      try {
        const out = await call('/api/studio/setup-rows', { action, ...(id ? { id } : {}) })
        if (action === 'start') {
          this.actions.toast(out.opened === false
            ? `No terminal could be opened. Run this yourself: ${out.command}`
            : out.note || 'A terminal opened on this computer. Finish the sign-in there, then check again', out.opened === false ? 'err' : undefined)
          // The sign-in happens in another window: look again when the owner comes back to this one.
          window.addEventListener('focus', () => this._setupDo('check'), { once: true })
        } else if (action === 'forget') this.actions.toast('The key is deleted from this computer')
        else if (action === 'check' && button) this.actions.toast('Checked')
        this._redrawSetup(action === 'check' ? out : out.state)
      } catch (err) {
        if (button) button.disabled = false
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    },

    /** A pasted key: sent once, the field emptied at once, and no answer carries it back. */
    async _saveKey(form) {
      if (!form.reportValidity()) return
      const key = form.elements.key.value
      form.elements.key.value = ''
      try {
        const out = await call('/api/studio/setup-rows', { action: 'key', id: form.dataset.id, key })
        this._setupOpen = ''
        this.actions.toast('The key is saved')
        this._redrawSetup(out.state)
      } catch (err) {
        this.actions.toast(err.message || 'The key was not saved', 'err')
      }
    },

    // ── the helper timetable ───────────────────────────────────────────────────────

    async _loadHelpers() {
      const el = () => this.deck.querySelector('[data-part="helpers"]')
      if (!el()) return
      try {
        const h = await call('/api/studio/helpers')
        if (el()) el().innerHTML = helpersTable(h)
      } catch (err) {
        if (el()) el().innerHTML = `<p class="none">${esc(err.message)}</p>`
      }
    },

    async _helper(action, name, button) {
      const run = async () => {
        if (button) button.disabled = true
        try {
          const h = await call('/api/studio/helpers', { action, ...(name ? { name } : {}) })
          const el = this.deck.querySelector('[data-part="helpers"]')
          if (el) el.innerHTML = helpersTable(h)
          this.actions.toast(action === 'run' ? `${name} started` : name ? `${name} is ${action}` : `The timetable is ${action}`)
          if (action === 'run') setTimeout(() => this._loadHelpers(), 4000)
        } catch (err) {
          if (button) button.disabled = false
          this.actions.toast(err.message || 'That did not work', 'err')
        }
      }
      if (action === 'off' && !name) return this._confirmAsk('<b>Turn the whole helper timetable off?</b> Finished jobs are no longer moved on to their check, and stuck ones are not freed, until you turn it on again.', 'Turn it off', run)
      run()
    },

    // ── the first run ──────────────────────────────────────────────────────────────

    /** Once per visit, when the map says the studio has no crew or no project: is the first run to be shown? */
    async _firstCheck() {
      if (this._firstChecked) return
      this._firstChecked = true
      const first = await call('/api/studio/first-run').catch(() => null)
      if (!first) return
      this._first = first
      if (first.show && this.cols.a.el.hidden) this.openFirst()
    },

    async openFirst(step = null) {
      this._enter('a', () => {
        this._openSheet('first', 'Welcome to Botyard', 'A few steps to a crew at work. Skip any of them: they wait for you in Setup', { wide: true })
        this._reopen = () => this.openFirst()
      })
      const col = this.cols.a
      const seq = ++col.seq
      try {
        this._first = await call('/api/studio/first-run')
      } catch (err) {
        if (col.screen === 'first' && seq === col.seq) col.el.querySelector('.sheet-body').innerHTML = `<p class="none">${esc(err.message)}</p><div class="acts"><button class="btn" data-act="retry">Try again</button></div>`
        return
      }
      if (col.screen !== 'first' || seq !== col.seq) return
      this._firstAt = step || this._first.step
      // The sheet was opened afresh, so its body is drawn even when the step reads as it did before it was closed.
      this._last.first = null
      this._putFirst()
      this._firstNeeds()
    },

    /** What the open step needs from the server besides the steps themselves. */
    async _firstNeeds() {
      const at = this._firstAt
      if (at !== 'phone' && this._pairQr) { this._pairQr = ''; this._pairAt = '' }
      if (['setup', 'chat', 'job'].includes(at) && !this._setup) { this._setup = await call('/api/studio/setup-rows').catch(() => null); this._putFirst() }
      if (at === 'crew' && !this._botNew) { this._botNew = await call('/api/studio/bot/new').catch(() => null); this._putFirst() }
      if (at === 'phone') { this._pair = await call('/api/studio/pair').catch(() => null); this._putFirst() }
      // Waiting on a bot's first answer: look again every few seconds while the step is open.
      clearTimeout(this._firstWatch)
      const waiting = at === 'chat' && !this._first?.chat?.answered && this._first?.chat
      if (waiting) this._firstWatch = setTimeout(() => { if (this._colOf('first') && this._firstAt === 'chat') this._firstRefresh() }, 6000)
    },

    /** Make a pairing code for one more phone: the door opens with it, if it was closed. */
    async _firstPair(form) {
      if (this._adding) return
      this._adding = true
      const button = form.querySelector('button[type="submit"]')
      button.disabled = true
      try {
        const host = form.elements.host?.value || ''
        const paired = await post('/api/studio/pair', { name: form.elements.name.value.trim(), ...(host ? { host } : {}) })
        this._pairQr = qrSvg(paired.link)
        this._pairAt = `${paired.host}:${paired.port}`
        if (!paired.open) this.actions.toast(`The code is made, but the door did not open: ${paired.why || 'see the log'}`, 'err')
        this._pair = await call('/api/studio/pair').catch(() => this._pair)
        this._first = await call('/api/studio/first-run').catch(() => this._first)
        this._last.first = null
        this._putFirst()
      } catch (err) {
        this.actions.toast(err.message || 'No pairing code was made', 'err')
        if (button.isConnected) button.disabled = false
      }
      this._adding = false
    },

    _putFirst({ error = null } = {}) {
      const col = this._colOf('first')
      const first = this._first
      if (!col || !first) return
      const line = first.firstJob ? this.view?.manager.lines.find((l) => l.id === first.firstJob.id) : null
      const body = col.el.querySelector('.sheet-body')
      // A form being filled in is not drawn over by the map's own poll.
      const typing = body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')
      const html = firstScreen(first, this._firstAt, { setup: this._setup, open: this._setupOpen, templates: this._botNew?.templates, line, stage: line ? STAGE[line.stage] : null, pair: this._pair, pairQr: this._pairQr, pairAt: this._pairAt })
      if (this._last.first === html || (typing && !error && this._last.firstAt === this._firstAt)) return
      this._last.first = html
      this._last.firstAt = this._firstAt
      body.innerHTML = html
      if (error) { const form = body.querySelector('[data-part="project-add"]'); if (form) this._projectFormError(form, error) }
    },

    /** Read the steps again after something was made, and move on when the open step is done. */
    async _firstRefresh({ advance = false } = {}) {
      if (!this._first) return
      const first = await call('/api/studio/first-run').catch(() => null)
      if (!first) return
      this._first = first
      if (!this._colOf('first')) return
      if (advance || first.steps.find((s) => s.id === this._firstAt)?.state === 'done' && this._firstAt !== 'job') this._firstAt = first.step
      this._last.first = null
      this._last.firstAt = null
      this._putFirst()
      this._firstNeeds()
    },

    async _firstMark(body, { advance = true } = {}) {
      try {
        this._first = await call('/api/studio/first-run', body)
        if (advance) this._firstAt = this._first.step
        this._last.first = null
        this._last.firstAt = null
        this._putFirst()
        this._firstNeeds()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    },

    async _firstStarter(button) {
      button.disabled = true
      button.textContent = 'Adding the crew…'
      try {
        const out = await call('/api/studio/bot', { action: 'starter' })
        const off = out.added.filter((b) => b.paused)
        this.actions.toast(out.added.length ? `Added ${out.added.map((b) => b.name).join(', ')}${off.length ? `. ${off.map((b) => b.name).join(', ')} stay${off.length === 1 ? 's' : ''} off until signed in` : ''}` : 'The starter crew is already here')
        this._refreshSoon()
        this._firstRefresh({ advance: true })
      } catch (err) {
        button.disabled = false
        button.textContent = 'Add the default crew'
        this.actions.toast(err.message || 'The crew was not added', 'err')
      }
    },

    async _firstJob(form) {
      if (!form.reportValidity() || this._adding) return
      this._adding = true
      const v = (name) => form.elements[name].value.trim()
      try {
        const job = await call('/api/studio/job', { action: 'add', title: v('title'), description: v('description'), ...(v('projectId') ? { projectId: v('projectId') } : {}), ...(v('botId') ? { botId: v('botId') } : {}) })
        this.actions.toast(`Job given${job.ref ? ` (${job.ref})` : ''}`)
        this._refreshSoon()
        await this._firstRefresh()
      } catch (err) {
        this.actions.toast(err.message || 'The job was not given', 'err')
      }
      this._adding = false
    },

    // ── projects ───────────────────────────────────────────────────────────────────

    openProjectNew() {
      const body = this._openSheet('project-new', 'Add a project', 'A folder of code the crew works in')
      this._reopen = () => this.openProjectNew()
      body.innerHTML = `<p class="hint">Each job gets its own branch in the project's folder, so nothing touches your own work until you take it.</p>${projectAddForm()}`
      body.querySelector('input[name="folder"]')?.focus()
    },

    _projectFormError(form, error) {
      form.querySelector('.flag')?.remove()
      if (!error?.canInit) return
      form.querySelector('.acts').insertAdjacentHTML('beforebegin', `<p class="flag warn"><i></i><span>${esc(error.message)}. <button class="link" type="button" data-act="project-init">Start git in that folder and add it</button></span></p>`)
    },

    async _addProject(form, { init = false } = {}) {
      if (this._adding) return
      const from = form.querySelector('input[name="from"]:checked')?.value || 'folder'
      const v = (name) => form.elements[name].value.trim()
      if (!v(from)) { form.elements[from].focus(); return this.actions.toast(from === 'repo' ? 'Give the repository\'s address' : 'Give the folder the project is in', 'err') }
      const button = form.querySelector('button[type="submit"]')
      this._adding = true
      button.disabled = true
      if (from === 'repo') button.textContent = 'Copying the repository…'
      try {
        const made = await post('/api/studio/project', { action: 'add', name: v('name'), ...(from === 'repo' ? { repo: v('repo') } : { folder: v('folder'), init }) })
        this.actions.toast(`${made.name} is added`)
        this._refreshSoon()
        if (this._colOf('first')) await this._firstRefresh({ advance: true })
        else { this._closeCol(this.cols.b); this._last.panel = null }
      } catch (err) {
        this._projectFormError(form, err)
        this.actions.toast(err.message || 'The project was not added', 'err')
      }
      this._adding = false
      if (button.isConnected) { button.disabled = false; button.textContent = 'Add the project' }
    },

    openProjectEdit(name) {
      const p = this.view?.manager.projects.find((x) => x.name === name)
      const page = p && this._projectInfo.get(p.id)?.page
      if (!page) return this.actions.toast('The project is still being read. Try again in a moment')
      const body = this._openSheet('project-edit', `${name}: settings`, 'Its name, its folder, and putting it away', { wide: false })
      this._reopen = () => this.openProjectEdit(name)
      this._projectEdit = { id: p.id, name, page }
      body.innerHTML = projectEditScreen(page)
    },

    async _renameProject(form) {
      const e = this._projectEdit
      if (!e || !form.reportValidity()) return
      const name = form.elements.name.value.trim()
      if (name === e.name) return this.actions.toast('Nothing changed')
      try {
        await call('/api/studio/project', { action: 'rename', id: e.id, name })
        this.actions.toast(`It is called ${name} now`)
        this._projectInfo.delete(e.id)
        this._refreshSoon()
        // The map's own list catches up on its next poll; the pages that name it close.
        this._closeCol(this.cols.b)
      } catch (err) {
        this.actions.toast(err.message || 'The name was not saved', 'err')
      }
    },

    async _moveProject(form, { init = false } = {}) {
      const e = this._projectEdit
      if (!e || !form.reportValidity()) return
      try {
        const out = await post('/api/studio/project', { action: 'move', id: e.id, folder: form.elements.folder.value.trim(), init })
        this.actions.toast(`New jobs branch from ${out.folder}`)
        this._projectInfo.delete(e.id)
        this._back()
      } catch (err) {
        if (err.canInit) this.sheet.querySelector('.sheet-body').innerHTML = projectEditScreen({ ...e.page, folders: [{ folder: form.elements.folder.value.trim(), primary: true }] }, { error: err })
        this.actions.toast(err.message || 'The folder was not changed', 'err')
      }
    },

    _archiveProject(id, archive) {
      const name = this._projectEdit?.id === id ? this._projectEdit.name : this._first?.archived?.find((p) => p.id === id)?.name || 'this project'
      const run = async () => {
        try {
          await call('/api/studio/project', { action: archive ? 'archive' : 'restore', id })
          this.actions.toast(archive ? `${name} is archived. Bring it back from Setup` : `${name} is back`)
          this._projectInfo.delete(id)
          this._refreshSoon()
          if (archive) this._closeCol(this.cols.b)
          else this._redrawSetup()
        } catch (err) {
          this.actions.toast(err.message || 'That did not work', 'err')
        }
      }
      if (!archive) return run()
      this._confirmAsk(`<b>Archive ${esc(name)}?</b> It leaves the map and every list, and the crew is given nothing more from it. Its jobs, history and folder stay. You can bring it back from Setup.`, 'Archive it', run)
    },

    // ── routines: when, and what ───────────────────────────────────────────────────

    async _saveWhen(id) {
      const col = this._colOf('routine')
      const plan = col && readWhen(col.el)
      if (!plan) return this.actions.toast('Choose when it runs first', 'err')
      try {
        const out = await call('/api/studio/routine', { action: 'schedule', id, plan, timezone: zone() })
        this.actions.toast(`It runs ${out.when ? out.when.charAt(0).toLowerCase() + out.when.slice(1) : 'on the new timetable'}`)
        this.cur = col
        this.openRoutine(id)
        if (this.cols.a.screen === 'routines') { this.cur = this.cols.a; this.openRoutines(); this.cur = col }
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    },

    async _saveRoutine(form) {
      const r = this._routinePage
      if (!r || !form.reportValidity()) return
      const now = { title: form.elements.title.value.trim(), description: form.elements.description.value.trim(), botId: form.elements.botId.value, projectId: form.elements.projectId.value }
      const was = { title: r.title, description: r.description, botId: r.botId, projectId: r.projectId || '' }
      const changes = Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== was[k]))
      if (!Object.keys(changes).length) return this.actions.toast('Nothing changed')
      try {
        await call('/api/studio/routine', { action: 'edit', id: r.id, changes })
        this.actions.toast('The routine is saved')
        this.openRoutine(r.id)
        if (this.cols.a.screen === 'routines') { const b = this.cur; this.cur = this.cols.a; this.openRoutines(); this.cur = b }
      } catch (err) {
        this.actions.toast(err.message || 'The routine was not saved', 'err')
      }
    },

    // ── clicks, forms and changes on these screens ─────────────────────────────────

    /** @returns {boolean} whether it was one of these screens' buttons */
    _shapeAct(el) {
      const { act, id } = el.dataset
      const go = (open) => { this._go(open); return true }
      if (act === 'bot-edit') return go(() => this.openBotEdit(id || this._botPage?.id))
      if (act === 'bot-rules') return go(() => this.openRules(id || this._botPage?.id))
      if (act === 'bot-new') { this._beside(() => this.openBotNew(null)); return true }
      if (act === 'bot-new-from') return go(() => this.openBotNew(el.dataset.from))
      if (act === 'bot-edit-undo') { const col = this.cur; this._setDirty(col, false); this.openBotEdit(this._botEdit.id); return true }
      if (act === 'bot-remove') { this._removeBot(); return true }
      if (act === 'var-replace') { const f = this.sheet.querySelector('[data-part="var-add"]'); f.elements.name.value = el.dataset.name; f.elements.value.focus(); return true }
      if (act === 'var-remove') { this._removeVariable(el.dataset.name); return true }
      if (act === 'rules-save') { this._saveRules(); return true }
      if (act === 'rules-undo') { const col = this.cur; this._setDirty(col, false); this.openRules(this._rules.id); return true }
      if (act === 'rules-restore') { this._restoreRules(id); return true }
      if (act === 'rules-diff') { this._diffRules(el.dataset.from, el.dataset.to); return true }
      if (act === 'to-connectors') { this._guard(() => this.openScreen('connectors')); return true }
      if (act === 'to-crew') { this.openScreen('bots'); return true }
      if (act === 'to-routines') { this.openScreen('routines'); return true }
      if (act === 'to-setup') { this.openScreen('setup'); return true }
      if (act === 'setup-key') { this._setupOpen = this._setupOpen === id ? '' : id; this._redrawSetup(); setTimeout(() => this.deck.querySelector('[data-part="setup-key"] input')?.focus(), 0); return true }
      if (act === 'setup-start') { this._setupDo('start', id, el); return true }
      if (act === 'setup-forget') { this._confirmAsk('<b>Forget this key?</b> It is deleted from this computer. Bots that need it stop working until you paste one again.', 'Forget it', () => this._setupDo('forget', id)); return true }
      if (act === 'setup-check') { this._setupDo('check', '', el); return true }
      if (act === 'helper') { this._helper(el.dataset.do, el.dataset.name, el); return true }
      if (act === 'first-open') { if (this._colOf('first')) { this._firstAt = el.dataset.step; this._last.first = null; this._putFirst(); this._firstNeeds() } else this.openFirst(el.dataset.step); return true }
      if (act === 'first-skip') { this._firstMark({ step: el.dataset.step, mark: 'skip' }); return true }
      if (act === 'first-seen') { this._firstMark({ step: el.dataset.step, mark: 'seen' }); return true }
      if (act === 'first-next') { const ids = this._first.steps.map((s) => s.id); this._firstAt = this._first.step || ids[ids.indexOf(this._firstAt) + 1] || ''; this._last.first = null; this._putFirst(); this._firstNeeds(); return true }
      if (act === 'first-close') { this._pairQr = ''; call('/api/studio/first-run', { mark: 'close' }).catch(() => {}); this._closeCol(this.cols.a); return true }
      if (act === 'first-starter') { this._firstStarter(el); return true }
      if (act === 'first-chat') { this.openChat(id); setTimeout(() => this._firstRefresh(), 8000); return true }
      if (act === 'first-pair-hide') { this._pairQr = ''; this._last.first = null; this._putFirst(); return true }
      if (act === 'first-pair-done') { this._pairQr = ''; this._firstRefresh({ advance: true }); return true }
      if (act === 'project-new') { this._beside(() => this.openProjectNew()); return true }
      if (act === 'project-init') { this._addProject(el.closest('form'), { init: true }); return true }
      if (act === 'project-edit') return go(() => this.openProjectEdit(el.dataset.project))
      if (act === 'project-move-init') { this._moveProject(el.closest('form'), { init: true }); return true }
      if (act === 'project-archive') { this._archiveProject(id, true); return true }
      if (act === 'project-restore') { this._archiveProject(id, false); return true }
      if (act === 'routine-when') { this._saveWhen(id); return true }
      return false
    },

    /** @returns {boolean} whether it was one of these screens' forms */
    _shapeSubmit(form) {
      const part = form.dataset.part
      if (part === 'bot-edit') { this._saveBotEdit(form); return true }
      if (part === 'bot-add') { this._addBot(form); return true }
      if (part === 'var-add') { this._setVariable(form); return true }
      if (part === 'setup-key') { this._saveKey(form); return true }
      if (part === 'first-name') { if (form.reportValidity()) this._firstMark({ action: 'name', name: form.elements.name.value.trim() }).then(() => this._refreshSoon()); return true }
      if (part === 'first-job') { this._firstJob(form); return true }
      if (part === 'first-pair') { this._firstPair(form); return true }
      if (part === 'project-add') { this._addProject(form); return true }
      if (part === 'project-rename') { this._renameProject(form); return true }
      if (part === 'project-move') { this._moveProject(form); return true }
      if (part === 'routine-edit') { this._saveRoutine(form); return true }
      return false
    },

    /** A field changed: the parts of a form that follow from another (the AI's models, the ticks, where a project is). @returns {boolean} */
    _shapeChange(target) {
      const form = target.closest('form')
      if (target.name === 'ai' && form) {
        const adding = form.dataset.part === 'bot-add'
        const s = adding ? this._newFrom?.fields : this._botEdit
        const choices = adding ? this._botNew?.choices : this._botEdit?.choices
        if (s && choices) form.querySelector('[data-part="ai-detail"]').innerHTML = aiDetail(s, choices, target.value)
        return false
      }
      if (target.name === 'modelPick' && form) { const other = form.querySelector('.other-model'); other.hidden = target.value !== ''; if (!other.hidden) other.querySelector('input').focus(); return false }
      if (target.name === 'skillsMode' && form) { const list = form.querySelector('[data-part="skill-list"]'); if (list) list.hidden = target.value !== 'list'; return false }
      if (target.name === 'from' && form?.dataset.part === 'project-add') {
        for (const el of form.querySelectorAll('.from-folder')) el.hidden = target.value !== 'folder'
        for (const el of form.querySelectorAll('.from-repo')) el.hidden = target.value !== 'repo'
        return true
      }
      // Typing in a time or a number picks its line.
      const row = target.closest('.when-row')
      if (row && target.type !== 'radio') { row.querySelector('input[type="radio"]').checked = true; return true }
      return false
    },

    /** Anything typed in an editor marks it changed. */
    _shapeInput(col, e) {
      const editor = e.target.closest('[data-part="bot-edit"], [data-part="bot-add"], [data-part="rules-text"]')
      if (!editor) return
      if (e.target.closest('.when-row') == null) this._setDirty(col, true)
      if (editor.dataset.part === 'rules-text') this._countRules(col)
    },
  }
}
