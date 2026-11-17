import './studio.css'
import './plates.css'
import { botStyle, learnColours } from './crew-colours.js'
import { markdown } from './markdown.js'
import { loadOwnPages, mountOwnPage, ownDock, ownName, ownTools } from './own-pages.js'
import { rankProjects } from './rank.js'
import { botScreen, botsScreen, editSummary, improvementsScreen, labelTables, moneyScreen, recordClick, runScreen, runsScreen, toggleRecord } from './studio-crew.js'
import { FeedView, feedFrameHtml } from './run-feed.js'
import { usageHtml } from './usage.js'
import { connectorNewScreen, connectorScreen, connectorsScreen } from './studio-connect.js'
import { changesHtml, docHistory, jobScreen, jobsScreen, madeScreen, projectExtras, projectGoal, projectPlan, routineScreen, routinesScreen, skillScreen, skillsScreen } from './studio-work.js'
import './lightbox.js'
import './shape.css'
import { shapeMethods } from './studio-shape-acts.js'
import { readWhen } from './studio-shape.js'

/**
 * The yard's panels: everything over the map.
 *
 * Plain DOM over the canvas: a manager's panel that
 * says what the crew is doing and what is wrong, a portrait and name under each bot of the crew, a
 * drawer to talk to the one you clicked, and a sheet for the screens that are rooms on the map
 * (every conversation, the settings). Nothing here exists until the server says the studio is on.
 *
 * Every list is rebuilt only when what it shows has changed: the panel sits over a render loop,
 * and a poll that brings the same answer must cost one string comparison, not a layout.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function call(url, payload) {
  let res
  try {
    res = await fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined)
  } catch {
    throw new Error('Botyard\'s own server is not answering. It may be restarting: try again in a moment')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

/** A file's own bytes to the server, which answers in JSON. */
async function upload(url, file) {
  let res
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
  } catch {
    throw new Error('Botyard\'s own server is not answering. It may be restarting: try again in a moment')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

/** A small picture of a chosen file for the tray, or '' when it is not a picture the browser can draw. */
async function thumbOf(file, side = 128) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, side / Math.min(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

/** This computer's date and time, for a pasted screenshot's name. */
function localStamp(d = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

/** A message's pictures, small; a click opens one large. */
const pictureStrip = (pictures = []) => (pictures.length
  ? `<div class="pics" data-gallery>${pictures.map((p) => `<a class="view-img" href="${fileUrl(p.id)}" target="_blank" rel="noopener" title="${esc(p.name)}" data-name="${esc(p.name)}"><img src="${fileUrl(p.id)}" alt="${esc(p.name)}" loading="lazy"></a>`).join('')}</div>`
  : '')

export const fetchStudio = () => call('/api/studio')

function since(at, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const BOT_STATE = { running: 'Working', idle: 'Free', paused: 'Paused', error: 'Stopped on an error' }
const STEP_NAMES = ['Build', 'Check', 'Ruling', 'Merge', 'Push']
/** Where a job stands, in a word, and its colour: the row says it instead of five unlabelled dots. */
const STAGE = {
  queued: ['Waiting', 'wait'], build: ['Building', 'go'], fix: ['Fixing', 'go'], check: ['Checking', 'look'],
  ruling: ['Ruling', 'look'], blocked: ['Blocked', 'bad'], failed: ['Failed', 'bad'], merge: ['To merge', 'ok'],
  push: ['To push', 'ok'], done: ['Done', 'ok'], stopped: ['Stopped', 'bad'], replaced: ['Replaced', 'wait'],
  passed: ['Passed', 'ok'], built: ['Built', 'ok'], merged: ['Merged', 'ok'], pushed: ['Pushed', 'ok'], kept: ['Kept here', 'ok'],
}
const CHAT_MS = 4000
const SHOWN_LINES = 12
const SHOWN_FEED = 10
/** How often the owner's own asks (approvals, questions) are read again: they are heavier than the map's poll. */
const NEEDS_EVERY_MS = 60_000
/** Work that can still be called off. Past its check it is merged or waiting to be, not cleared. */
const CLEARABLE = new Set(['build', 'check', 'ruling', 'fix', 'blocked', 'queued'])
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'

/** The dock: what each button opens. Chats and settings are the same screens their rooms open. */
const DOCK = [
  { id: 'attention', name: 'Needs you', icon: 'bell', group: 'now', key: '1' },
  { id: 'work', name: 'Work', icon: 'work', group: 'now', key: '2' },
  { id: 'projects', name: 'Projects', icon: 'rooms', group: 'now', key: '3' },
  { id: 'bots', name: 'Crew', icon: 'bots', screen: true, group: 'crew', title: 'The crew: who runs on what, and how their runs go', key: '4' },
  { id: 'chats', name: 'Chats', icon: 'chat', screen: true, group: 'crew', key: '5' },
  { id: 'runs', name: 'Runs', icon: 'runs', screen: true, group: 'crew', key: '6' },
  { id: 'improvements', name: 'Improve', icon: 'rise', screen: true, group: 'crew', title: 'Improvements: what the audits found worth improving, and who is on it' },
  { id: 'library', name: 'Library', icon: 'book', screen: true, group: 'make', title: 'What the crew made, and its skills', key: '7' },
  { id: 'routines', name: 'Routines', icon: 'clock', screen: true, group: 'make', title: 'Routines and helpers', key: '8' },
  { id: 'setup', name: 'Setup', icon: 'wrench', screen: true, group: 'setup', title: 'What this studio needs: AI sign-ins, keys, git' },
  { id: 'models', name: 'Models', icon: 'gauge', screen: true, group: 'setup', title: 'Models, limits and money' },
  { id: 'connectors', name: 'Connectors', icon: 'plug', screen: true, group: 'setup', title: 'Services the crew may use, and its sign-ins' },
  { id: 'settings', name: 'Settings', icon: 'dials', screen: true, group: 'setup' },
]
/** What a job row says under its title: who is on it, by first name, and only once. */
const noteOf = (l) => {
  const first = (name) => String(name || '').split(' ')[0]
  const who = first(l.bot)
  // The bot's whole name in the note is said by its first name, like everywhere else in the row.
  const said = l.bot ? String(l.note || l.stage || '').split(l.bot).join(who) : String(l.note || l.stage || '')
  return who && !said.startsWith(who) ? `${who}: ${said}` : said
}

/** The engine's own phrases, said the way the owner says things. */
const PLAIN = [
  [/Agent is in error status and needs operator action or dismissal\.?/i, 'It stopped on an error.'],
  [/Run failed after automatic retries were exhausted\.?/i, 'Its run failed, and the automatic retries are used up.'],
  [/needs operator action/i, 'needs you'],
  [/\btimed_out\b/g, 'timed out'],
]
const plainWords = (text) => PLAIN.reduce((t, [from, to]) => t.replace(from, to), String(text || ''))
/** What a page shows while it is read: its shape in grey, so the column does not sit empty. */
const SKELETON = `<div class="skeleton" aria-label="Reading" role="status">${'<i></i>'.repeat(3)}<b></b>${'<i></i>'.repeat(5)}<b></b>${'<i></i>'.repeat(4)}</div>`
/** What a row in the list column is, so the row whose page is open beside it can be marked. */
const PICKABLE = '[data-line],[data-project],[data-id],[data-routine],[data-bot],[data-shelf]'
const pickKey = (el) => el?.dataset.line || el?.dataset.project || el?.dataset.id || el?.dataset.routine || el?.dataset.bot || ''
const COL = (key) => `<section class="deck-col studio-sheet col-${key}" data-col="${key}" hidden aria-labelledby="deck-${key}-title">
  <header class="col-head">
    <button class="btn icon ghost back" data-act="back" title="Back" hidden>${ICONS.back}</button>
    <div><strong id="deck-${key}-title"></strong><p></p></div>
    <button class="btn icon ghost" data-act="close-col" title="Close (Esc)">${CLOSE_ICON}</button>
  </header>
  <div class="sheet-body studio-body"></div>
  <footer class="sheet-confirm" hidden role="alertdialog" aria-live="assertive">
    <p></p>
    <button class="btn ghost" data-act="confirm-no">Keep it as it is</button>
    <button class="btn primary" data-act="confirm-yes"></button>
  </footer>
</section>`
/** What a chat message may carry: plain pictures, as many and as large as the server takes. */
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MOST_PICTURES = 6
const PICTURE_BYTES = 10 * 1024 * 1024
const fileUrl = (id) => `/api/studio/file?id=${encodeURIComponent(id)}`
const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const ICONS = {
  page: svg('<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 16h5"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  work: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  rooms: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 20 7.5M12 12 4 7.5M12 12v9"/>'),
  chat: svg('<path d="M5 5h14v10H10l-5 4z"/>'),
  picture: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>'),
  dials: svg('<path d="M5 7h8M17 7h2M5 17h2M11 17h8"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  book: svg('<path d="M5 4.5h5a2 2 0 0 1 2 2V20a1.5 1.5 0 0 0-1.5-1.5H5z"/><path d="M19 4.5h-5a2 2 0 0 0-2 2V20a1.5 1.5 0 0 1 1.5-1.5H19z"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
  home: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  look: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
  back: svg('<path d="m14 6-6 6 6 6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  bots: svg('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>'),
  runs: svg('<path d="M4 18h3l3-11 4 13 3-8h3"/>'),
  shift: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none"/>'),
  plug: svg('<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>'),
  gauge: svg('<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1.2"/>'),
  coin: svg('<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.8-1.5-1.3-2.8-1.3-1.7 0-2.8.9-2.8 2.1 0 2.8 5.8 1.6 5.8 4.3 0 1.2-1.2 2.1-3 2.1-1.4 0-2.5-.6-3-1.5M12 6.5v1.4M12 16.4v1.1"/>'),
  save: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'),
  rise: svg('<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5M5 4.5h14"/>'),
  wrench: svg('<path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L4 17l3 3 5.3-5.3a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
}

/**
 * The answers a question form holds: the options picked, and what the owner typed in Other (the owner,
 * 12 November 2026: "add other box option in the answers incase i want to give another answer"). A
 * typed answer to a one-choice question replaces the choice. Null when a required question has neither.
 */
export function answersFrom(form, items) {
  const picked = new FormData(form)
  const answers = items.map((item) => {
    const otherText = String(picked.get(`${item.id}::other`) || '').trim()
    const optionIds = picked.getAll(item.id).map(String)
    return { questionId: item.id, optionIds: otherText && !item.multiple ? [] : optionIds, ...(otherText ? { otherText } : {}) }
  })
  return items.some((item, i) => item.required && !answers[i].optionIds.length && !answers[i].otherText) ? null : answers
}

const hueOf = (name) => [...name].reduce((hue, c) => (hue * 31 + c.charCodeAt(0)) % 360, 0)

const HELP = `
  <h2>Keys and help</h2>
  <p class="sub">The map is your yard: a bay for each project, the crew standing where their work is, and free bots waiting in the Depot. The sign over a bay says how much of its work is being built, checked and waiting; click the sign to open the project. The rail on the left opens a list, and what you pick in it opens beside the list. Click a bot, in the yard or in the roster along the bottom, to talk to it.</p>
  <div class="cols">
    <div>
      <div class="k"><span>Open a rail page</span><kbd>1</kbd> to <kbd>9</kbd></div>
      <div class="k"><span>Close the page on the right</span><kbd>Esc</kbd></div>
      <div class="k"><span>Round the page</span><kbd>Tab</kbd></div>
      <div class="k"><span>Open the row in focus</span><kbd>Enter</kbd></div>
      <div class="k"><span>See the whole yard</span><kbd>0</kbd></div>
      <div class="k"><span>This sheet</span><kbd>?</kbd></div>
    </div>
    <div>
      <div class="k"><span>Move the yard</span><kbd>drag</kbd></div>
      <div class="k"><span>Tilt and turn</span><kbd>right-drag</kbd></div>
      <div class="k"><span>Zoom</span><kbd>scroll</kbd></div>
      <div class="k"><span>Hide everything but the map</span><kbd>H</kbd></div>
      <div class="k"><span>Day or night, picture quality</span><kbd>S</kbd></div>
      <div class="k"><span>Take a picture</span><kbd>P</kbd></div>
    </div>
  </div>
  <p class="sub">Yellow and black stripes mean one thing: something waits for your own answer. Green is being built, blue is being checked, grey waits its turn, red has stopped; the word is always written on it.</p>
  <div class="acts"><button class="btn primary" data-part="help-close">Close</button></div>`

const TEMPLATE = `
<header class="studio-top panel">
  <strong class="mark">Botyard</strong>
  <p class="studio-state"></p>
  <button class="btn primary new-job" data-act="new-job">${ICONS.plus}<span>New job</span></button>
  <button type="button" class="usage-btn" data-act="usage" aria-expanded="false" aria-controls="usage-pop" title="Usage of each AI, and what is left">${ICONS.gauge}<span class="meters" data-part="meters"></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
  <button class="btn icon ghost" data-act="shift" title="Day plates or night plates">${ICONS.shift}</button>
  <button class="btn icon ghost" data-act="home" title="See the whole studio (0)">${ICONS.home}</button>
  <button class="btn icon ghost" data-act="look" title="Map settings">${ICONS.look}</button>
  <button class="btn icon ghost" data-act="help" title="Keys and help (?)">${ICONS.help}</button>
</header>
<div class="usage-pop panel" id="usage-pop" role="dialog" aria-label="Usage of each AI" hidden></div>
<nav class="studio-dock panel" aria-label="Studio"></nav>
<div class="studio-deck">${COL('a')}${COL('b')}</div>
<footer class="studio-crew panel" aria-label="The crew"></footer>
<div class="studio-tags" aria-hidden="true"></div>
<aside class="studio-chat panel" hidden>
  <header>
    <span class="portrait"></span>
    <i class="light"></i>
    <div class="who"><strong></strong><span></span></div>
    <button class="btn ghost" data-act="bot-page" title="Engine, runs, cost and instructions">Page</button>
    <button class="btn ghost" data-act="pause"></button>
    <button class="btn icon ghost" data-act="close" title="Close (Esc)">${CLOSE_ICON}</button>
  </header>
  <p class="doing"></p>
  <div class="talk" tabindex="0"></div>
  <form>
    <div class="tray" hidden aria-label="Pictures to send"></div>
    <button class="btn icon ghost attach" type="button" data-act="add-picture" title="Add a picture (or paste one)" aria-label="Add a picture">${ICONS.picture}</button>
    <input type="file" accept="${PICTURE_TYPES.join(',')}" multiple hidden>
    <textarea rows="2" maxlength="4000" placeholder="Write to this bot"></textarea>
    <button class="btn primary" type="submit">Send</button>
  </form>
</aside>`

export class Studio {
  /**
   * @param {HTMLElement} root the HUD layer
   * @param {{ pickBot: (botId: string) => void, closed: () => void, refresh: () => void, toast: (text: string, kind?: string) => void }} actions
   */
  constructor(root, actions) {
    this.root = root
    this.actions = actions
    this.on = false
    this.view = null
    this.chatBot = null
    this._last = {}
    this._tags = new Map()
    this._chatTimer = 0
    this._chatSeq = 0
    /** The job whose "clear it?" question is showing, and the ones cleared but not yet gone from a poll. */
    this._clearing = null
    this._cleared = new Set()
    /**
     * The two columns beside the dock. A holds the list the dock opened (or a screen); B holds the page
     * of what was picked in A, with its own way back. Each keeps which screen it shows, its way back,
     * how to open it again, and a count that tells a late answer from the one on screen.
     */
    const col = (key) => ({ key, el: null, screen: null, stack: [], reopen: null, seq: 0 })
    this.cols = { a: col('a'), b: col('b') }
    this.cur = this.cols.a
    this._runs = { view: 'runs', filter: { bot: '', status: '' }, page: 0 }
    /** The Jobs screen's filter and page; each project page's extras, by project id, with when they were read. */
    this._jobs = { filter: { pile: 'active', project: '', bot: '', q: '' }, page: 0 }
    this._projectInfo = new Map()
    /** What the left panel shows: 'attention', 'work', 'projects', a project's name after 'project:', or nothing. */
    this.tab = null
  }

  // The screen code reads and writes "the sheet": the column it is working in now.
  get sheet() { return this.cur.el }
  get panel() { return this.cols.a.el }
  get screen() { return this.cur.screen }
  set screen(v) { this.cur.screen = v }
  get _stack() { return this.cur.stack }
  set _stack(v) { this.cur.stack = v }
  get _reopen() { return this.cur.reopen }
  set _reopen(v) { this.cur.reopen = v }
  get _sheetSeq() { return this.cur.seq }
  set _sheetSeq(v) { this.cur.seq = v }

  /** The column showing this screen now, the page column first. */
  _colOf(screen) {
    return [this.cols.b, this.cols.a].find((c) => c.screen === screen && !c.el.hidden) || null
  }

  /** Put the studio's panels on the page. Called once, when the server first says it is on. */
  /** Day or night: the map's own setting, so the plates and the yard can never disagree. */
  _plates() {
    return this.actions.shiftNow?.() === 'night' ? 'night' : 'day'
  }

  /** Switch between the two, or set one. */
  _shift(to = this.root.dataset.plates === 'night' ? 'day' : 'night', { asked = true } = {}) {
    this.root.dataset.plates = to
    // The yard follows: night plates over a sunlit yard would read as two products.
    if (asked) this.actions.platesShift?.(to)
  }

  mount() {
    if (this.on) return
    this.on = true
    this.root.classList.add('studio')
    this._shift(this._plates(), { asked: false })
    this.root.insertAdjacentHTML('beforeend', TEMPLATE)
    // The help sheet's frame is the map layer's; its words are written here.
    const help = this.root.querySelector('.help .sheet')
    if (help) {
      help.innerHTML = HELP
      help.querySelector('[data-part="help-close"]').addEventListener('click', () => this.actions.help?.())
    }
    // The map's own camera keys come last for the keyboard: the page's controls first.
    const camera = this.root.querySelector('.rail')
    if (camera) this.root.append(camera)
    this.deck = this.root.querySelector('.studio-deck')
    this.cols.a.el = this.deck.querySelector('.col-a')
    this.cols.b.el = this.deck.querySelector('.col-b')
    this.tagLayer = this.root.querySelector('.studio-tags')
    // Under every panel: a name belongs to the floor, and must not be drawn across a list.
    this.root.prepend(this.tagLayer)
    this._boards = new Map()
    this.tagLayer.addEventListener('click', (e) => {
      const next = e.target.closest('[data-yard-next]')
      if (next) return this._first?.left?.length ? this.openFirst(this._first.left[0]) : this.openProjectNew()
      const job = e.target.closest('[data-bay-job]')?.dataset.bayJob
      if (job) return this._beside(() => this.openNewJob(job))
      const you = e.target.closest('[data-bay-you]')
      if (you) return this.show('attention')
      const bay = e.target.closest('[data-bay]')?.dataset.bay
      if (!bay) return
      if (bay === this.view?.depot) return this._dockOpen(DOCK.find((d) => d.id === 'bots'))
      this.openProject(bay, { fly: true })
    })
    this.chat = this.root.querySelector('.studio-chat')
    this.talk = this.chat.querySelector('.talk')
    this.input = this.chat.querySelector('textarea')
    this.top = this.root.querySelector('.studio-top')
    this.dock = this.root.querySelector('.studio-dock')
    this.crewBar = this.root.querySelector('.studio-crew')
    this.top.addEventListener('click', (e) => {
      const step = e.target.closest('[data-first-step]')?.dataset.firstStep
      if (step) return this.openFirst(step)
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'new-job') return this._beside(() => this.openNewJob())
      if (act === 'shift') return this._shift()
      if (act === 'usage') return this.usageOpen ? this.closeUsage() : this.openUsage()
      if (act) this.actions[act]?.()
    })
    // A click anywhere else closes the usage list.
    document.addEventListener('pointerdown', (e) => { if (this.usageOpen && !e.target.closest('.usage-pop, .usage-btn')) this.closeUsage() })
    this.root.querySelector('.usage-pop').addEventListener('click', (e) => { if (e.target.closest('[data-act="usage-more"]')) { this.closeUsage(); this._enter('a', () => this.openMoney()) } })
    window.addEventListener('resize', () => this.usageOpen && this._placeUsage())
    this.dock.addEventListener('click', (e) => this._dockOpen(this._dockItems().find((d) => d.id === e.target.closest('[data-tab]')?.dataset.tab)))
    this.crewBar.addEventListener('click', (e) => {
      const bot = e.target.closest('[data-bot]')?.dataset.bot
      if (bot) this.actions.pickBot(bot)
    })
    this._mountDeck()
  }

  /** The rail: the map's own entries, then the owner's own pages (server/lib/own-pages.mjs). */
  _dockItems() {
    return this._ownDock?.length ? [...DOCK, ...this._ownDock] : DOCK
  }

  /** A dock item by its number key. */
  dockKey(key) {
    this._dockOpen(DOCK.find((d) => d.key === key))
  }

  /** A column is leaving one of the owner's pages: the page tidies up what it started. */
  _leaveOwnPage(col) {
    if (!ownName(col.screen) || !this._ownTidy) return
    const tidy = this._ownTidy
    this._ownTidy = null
    try { tidy() } catch { /* the page's own trouble */ }
  }

  /** One of the owner's own pages, on the sheet. Its script draws it; the sheet is the map's. */
  openOwnPage(name) {
    const page = (this._ownPages || []).find((p) => p.name === name)
    if (!page) return
    const id = `own:${name}`
    const body = this._openSheet(id, page.title, page.does || '', { wide: page.wide })
    this._reopen = () => this.openOwnPage(name)
    const col = this.cur
    const seq = ++this._sheetSeq
    mountOwnPage(page, body, ownTools(page, { markdown, toast: (text) => this.actions.toast(text) })).then((tidy) => {
      // The sheet moved on while the script loaded: the page is tidied up at once.
      if (col.screen !== id || seq !== col.seq) return tidy()
      this._ownTidy = tidy
    })
  }

  _dockOpen(item) {
    {
      if (!item) return
      // The dock toggles: its own item again closes the column.
      const here = item.screen ? this.cols.a.screen === item.id : this.tab === item.id
      if (this._unsaved()) return this._guard(() => this._dockOpen(item))
      if (here && !this.cols.a.el.hidden) return this._closeCol(this.cols.a)
      // Where a conversation takes the page's place, a list opened from the rail takes it back.
      if (this.chatBot && window.innerWidth <= 900) this.closeChat()
      if (item.screen) this._enter('a', () => this._screen(item.id))
      else this.show(item.id)
    }
  }

  _mountDeck() {
    // The owner's own pages, if this yard has any: they join the rail once the server has listed them.
    loadOwnPages().then((pages) => {
      this._ownPages = pages
      this._ownDock = ownDock(pages)
      if (pages.length && this.view) this._putDock()
    })

    for (const col of [this.cols.a, this.cols.b]) {
      // Every table a sheet shows, however late it comes, gets its column names on its cells (labelTables).
      let labelling = 0
      new MutationObserver(() => { if (!labelling) labelling = requestAnimationFrame(() => { labelling = 0; labelTables(col.el) }) }).observe(col.el, { childList: true, subtree: true })
      col.el.addEventListener('click', (e) => this._colClick(col, e))
      col.el.addEventListener('submit', (e) => { this.cur = col; this._sheetSubmit(e) })
      col.el.addEventListener('change', (e) => { this.cur = col; this._sheetChange(e) })
      col.el.addEventListener('input', (e) => {
        if (!e.target.closest('[data-part="connector-find"]')) return
        clearTimeout(this._findTimer)
        const q = e.target.value
        this._findTimer = setTimeout(() => { this.cur = col; this.openConnectors({ q }) }, 180)
      })
      col.el.addEventListener('input', (e) => this._shapeInput(col, e))
      col.el.addEventListener('keydown', (e) => { this.cur = col; this._sheetKey(e) })
    }
    window.addEventListener('resize', () => this._layout())
    this._mountChat()
  }

  /**
   * A click in a column. In A's list a click opens its page in B, beside the list, and marks the row;
   * in a screen it does what the screen says, and anything it opens goes one column to the right.
   */
  _colClick(col, e) {
    const { a: A, b: B } = this.cols
    const head = e.target.closest('.col-head [data-act]')
    if (head) {
      this.cur = col
      if (head.dataset.act === 'back') return this._guard(() => { this.cur = col; col.stack.length ? this._back() : this._closeCol(col) })
      if (head.dataset.act === 'close-col') return this._guard(() => this._closeCol(col))
      return
    }
    const panelMode = col === A && this.tab && !A.screen
    const row = col === A ? e.target.closest(PICKABLE) : null
    const was = { screen: B.screen, seq: B.seq, hidden: B.el.hidden }
    if (col === A && B.dirty && !B.el.hidden && !e.target.closest('.sheet-confirm')) return this._guard(() => this._colClick(col, e))
    if (panelMode) { this.cur = B; this._freshB = true; this._panelClick(e) } else { this.cur = col; this._sheetClick(e) }
    this._freshB = false
    const opened = B.seq !== was.seq || B.screen !== was.screen || B.el.hidden !== was.hidden
    if (panelMode && !opened) this.cur = A
    if (row && opened && !B.el.hidden) this._pick(pickKey(row))
  }

  _panelClick(e) {
    {
      const el = e.target.closest('[data-clear],[data-act],[data-project],[data-bot],[data-job],[data-line],[data-routine]')
      if (!el) return
      if (el.dataset.act === 'card') {
        const card = this._cards?.[Number(el.dataset.card)]
        const flag = (v) => (v === undefined ? undefined : v === 'true')
        return card && this._markCards([card], { read: flag(el.dataset.read), archived: flag(el.dataset.archived) })
      }
      if (el.dataset.act === 'cards-read') return this._markCards((this._cards || []).filter((c) => !c.read && !c.archived), { read: true })
      // Opening a card reads it.
      const opened = this._cards?.[Number(el.closest('.ask[data-card]')?.dataset.card)]
      // A question card opens the chat on that question, not at the end of the conversation.
      if (opened?.kind === 'question' && el.dataset.bot) this._focusCard = opened.asks?.[0]?.id || opened.items?.[0]?.id || 'any'
      if (opened && !opened.read && (el.dataset.line || el.dataset.bot)) this._markCards([opened], { read: true })
      if (el.dataset.routine) return this.openRoutine(el.dataset.routine)
      if (el.dataset.act === 'open-bot') return this.openBot(el.dataset.id)
      if (el.dataset.act === 'all-jobs') return this.openJobs()
      if (el.dataset.act === 'project-new') return this.openProjectNew()
      if (el.dataset.act === 'project-jobs') return this.openJobs({ project: el.dataset.id, pile: '' })
      if (el.dataset.clear) return this._askClear(el.dataset.clear, el.dataset.answer)
      if (el.dataset.act === 'approve' || el.dataset.act === 'reject') return this._decide(el.dataset.id, el.dataset.act)
      if (el.dataset.act === 'close-panel') return this.show(null)
      if (el.dataset.act === 'projects') return this.show('projects')
      if (el.dataset.act === 'fly') return this.actions.focusProject(el.dataset.project)
      if (el.dataset.act === 'shelve') return this.shelve(el.dataset.project)
      if (el.dataset.act === 'rank') return this.rank(el.dataset.project, Number(el.dataset.by))
      if (el.dataset.project) return this.openProject(el.dataset.project, { fly: true })
      if (el.dataset.line) return this.openJob(el.dataset.line)
      if (el.dataset.bot) this.actions.pickBot(el.dataset.bot)
    }
  }

  _mountChat() {
    this.chat.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'close') return this.closeChat()
      if (act === 'pause') this.pause()
      if (act === 'bot-page' && this.chatBot) { const id = this.chatBot; this._beside(() => this.openBot(id)) }
      if (act === 'open-job') { const id = e.target.closest('[data-id]').dataset.id; this._beside(() => this.openJob(id)) }
      if (act === 'to-card') { this._focusCard = e.target.closest('[data-id]').dataset.id; return this._showFocusCard() }
      const verb = e.target.closest('[data-verb]')
      if (verb) this._answerCard(verb.closest('[data-card]').dataset.card, verb.dataset.verb)
    })
    this.talk.addEventListener('submit', (e) => {
      e.preventDefault()
      const form = e.target.closest('form[data-card]')
      const card = this._chatCards?.get(form?.dataset.card)
      if (!card) return
      const answers = answersFrom(form, card.question.items)
      if (!answers) return this.actions.toast('Pick an answer or write one first', 'err')
      this._answerCard(card.id, 'respond', answers)
    })
    this.chat.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.send() })
    // Pictures for the next message: the button, a paste (a screenshot copied a moment ago), or a drop.
    this._pictures = []
    this.tray = this.chat.querySelector('.tray')
    this.picker = this.chat.querySelector('input[type="file"]')
    this.chat.querySelector('[data-act="add-picture"]').addEventListener('click', () => this.picker.click())
    this.picker.addEventListener('change', () => { this._addPictures([...this.picker.files]); this.picker.value = '' })
    this.tray.addEventListener('click', (e) => {
      const drop = e.target.closest('[data-drop]')
      if (!drop) return
      this._pictures.splice(Number(drop.dataset.drop), 1)
      this._showTray()
      this.input.focus()
    })
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])]
      if (!files.length) return
      e.preventDefault()
      this._addPictures(files)
    })
    this.chat.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return
      e.preventDefault()
      this.chat.classList.add('dropping')
    })
    this.chat.addEventListener('dragleave', (e) => { if (!this.chat.contains(e.relatedTarget)) this.chat.classList.remove('dropping') })
    this.chat.addEventListener('drop', (e) => {
      this.chat.classList.remove('dropping')
      const files = [...(e.dataTransfer?.files || [])]
      if (!files.length) return
      e.preventDefault()
      this._addPictures(files)
    })
    this.input.addEventListener('keydown', (e) => {
      // The map's own keys (R, A, H…) must not fire while a message is being written.
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send() }
      if (e.key === 'Escape') { e.preventDefault(); this.closeChat() }
    })
  }

  _sheetClick(e) {
    {
      const clear = e.target.closest('[data-clear]')
      if (clear) return this._askClear(clear.dataset.clear, clear.dataset.answer)
      const el = e.target.closest('[data-act],[data-bot],[data-verb],[data-line],[data-routine]')
      if (!el) return void recordClick(e.target)
      if (el.dataset.routine && !el.dataset.act) return this._go(() => this.openRoutine(el.dataset.routine))
      if (this._crewAct(el) || this._workAct(el) || this._connectAct(el) || this._shapeAct(el)) return
      if (el.dataset.act === 'close-sheet') return this.closeSheet()
      if (el.dataset.act === 'pause') return this.pause(el.dataset.bot)
      if (el.dataset.act === 'shelve') return this.shelve(el.dataset.project)
      if (el.dataset.act === 'rank') return this.rank(el.dataset.project, Number(el.dataset.by))
      if (el.dataset.act === 'routine') return this._routine(el.dataset.id, el.dataset.do)
      if (el.dataset.act === 'job') return this._jobAct(el.dataset.do)
      if (el.dataset.verb) return this._answerJobCard(el.closest('[data-card]').dataset.card, el.dataset.verb)
      if (el.dataset.act === 'device') return this._revoke(el.dataset.id, el.dataset.name)
      if (el.dataset.act === 'invite-add') return this._invite()
      if (el.dataset.act === 'invite-revoke') return this._takeBackInvite(el.dataset.id)
      if (el.dataset.act === 'goal-edit') return this._goalEdit(true)
      if (el.dataset.act === 'goal-cancel') return this._goalEdit(false)
      if (el.dataset.act === 'project-jobs') return this._go(() => this.openJobs({ project: el.dataset.id, pile: '' }))
      if (el.dataset.act === 'fly') return this.actions.focusProject(el.dataset.project)
      if (el.dataset.act === 'open-plan') return this._go(() => this.openJob(el.dataset.id))
      if (el.dataset.line) return this._go(() => this.openJob(el.dataset.line))
      if (el.dataset.bot) this.actions.pickBot(el.dataset.bot)
    }
  }

  _sheetSubmit(e) {
    {
      e.preventDefault()
      const part = e.target.dataset.part
      if (this._shapeSubmit(e.target)) return
      if (part === 'jobs-filter') { this._jobs.filter.q = e.target.elements.q.value.trim(); this._jobs.page = 0; return this._loadJobs(true) }
      if (part === 'job-edit') return this._saveJob(e.target)
      if (part === 'routine-add') return this._addRoutine(e.target)
      if (part === 'goal') return this._saveGoal(e.target)
      if (part === 'connector-find') return this.openConnectors({ q: e.target.elements.q.value })
      if (part === 'connector-add') return this._connectorAdd({ from: e.target.dataset.from || '', ...Object.fromEntries(new FormData(e.target)) })
      const asked = e.target.closest('form[data-card]')
      if (this.screen === 'job' && asked) return this._answerJobCard(asked.dataset.card, 'respond', asked)
      if (this.screen === 'newjob') this._addJob()
      else if (this.screen === 'job') this._comment()
      else this._saveSettings()
    }
  }

  _sheetChange(e) {
    {
      if (e.target.dataset.part === 'attach') return this._attach(e.target)
      if (this._shapeChange(e.target)) return
      if (e.target.closest('[data-part="bot-edit"], [data-part="bot-add"], .when')) return
      if (['connector-level', 'connector-write', 'connector-owner'].includes(e.target.dataset.part)) return this._connectorAccess()
      if (e.target.dataset.part === 'skill-file' && this._skill) return this.openSkill(this._skill.id, e.target.value)
      const pick = e.target.dataset.jobs
      if (pick) { this._jobs.filter[pick] = e.target.value; this._jobs.page = 0; return this._loadJobs() }
      const filter = e.target.closest('[data-filter]')?.dataset.filter
      if (!filter) return
      this._runs.filter[filter] = e.target.value
      this._runs.page = 0
      this._loadRuns()
    }
  }

  _sheetKey(e) {
    {
      // A table row that opens something opens on Enter too.
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-act]')) { e.preventDefault(); this._crewAct(e.target) || this._workAct(e.target) || this._connectAct(e.target) || this._shapeAct(e.target); return }
      // Typing a number must not fire the map's own keys.
      if (e.target.closest('input,textarea,select')) e.stopPropagation()
      if (e.key === 'Escape' && !this.sheet.querySelector('.sheet-confirm').hidden) { e.stopPropagation(); this._confirmAsk(null); return }
      if (e.key === 'Escape') { e.stopPropagation(); this._guard(() => this.closeSheet() || this.closePanel()) }
      // Save from the keyboard, in an editor.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && (this.screen === 'bot-rules' || this.screen === 'bot-edit')) { e.preventDefault(); this.screen === 'bot-rules' ? this._saveRules() : this.sheet.querySelector('[data-part="bot-edit"]')?.requestSubmit() }
    }
  }

  /** Open column A on one of the dock's lists, or close it with nothing. The map is the page; the columns are a visit. */
  show(tab) {
    const A = this.cols.a
    if (!tab) return void this._closeCol(A)
    if (tab.startsWith('project:')) return this.openProject(tab.slice('project:'.length))
    this._closeCol(this.cols.b)
    const fresh = A.el.hidden
    Object.assign(A, { screen: null, stack: [], reopen: null })
    this.tab = tab
    this.cur = A
    A.el.hidden = false
    A.el.classList.remove('wide')
    const body = A.el.querySelector('.sheet-body')
    body.classList.add('studio-body')
    this.root.classList.add('studio-open')
    this._confirmAsk(null)
    this._syncBack(A)
    this._animate(A, fresh)
    this._layout()
    if (!this.view) return
    this._last.panel = null
    this._putPanel()
    this._putDock()
    body.scrollTop = 0
    if (tab === 'attention') this._loadNeeds()
  }

  // ── the two columns ──────────────────────────────────────────────────────────────

  /**
   * Open something fresh in a column: A from the dock, a room or the top bar (B closes with it); B for the
   * page of what was picked in A. Its way back starts empty.
   */
  _enter(key, open) {
    const col = this.cols[key]
    if (key === 'a') { this._closeCol(this.cols.b); this.tab = null }
    this.cur = col
    Object.assign(col, { screen: null, stack: [] })
    this._navigating = false
    open()
    this._layout()
  }

  /** Open beside what is open: in B when A shows something, else in A. */
  _beside(open) {
    this._enter(this.cols.a.el.hidden ? 'a' : 'b', open)
  }

  /** Close a column. Closing A closes B too: a page beside nothing is lost. */
  _closeCol(col) {
    const { a: A, b: B } = this.cols
    if (col === A) this._closeCol(B)
    if (col.el.hidden) return
    this._leaveOwnPage(col)
    Object.assign(col, { screen: null, stack: [], reopen: null })
    col.el.hidden = true
    col.el.querySelector('.sheet-confirm').hidden = true
    if (col === A) { this.tab = null; this.root.classList.remove('studio-open') }
    if (col === B) { this._picked = ''; this._applyPick() }
    if (this.cur === col) this.cur = A
    if (this.view) this._putDock()
    this._layout()
  }

  /** How the columns stand: one or two, a list or a screen in A, and whether B must cover A for room. */
  _layout() {
    if (!this.deck) return
    const { a: A, b: B } = this.cols
    const a = !A.el.hidden
    const b = !B.el.hidden
    A.el.classList.toggle('page', Boolean(A.screen))
    this.deck.classList.toggle('two', a && b)
    const need = (A.screen ? 460 : 360) + 12 + 560
    this.deck.classList.toggle('stacked', a && b && this.deck.clientWidth < need)
    this._syncBack(B)
  }

  /** Back shows where there is a step back, and on B when it covers A (it goes back to the list). */
  _syncBack(col) {
    const button = col.el?.querySelector('.col-head .back')
    if (!button) return
    const covering = col === this.cols.b && this.deck?.classList.contains('stacked')
    button.hidden = !(col.stack.length || covering)
    button.title = col.stack.length ? 'Back' : covering ? `Back to ${this.cols.a.el.querySelector('.col-head strong').textContent}` : 'Back'
  }

  /** A column that opens slides in; one whose page changes fades the new page in. Reduced motion: neither. */
  _animate(col, fresh) {
    const el = fresh ? col.el : col.el.querySelector('.sheet-body')
    const cls = fresh ? 'entering' : 'swap'
    el.classList.remove('entering', 'swap')
    void el.offsetWidth
    el.classList.add(cls)
  }

  /** Mark the row in A whose page B shows. */
  _pick(key) {
    this._picked = key || ''
    this._applyPick()
  }

  _applyPick() {
    const body = this.cols.a.el?.querySelector('.sheet-body')
    if (!body) return
    for (const el of body.querySelectorAll('.picked')) el.classList.remove('picked')
    if (!this._picked || this.cols.b.el.hidden) return
    // The row itself, not the buttons on it that carry the same name (rank, clear).
    for (const el of body.querySelectorAll(PICKABLE)) if (!el.dataset.act && !el.dataset.clear && pickKey(el) === this._picked) el.classList.add('picked')
  }

  /** What waits on the owner's own word: approvals to give, questions to answer, jobs to look at. */
  _asks() {
    // The same failure many times over is one line with a count: ten "The checker run failed" hide the one ask that matters.
    const seen = new Map()
    for (const a of this._needs || []) {
      const key = a.kind === 'failed' || !a.id ? `${a.kind}:${a.title}` : `${a.kind}:${a.id}`
      if (seen.has(key)) {
        const group = seen.get(key)
        group.times += 1
        group.keys.push(a.key)
        group.read = group.read && a.read
        group.archived = group.archived && a.archived
      } else seen.set(key, { ...a, times: 1, keys: [a.key] })
    }
    // A bot stopped on an error and its runs that failed are one incident: one card, with the count.
    for (const stopped of [...seen.values()].filter((a) => a.kind === 'failed' && !a.id)) {
      for (const [key, run] of seen) {
        if (run === stopped || run.kind !== 'failed' || !String(run.title).startsWith(`${stopped.title} run`)) continue
        stopped.runs = (stopped.runs || 0) + run.times
        stopped.keys.push(...run.keys)
        stopped.read = stopped.read && run.read
        seen.delete(key)
      }
    }
    const order = { approval: 0, question: 1, review: 2, blocked: 3, failed: 4 }
    // New first, then read; archived ones fold away at the bottom.
    const all = [...seen.values()].sort((a, b) => (a.read - b.read) || ((order[a.kind] ?? 5) - (order[b.kind] ?? 5)))
    this._cards = all
    const live = all.filter((a) => !a.archived)
    const archived = all.filter((a) => a.archived)
    if (!all.length) return ''
    const KIND = { approval: 'Wants your yes or no', question: 'Asks you', blocked: 'Blocked', review: 'To review', failed: 'Failed' }
    const card = (a) => {
      const n = all.indexOf(a)
      const sort = `<span class="sort">${a.archived
        ? `<button class="btn ghost small" data-act="card" data-card="${n}" data-archived="false" title="Back to the list">Restore</button>`
        : `<button class="btn ghost small" data-act="card" data-card="${n}" data-read="${!a.read}" title="${a.read ? 'Show as new again' : 'Mark as read'}">${a.read ? 'Mark unread' : 'Mark read'}</button><button class="btn ghost small" data-act="card" data-card="${n}" data-archived="true" title="Put away; it comes back if anything new is asked">Archive</button>`}</span>`
      const tone = { approval: 'warn', question: 'warn', review: 'look', blocked: 'bad', failed: 'bad' }[a.kind] || ''
      const label = `<span class="kind">${a.read ? '' : '<i class="new" aria-label="New"></i>'}<span class="state ${tone}">${esc(KIND[a.kind] || a.kind)}</span>${a.times > 1 ? ` ${a.times} times` : ''}</span><b>${esc(plainWords(a.title))}</b>${a.detail ? `<small>${esc(plainWords(a.detail))}${a.runs ? ` Its runs failed ${a.runs} time${a.runs === 1 ? '' : 's'}.` : ''}</small>` : ''}`
      // Only what waits for the owner's own answer wears the stripes; the rest is news to look at.
      const cls = `ask ${a.read ? 'read' : 'unread'} ${a.kind === 'approval' || a.kind === 'question' ? 'wants' : ''}`
      if (a.kind === 'approval') {
        return `<div class="${cls} approval" data-card="${n}">${label}<span class="pair"><button class="btn primary" data-act="approve" data-id="${esc(a.id)}">Approve</button><button class="btn ghost" data-act="reject" data-id="${esc(a.id)}">Reject</button></span>${sort}</div>`
      }
      // A question asked in a chat is answered in that chat; one on a job, on the job's page.
      // A bot that stopped on an error opens its page, where it can start fresh or be paused.
      const stopped = !a.id && !a.botId && a.kind === 'failed' ? this.view?.manager.bots.find((b) => b.name === a.title) : null
      const open = a.botId ? `data-bot="${esc(a.botId)}"` : stopped ? `data-act="open-bot" data-id="${esc(stopped.id)}"` : a.id ? `data-line="${esc(a.id)}"` : ''
      const go = a.botId ? 'Open the chat to answer'
        : stopped ? `Open ${stopped.name.split(' ')[0]}'s page to start it again or pause it`
        : a.kind === 'blocked' ? 'Open the job to see what blocks it'
        : a.kind === 'failed' ? 'Open the job: its last runs and why they failed'
        : a.kind === 'review' ? 'Open the job to look at it' : ''
      const goLine = go ? `<small class="go">${esc(go)} →</small>` : ''
      return `<div class="${cls}" data-card="${n}">${open ? `<button class="ask-open" ${open}>${label}${goLine}</button>` : `<div class="ask-open">${label}</div>`}${sort}</div>`
    }
    const unread = live.filter((a) => !a.read).length
    return (unread > 1 ? '<button class="btn ghost small all-read" data-act="cards-read">Mark all read</button>' : '')
      + live.map(card).join('')
      + (archived.length ? `<details class="archived-cards"><summary>Archived (${archived.length})</summary>${archived.map(card).join('')}</details>` : '')
  }

  /** Mark cards read or archived, here and on the phone, and redraw at once. */
  async _markCards(cards, change) {
    const keys = cards.flatMap((c) => c.keys)
    for (const n of this._needs || []) {
      if (!keys.includes(n.key)) continue
      if (change.read !== undefined) n.read = change.read
      if (change.archived !== undefined) { n.archived = change.archived; if (change.archived) n.read = true }
    }
    this._last.panel = null
    this._putPanel()
    this._putDock()
    try {
      await call('/api/studio/cards', { keys, ...change })
    } catch (err) {
      this.actions.toast(err.message || 'That did not save', 'err')
      this._loadNeeds()
    }
  }

  async _loadNeeds() {
    this._needsAt = Date.now()
    try {
      const { needs } = await call('/api/studio/needs')
      this._needs = needs
      this._last.panel = null
      this._putPanel()
      this._putDock()
      this._putTop()
      this.actions.redraw?.()
    } catch { /* the trouble list still shows; this is tried again on the next poll */ }
  }

  async _decide(id, decision) {
    try {
      await call('/api/studio/approval', { id, decision })
      this.actions.toast(decision === 'approve' ? 'Approved' : 'Rejected')
      this._needs = (this._needs || []).filter((a) => a.id !== id)
      this._last.panel = null
      this._putPanel()
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
  }

  /** A room was clicked: its project's page. */
  /** A project from the map or a list: the list of projects in A, and its page beside it in B. */
  openProject(name, { fly = false } = {}) {
    if (fly) this.actions.focusProject(name)
    if (this.tab !== 'projects' || this.cols.a.screen) this.show('projects')
    this._enter('b', () => this.openProjectPage(name))
    this._pick(name)
  }

  /** @returns {boolean} whether there was a panel to close */
  closePanel() {
    if (!this.tab) return false
    this.show(null)
    return true
  }

    _put(key, el, html) {
    if (this._last[key] === html) return
    this._last[key] = html
    el.innerHTML = html
  }

  /** The newest answer of `/api/studio`. */
setView(view) {
    this.view = view
    learnColours(view.manager?.bots)
    if (!this._shelfTouched) this._shelved = new Set(view.shelved || [])
    if (!this._rankTouched) this._ranked = view.ranked || []
    this._rankTouched = false
    this._shelfTouched = false
    this._putTop()
    this._putDock()
    this._putPanel()
    this._putCrew()
    if (this.chatBot) this._syncChatHead()
    if (this._colOf('settings')) this._putSettingsCrew()
    this._putProject()
    if (this._colOf('first')) this._putFirst()
    // A yard that has not had its first job opens on its first run, once per visit; after that the
    // top bar keeps naming the step that is left, so closing the sheet never loses the way.
    this._firstCheck()
    if (this._first?.left?.length && Date.now() - (this._firstAt2 || 0) > 20_000) {
      this._firstAt2 = Date.now()
      call('/api/studio/first-run').then((first) => { if (first) { this._first = first; this._putTop() } }).catch(() => {})
    }
    if (Date.now() - (this._needsAt || 0) > NEEDS_EVERY_MS) this._loadNeeds()
  }

  // ── the deck: top bar, dock, crew ────────────────────────────────────────────────

  _putTop() {
    const { manager: m, plans } = this.view
    // The whole sentence where there is room; on a narrow window, only how many are at work.
    const busy = m.bots.filter((b) => b.status === 'running').length
    // What waits for the owner is counted once: the top bar says the same number as the bell and the bays.
    const waiting = (this._cards || this._needs || []).filter((a) => !a.read && !a.archived).length
    const said = m.state.replace(/ \d+ things? needs? a look\./, '') + (waiting ? ` ${waiting} ${waiting === 1 ? 'thing waits' : 'things wait'} for you.` : '')
    // Pairing a phone is optional: it never keeps the top bar asking on its own.
    const left = (this._first?.left || []).filter((s) => s !== 'phone')
    const stepNames = { name: 'name your yard', setup: 'connect an AI', crew: 'pick a crew', chat: 'say hello to a bot', project: 'add a project', job: 'give a first job' }
    const next = left.length && !busy ? `<button type="button" class="next-step" data-first-step="${esc(left[0])}">Next: ${esc(stepNames[left[0]] || 'finish setting up')}</button>` : ''
    this._put('state', this.top.querySelector('.studio-state'), `<span class="long">${next || esc(said)}</span><span class="short">${next || `${busy ? `${busy} working` : 'All free'}${waiting ? `, ${waiting} for you` : ''}`}</span>`)
    const meter = (name, plan) => {
      if (!plan) return ''
      const share = Math.min(1, Math.max(0, plan.week || 0))
      const level = share >= 0.9 ? 'bad' : share >= 0.75 ? 'warn' : ''
      // Ten cells, filled as the week's limit is used: the crew's charge, read at a glance.
      const cells = Array.from({ length: 10 }, (_, n) => `<u class="${share * 10 > n + 0.05 ? 'on' : ''}"></u>`).join('')
      return `<span class="meter ${level}" title="${name}: ${Math.round(share * 100)}% of this week's limit is used"><b>${name}</b><i class="cells">${cells}</i><em>${Math.round(share * 100)}% used</em></span>`
    }
    this._put('meters', this.top.querySelector('[data-part="meters"]'), plans ? meter('Claude', plans.claude) + meter('Codex', plans.codex) : '')
  }

  get usageOpen() { return Boolean(this._usagePop && !this._usagePop.hidden) }

  /** The list under the meters: every AI the crew runs on, what is used and what is left. Read on each open. */
  async openUsage() {
    const pop = (this._usagePop = this.root.querySelector('.usage-pop'))
    const button = this.top.querySelector('.usage-btn')
    pop.hidden = false
    this._placeUsage()
    button.setAttribute('aria-expanded', 'true')
    if (!pop.innerHTML) pop.innerHTML = '<p class="u-empty">Reading what each AI has used…</p>'
    const seq = (this._usageSeq = (this._usageSeq || 0) + 1)
    try {
      const data = await call('/api/studio/usage')
      if (seq === this._usageSeq && this.usageOpen) pop.innerHTML = usageHtml(data)
    } catch (err) {
      if (seq === this._usageSeq && this.usageOpen) pop.innerHTML = `<p class="u-empty">${esc(err.message || 'The usage could not be read')}</p>`
    }
  }

  /** Under its button, its right edge on the button's, kept inside the window. */
  _placeUsage() {
    const b = this.top.querySelector('.usage-btn').getBoundingClientRect()
    const host = this.root.getBoundingClientRect()
    this._usagePop.style.top = `${Math.round(b.bottom - host.top + 10)}px`
    this._usagePop.style.right = `${Math.max(8, Math.round(host.right - b.right))}px`
  }

  closeUsage() {
    if (!this.usageOpen) return false
    this._usagePop.hidden = true
    this.top.querySelector('.usage-btn').setAttribute('aria-expanded', 'false')
    return true
  }

  _putDock() {
    const m = this.view.manager
    // The badge counts what Needs you lists as new, so the two never disagree.
    const unread = (this._cards || this._needs || []).filter((a) => !a.read && !a.archived)
    const counts = {
      attention: unread.length || m.trouble.filter((t) => t.level === 'bad').length,
      work: m.lines.filter((l) => l.open && !this._cleared.has(l.id)).length,
    }
    const urgent = m.trouble.some((t) => t.level === 'bad') || unread.some((a) => a.kind === 'approval' || a.kind === 'question')
    const A = this.cols.a
    const here = A.el.hidden ? '' : A.screen || this.tab
    const items = this._dockItems()
    this._put('dock', this.dock, items.map((d, n) => {
      const on = here === d.id
      const gap = n > 0 && d.group !== items[n - 1].group ? '<i class="dock-gap" aria-hidden="true"></i>' : ''
      return `${gap}<button data-tab="${d.id}" class="${on ? 'on' : ''}" aria-pressed="${on}" title="${esc(d.title || d.name)}${d.key ? ` (${d.key})` : ''}">
      ${ICONS[d.icon]}<span>${esc(d.name)}</span>${d.key ? `<kbd aria-hidden="true">${d.key}</kbd>` : ''}${counts[d.id] ? `<b class="${d.id === 'attention' && urgent ? 'bad' : ''}">${counts[d.id]}</b>` : ''}
    </button>`
    }).join(''))
  }

  /**
   * The crew along the bottom, each in a fixed place by the chain of command (the server's order), with a
   * gap between tiers. Who is working shows on the bot (its light and what it is on), never by moving it.
   */
  _putCrew() {
    const crew = this.view.manager.bots
    this._put('crew', this.crewBar, crew.map((b, n) => {
      const doing = b.job ? `${b.job.stage}${/[A-Z]+-\d+/.test(b.job.stage) ? '' : ` ${b.job.ref}`}` : b.why || (b.last ? `Last on ${b.last.ref}` : 'Nothing given yet')
      const tier = n > 0 && b.tier !== crew[n - 1].tier ? `<i class="tier-gap" aria-hidden="true"></i>` : ''
      return `${tier}<button class="mate ${esc(b.status)} ${this.chatBot === b.id ? 'on' : ''}" style="${botStyle(b.name)}" data-bot="${esc(b.id)}" title="${esc(b.name)}: ${esc(doing)}" aria-label="${esc(b.name)}: ${esc(doing)}">
        <span class="who">${this._face(b)}<i class="light"></i></span>
        <span class="text"><b>${esc(b.name.split(' ')[0])}</b><small>${esc(b.status === 'running' ? doing : b.status === 'error' ? 'Stopped on an error' : b.status === 'paused' ? 'Paused' : 'Free')}</small></span>
      </button>`
    }).join(''))
  }

  // ── the panel ────────────────────────────────────────────────────────────────────

  _putPanel() {
    if (!this.tab || !this.view || this.cols.a.screen) return
    const m = this.view.manager
    const A = this.cols.a.el
    // A list's name and what it is for go in the column's own head, which stays put while the list scrolls.
    const head = (title, sub = '') => {
      A.querySelector('.col-head strong').textContent = title
      A.querySelector('.col-head p').textContent = sub
      return ''
    }
    let html = ''
    if (this.tab === 'attention') {
      html = head('Needs you', 'Your answers and approvals first, then what is going wrong') + this._asks() + (m.trouble.length
        ? (this._needs?.length ? '<h3>Also going on</h3>' : '') + m.trouble.map((t) => `<p class="trouble ${esc(t.level)}"><i></i>${esc(t.text)}</p>`).join('')
        : this._needs?.length ? '' : '<p class="none">Nothing needs you. The crew is getting on with it.</p>')
        + (m.feed.length ? `<h3>Lately</h3>${m.feed.slice(0, SHOWN_FEED).map((f) => `<p class="event ${esc(f.kind)}"><time>${clock(f.at)}</time>${esc(f.text)}</p>`).join('')}` : '')
    } else if (this.tab === 'work') {
      const done = m.lines.filter((l) => !l.open).slice(0, 10)
      html = head('Work', 'What the crew has in hand, newest step first')
        + `<button class="find" data-act="all-jobs">${ICONS.search}<span>Find any job: every pile, project and bot</span></button>`
        + this._lines(m.lines)
        + (done.length ? `<h3>Finished lately</h3>${done.map((l) => `<button class="line done" data-line="${esc(l.id)}"><span class="ref">${esc(l.ref)}</span><span class="title">${esc(l.title)}</span><span></span><span class="note">${esc(l.note || l.stage)}</span></button>`).join('')}` : '')
    } else if (this.tab === 'projects') {
      const order = this._rankedProjects()
      html = head('Projects', 'Ranked: a free bot takes the next job from the highest project with work for it')
        + `<button class="find add" data-act="project-new">${ICONS.plus}<span>Add a project</span></button>`
        + (order.length ? '' : '<p class="none">No projects yet. A project is a folder of code the crew works in.</p>')
        + order.map((p, i) => {
          const shelved = this._shelved.has(p.name)
          const live = order.filter((x) => !this._shelved.has(x.name))
          const at = live.indexOf(p)
          return `<div class="proj-row ${shelved ? 'shelved' : ''}">
          <span class="rank" title="${shelved ? 'On the shelf: not ranked' : `Rank ${at + 1}`}">${shelved ? '–' : at + 1}</span>
          <button class="proj ${shelved ? 'shelved' : ''}" data-project="${esc(p.name)}">
            <b>${esc(p.name)}</b>${shelved ? '<em>On the shelf</em>' : ''}
            <span class="counts">${this._counts(p)}</span>
          </button>
          <span class="rank-moves">${shelved ? '' : `<button class="btn icon ghost" data-act="rank" data-by="-1" data-project="${esc(p.name)}" title="Rank higher" aria-label="Rank ${esc(p.name)} higher" ${at === 0 ? 'disabled' : ''}>▲</button><button class="btn icon ghost" data-act="rank" data-by="1" data-project="${esc(p.name)}" title="Rank lower" aria-label="Rank ${esc(p.name)} lower" ${at === live.length - 1 ? 'disabled' : ''}>▼</button>`}</span>
        </div>`
        }).join('')
    }
    this._put('panel', this.panel.querySelector('.sheet-body'), html)
    this._applyPick()
    // The dock's badge is counted from the cards just drawn.
    this._putDock()
  }

  /** A project page's folders, routines and spend, read when the page opens and again after a minute. */
  async _loadProject(id) {
    const known = this._projectInfo.get(id)
    if (known && (known.loading || Date.now() - known.at < 60_000)) return
    this._projectInfo.set(id, { ...known, loading: true })
    try {
      const page = await call(`/api/studio/project?id=${encodeURIComponent(id)}`)
      this._projectInfo.set(id, { page, at: Date.now() })
    } catch (err) {
      this._projectInfo.set(id, { page: known?.page || null, at: Date.now() })
      if (!known?.page) this.actions.toast(err.message || 'The project could not be read', 'err')
    }
    this._last.project = null
    this._putProject()
  }

  // ── a project's page ─────────────────────────────────────────────────────────────

  /** A project's page, in the column it is opened in: its goal, what is going on, the lead's plan, the rest. */
  openProjectPage(name) {
    const p = this.view?.manager.projects.find((x) => x.name === name)
    this._openSheet('project', name, '', { wide: false })
    this._reopen = () => this.openProjectPage(name)
    this._projectName = name
    this._goalEditing = false
    ++this._sheetSeq
    this._last.project = null
    this._putProject()
    if (p) this._loadProject(p.id)
  }

  /** What the lead does with a project that has no goal, from his own rules (the crew's goal rules). */
  _standing(name) {
    if (this._shelved?.has(name)) return 'It is on the shelf: The lead gives nobody work here until you take it off.'
    const live = this._rankedProjects().filter((x) => !this._shelved.has(x.name))
    const at = live.findIndex((x) => x.name === name)
    const rank = at < 0 ? '' : ` It is rank ${at + 1} of ${live.length}: a free bot takes work here only when the projects above have none it can do.`
    return `Without one, the lead works from what the project is and its own plan and notes, and briefs nothing toward a finish line.${rank} Set a goal to give the crew one.`
  }

  /** Draw the project page again from what is known; live parts change with every poll. */
  _putProject() {
    const col = this._colOf('project')
    if (!col || !this.view || this._goalEditing) return
    const name = this._projectName
    const m = this.view.manager
    const p = m.projects.find((x) => x.name === name)
    const body = col.el.querySelector('.sheet-body')
    if (!p) return this._put('project', body, '<p class="none">Nothing is known about this project yet.</p>')
    const info = this._projectInfo.get(p.id)
    const shelved = this._shelved.has(name)
    const live = this._rankedProjects().filter((x) => !this._shelved.has(x.name))
    const at = live.findIndex((x) => x.name === name)
    const bots = m.bots.filter((b) => p.bots.includes(b.name))
    col.el.querySelector('.col-head p').innerHTML = `${shelved ? 'On the shelf' : `Rank ${at + 1} of ${live.length}`}<span class="dot-sep"></span>${this._counts(p).replace(/<span>Nothing going<\/span>/, 'Nothing going')}`
    const html = projectGoal(info?.page?.goal || (info && !info.loading ? { goal: '', about: '' } : null), { standing: this._standing(name) })
      + (p.unpushed ? `<p class="trouble info"><i></i>${p.unpushed} merged piece${p.unpushed === 1 ? ' is' : 's are'} not pushed yet</p>` : '')
      + `<h3>Going on now</h3>${this._lines(m.lines.filter((l) => l.project === name), shelved ? 'On the shelf: nothing is given out here.' : 'Nothing is running or queued here.')}`
      + (bots.length ? `<h3>Here now</h3>${bots.map((b) => `<button class="bot ${esc(b.status)}" data-bot="${esc(b.id)}"><span class="who">${this._face(b)}<i class="light"></i></span><span class="name">${esc(b.name)}</span><span class="model">${esc(b.model || '')}</span><span class="doing">${esc(b.job ? `${b.job.stage} ${b.job.title}` : b.why || 'Free')}</span></button>`).join('')}` : '')
      + projectPlan(info?.page?.plan)
      + (info?.page ? projectExtras(info.page) : '')
      + `<h3>Its place</h3><div class="acts">${shelved ? '' : `<button class="btn" data-act="rank" data-by="-1" data-project="${esc(name)}" ${at === 0 ? 'disabled' : ''}>Rank higher</button><button class="btn" data-act="rank" data-by="1" data-project="${esc(name)}" ${at === live.length - 1 ? 'disabled' : ''}>Rank lower</button>`}</div>
        <div class="acts"><button class="btn" data-act="fly" data-project="${esc(name)}">Show its bay</button><button class="btn ${shelved ? 'primary' : ''}" data-act="shelve" data-project="${esc(name)}" aria-pressed="${shelved}">${shelved ? 'Take off the shelf' : 'Put on the shelf'}</button></div>
        <div class="acts"><button class="btn ghost" data-act="project-edit" data-project="${esc(name)}">Name, folder, archive…</button></div>`
    this._put('project', body, html)
  }

  /** Edit the goal in place, or stop editing. */
  _goalEdit(on) {
    const col = this._colOf('project')
    const p = this.view?.manager.projects.find((x) => x.name === this._projectName)
    if (!col || !p) return
    const goal = this._projectInfo.get(p.id)?.page?.goal || { about: '', goal: '' }
    this._goalEditing = false
    this._last.project = null
    if (!on) return this._putProject()
    this._putProject()
    const card = col.el.querySelector('.goal-card')
    if (!card) return
    card.outerHTML = projectGoal(goal, { editing: true })
    this._goalEditing = true
    col.el.querySelector('.goal-edit textarea')?.focus()
  }

  async _saveGoal(form) {
    const p = this.view?.manager.projects.find((x) => x.name === this._projectName)
    if (!p || this._savingGoal) return
    const field = (k) => form.elements[k]?.value.trim() || ''
    this._savingGoal = true
    try {
      const done = await call('/api/studio/project-goal', { id: p.id, about: field('about'), goal: field('goal'), doneWhen: field('doneWhen'), first: field('first'), parked: field('parked'), tell: form.elements.tell?.checked !== false })
      const info = this._projectInfo.get(p.id)
      if (info?.page) info.page.goal = done.goal
      this.actions.toast(!done.changed ? 'Nothing changed' : done.told ? 'Goal saved, and the lead is told' : 'Goal saved')
      this._goalEditing = false
      this._last.project = null
      this._putProject()
    } catch (err) {
      this.actions.toast(err.message || 'The goal was not saved', 'err')
    }
    this._savingGoal = false
  }

  _counts(p) {
    const part = (n, word, level) => (n ? `<span class="${level}">${n} ${word}</span>` : '')
    // The same numbers and words as the sign over the project's bay.
    const c = this._bayCounts().get(p.name) || {}
    return part(c.build, 'building', 'go') + part(c.check, 'checking', 'go') + part(c.wait, 'waiting', '') + part(c.stop, 'stopped', 'bad') + part(c.you, c.you === 1 ? 'needs you' : 'need you', 'bad') + part(p.doneToday, 'done today', 'done')
      || '<span>Nothing going</span>'
  }

  // ── work in hand, and calling it off ─────────────────────────────────────────────

  _lines(all, none = 'No open jobs. Tell a bot what to do: click it on the map.') {
    const m = this.view.manager
    const known = new Set(m.lines.map((l) => l.id))
    for (const id of this._cleared) if (!known.has(id)) this._cleared.delete(id)
    const lines = all.filter((l) => l.open && !this._cleared.has(l.id)).slice(0, SHOWN_LINES)
    if (this._clearing && !m.lines.some((l) => l.id === this._clearing)) this._clearing = null
    return lines.length
      ? lines.map((l) => (l.id === this._clearing
        ? `<div class="ask">
          <p><b>Clear ${esc(l.ref)}?</b> It stops and closes, its checks too. It can be reopened from its page.</p>
          <button class="btn primary" data-clear="${esc(l.id)}" data-answer="yes">Clear it</button>
          <button class="btn ghost" data-clear="${esc(l.id)}" data-answer="no">Keep it</button>
        </div>`
        : `<div class="row"><button class="line ${l.late ? 'late' : ''}" style="${l.bot ? botStyle(l.bot) : ''}" data-line="${esc(l.id)}" data-job="${esc(l.ref)}" data-bot="${esc(m.bots.find((b) => b.name === l.bot)?.id || '')}">
        <span class="ref">${esc(l.ref)}</span><span class="title">${esc(l.title)}</span>
        <span class="stage ${esc(STAGE[l.stage]?.[1] || '')}" title="${esc(l.steps.map((s, i) => `${STEP_NAMES[i]}: ${s}`).join(', '))}">${esc(STAGE[l.stage]?.[0] || l.stage)}</span>
        <span class="note">${esc(noteOf(l))}</span>
      </button>${CLEARABLE.has(l.stage) ? `<button class="clear" data-clear="${esc(l.id)}" title="Clear ${esc(l.ref)}: no longer needed" aria-label="Clear ${esc(l.ref)}">${CLOSE_ICON}</button>` : ''}</div>`)).join('')
      : `<p class="none">${none}</p>`
  }

  _putLines() {
    this._putPanel()
    this._last.project = null
    this._putProject()
    this._putDock()
  }

  /** The cross on a line asks first; only "Clear it" closes anything. */
  async _askClear(id, answer) {
    if (!answer) { this._clearing = id; return this._putLines() }
    this._clearing = null
    if (answer !== 'yes') return this._putLines()
    const line = this.view.manager.lines.find((l) => l.id === id)
    try {
      await call('/api/studio/job', { id, action: 'clear' })
      this._cleared.add(id)
      this.actions.toast(`${line?.ref || 'The job'} is cleared`)
      this.actions.refresh()
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
    this._putLines()
  }

  // ── what a bot looks like ────────────────────────────────────────────────────────

  /** A bot's portrait, or its initial on a colour of its own where nobody has drawn it yet. */
  _face(bot) {
    const src = this.view?.faces?.[bot.id]
    return src
      ? `<img class="face" src="${esc(src)}" alt="" draggable="false">`
      : `<i class="face plain" style="--hue:${hueOf(bot.name)};${botStyle(bot.name)}" aria-hidden="true">${esc(bot.name.slice(0, 1))}</i>`
  }

  /** Dress each bot of the crew in a roster as itself: its own colour and the kit its job wears. */

  // ── the screens that are rooms ───────────────────────────────────────────────────

  /** Which screen a room on the map opens, if it is one of those rooms. */
  screenOf(room) {
    return (this.on && this.view?.screens?.find((s) => s.room === room)?.id) || null
  }

  /** Show the sheet with a title, ready to be filled. */
  _openSheet(id, title, sub, { wide = false } = {}) {
    const col = this.cur
    // Opened from the dock, a room or a list: a fresh start. Opened from inside the column: one step deeper.
    // Reopened in place (after a change on it), it keeps the way back.
    if (this._freshB && col === this.cols.b) col.stack = []
    else if (!this._navigating && id !== col.screen) col.stack = []
    this._freshB = false
    this._confirmAsk(null)
    const fresh = col.el.hidden
    const same = col.screen === id
    if (!same) this._leaveOwnPage(col)
    col.el.classList.toggle('wide', wide)
    col.screen = id
    if (col === this.cols.a) { this.tab = null; this.root.classList.add('studio-open') }
    const body = col.el.querySelector('.sheet-body')
    this._last.sheet = this._last['sheet-projects'] = this._last.project = null
    col.el.hidden = false
    col.el.querySelector('.col-head strong').textContent = title
    col.el.querySelector('.col-head p').textContent = sub
    if (!same) body.innerHTML = SKELETON
    if (!same) body.scrollTop = 0
    this._putDock()
    this._syncBack(col)
    if (!same || fresh) this._animate(col, fresh)
    this._layout()
    if (fresh) col.el.querySelector('[data-act="close-col"]').focus({ preventScroll: true })
    return body
  }

  /** Give the crew a job from the map. The lead gets it unless a bot is picked. */
  /** @param {string} [project] the project's name the job is for; with one project it is that one */
  openNewJob(project = '') {
    const m = this.view.manager
    const pick = m.projects.find((p) => p.name === project)?.id || (m.projects.length === 1 ? m.projects[0].id : '')
    const body = this._openSheet('newjob', 'New job', 'The lead takes it and hands it on, unless you pick who does it')
    body.innerHTML = `<form class="fields">
      <label class="stack">What should be done<input name="title" maxlength="180" required placeholder="One line, the outcome you want"></label>
      <label class="stack">Details<textarea name="description" rows="5" placeholder="What done looks like, where to look, what not to touch"></textarea></label>
      <label>Project <select name="projectId"><option value="">None</option>${m.projects.map((p) => `<option value="${esc(p.id)}"${p.id === pick ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Who <select name="botId"><option value="">The lead decides</option>${m.bots.filter((b) => b.status !== 'paused').map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>
      <button class="btn primary" type="submit">Give the job</button>
    </form>`
    body.querySelector('input').focus()
  }

  async _addJob() {
    const form = this.sheet.querySelector('form')
    if (!form?.reportValidity() || this._adding) return
    this._adding = true
    const field = (name) => form.elements[name].value.trim()
    try {
      const job = await call('/api/studio/job', { action: 'add', title: field('title'), description: field('description'), ...(field('projectId') ? { projectId: field('projectId') } : {}), ...(field('botId') ? { botId: field('botId') } : {}) })
      this.actions.toast(`Job given${job.ref ? ` (${job.ref})` : ''}`)
      this.closeSheet()
      this.actions.refresh()
    } catch (err) {
      this.actions.toast(err.message || 'The job was not given', 'err')
    }
    this._adding = false
  }

  // ── a job, and every job ─────────────────────────────────────────────────────────

  /**
   * One job: where it stands, what was asked, what it made and cost, and what was last said on it.
   * `id` is its id, or the engine's number from a link in a message.
   */
  async openJob(id, { editing = false } = {}) {
    const line = this.view.manager.lines.find((l) => l.id === id)
    this._openSheet('job', line ? `${line.ref} ${line.title}` : 'Job', line ? `${line.project || 'No project'}${line.bot ? `, ${line.bot}` : ''}: ${line.note || line.stage}` : '', { wide: true })
    this._reopen = () => this.openJob(id)
    const seq = ++this._sheetSeq
    const job = await this._fill('job', seq, () => call(`/api/studio/job?id=${encodeURIComponent(id)}`), (j) => {
      this._job = j
      // The questions a bot put on this job, answered right here.
      this._jobCards = new Map((j.questions || []).map((q) => [q.id, { id: q.id, state: 'pending', kind: q.kind, title: q.title, question: q, at: Date.now() }]))
      const cards = [...this._jobCards.values()].map((c) => this._card(c)).join('')
      const m = this.view.manager
      const lineNow = line || m.lines.find((l) => l.id === j.id)
      const bot = m.bots.find((b) => b.id === j.botId || b.name === j.bot)
      return jobScreen(j, { line: lineNow, steps: STEP_NAMES, cards, bot, editing, crew: m.bots, projects: m.projects })
    })
    const col = this._colOf('job')
    if (!job || !col) return
    // Under its runs, what the bot on it is doing now, or did in its last run, read like its own transcript.
    const shown = job.runs.find((r) => r.status === 'running' || r.status === 'queued') || job.runs[0]
    const spot = col.el.querySelector('[data-part="job-feed"]')
    if (shown && spot) {
      const live = shown.status === 'running' || shown.status === 'queued'
      spot.innerHTML = `<h3>${live ? `What ${esc(shown.bot.split(' ')[0])} is doing now` : `${esc(shown.bot.split(' ')[0])}'s last run`} <button class="link" data-act="open-run" data-id="${esc(shown.id)}">Open the run</button></h3>${feedFrameHtml()}`
      const jobSeq = col.seq
      this._followRun(spot.querySelector('[data-part="run-feed"]'), shown.id, () => this._colOf('job') === col && col.seq === jobSeq && this._job?.id === job.id)
    }
    col.el.querySelector('.col-head strong').textContent = `${job.ref} ${job.title}`
    if (!line) col.el.querySelector('.col-head p').textContent = [job.project || 'No project', job.bot].filter(Boolean).join(', ')
  }

  async _jobAct(action) {
    if (!this._job) return
    const run = async () => {
      try {
        await call('/api/studio/job', { action, id: this._job.id })
        this.actions.toast({ stop: 'Run stopped', cancel: 'Job cancelled', reopen: 'Job reopened' }[action])
        this.actions.refresh()
        this.openJob(this._job.id)
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    }
    if (action === 'stop') return run()
    // Both wake or stop a bot: each asks first.
    if (action === 'reopen') return this._confirmAsk(`<b>Reopen ${esc(this._job.ref)}?</b> ${esc(this._job.bot || 'The bot on it')} is woken and starts on it again. Add a comment first if it should do something new.`, 'Reopen', run)
    this._confirmAsk(`<b>Cancel ${esc(this._job.ref)}?</b> The crew stops work on it. It can be reopened from its page later.`, 'Cancel the job', run)
  }

  async _saveJob(form) {
    const j = this._job
    if (!j || !form.reportValidity()) return
    const now = { title: form.elements.title.value.trim(), description: form.elements.description.value, priority: form.elements.priority.value, projectId: form.elements.projectId.value, botId: form.elements.botId.value }
    const was = { title: j.title, description: j.description, priority: j.priority, projectId: j.projectId, botId: j.botId }
    const changes = Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== was[k]))
    // The page shows the title made plain; an untouched title is never written back in that form.
    if (changes.title === j.title) delete changes.title
    if (!Object.keys(changes).length) return this.openJob(j.id)
    try {
      await call('/api/studio/job', { action: 'edit', id: j.id, changes })
      this.actions.toast(`${j.ref} saved`)
      this.actions.refresh()
      this.openJob(j.id)
    } catch (err) {
      this.actions.toast(err.message || 'The job was not saved', 'err')
    }
  }

  /** A file from this computer, attached to the open job. */
  async _attach(input) {
    const file = input.files?.[0]
    const j = this._job
    input.value = ''
    if (!file || !j) return
    if (file.size > 10 * 1024 * 1024) return this.actions.toast('Files are limited to 10 MB', 'err')
    this.actions.toast(`Attaching ${file.name}…`)
    try {
      const res = await fetch(`/api/studio/attach?id=${encodeURIComponent(j.id)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `${res.status}`)
      this.actions.toast(`${file.name} is attached to ${j.ref}`)
      this.openJob(j.id)
    } catch (err) {
      this.actions.toast(err.message || 'The file was not attached', 'err')
    }
  }

  async _jobChanges() {
    const el = this.deck.querySelector('[data-part="job-changes"]')
    if (!el || !this._job) return
    el.innerHTML = '<p class="none">Reading the branch…</p>'
    try {
      el.innerHTML = `<h3>The changes</h3>${changesHtml(await call(`/api/studio/job/changes?id=${encodeURIComponent(this._job.id)}`))}`
    } catch (err) {
      el.innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  _docBox(key) {
    return [...this.sheet.querySelectorAll('[data-doc]')].find((d) => d.dataset.doc === key)
  }

  _docEdit(key) {
    const doc = this._job?.documents.find((d) => d.key === key)
    const box = this._docBox(key)
    if (!doc || !box) return
    box.querySelector('[data-part="doc-text"]').outerHTML = `<div class="fields instr-edit" data-part="doc-text"><textarea rows="18" spellcheck="false">${esc(doc.body)}</textarea>
      <div class="acts"><button class="btn primary" data-act="doc-save" data-key="${esc(key)}">Save…</button><button class="btn ghost" data-act="doc-cancel">Keep it as it is</button></div></div>`
    box.querySelector('textarea').focus()
  }

  _docSave(key) {
    const doc = this._job?.documents.find((d) => d.key === key)
    const text = this._docBox(key)?.querySelector('textarea')?.value
    if (!doc || text == null) return
    if (text === doc.body) return this.actions.toast('Nothing changed')
    this._confirmAsk(`<b>Save “${esc(doc.title)}”?</b> ${esc(editSummary(doc.body, text))}. It becomes version ${doc.revision + 1}; version ${doc.revision} stays in its history.`, 'Save', async () => {
      try {
        await call('/api/studio/document', { action: 'save', id: this._job.id, key, body: text, base: doc.revisionId })
        this.actions.toast(`${doc.title} saved`)
        this.openJob(this._job.id)
      } catch (err) {
        this.actions.toast(err.message || 'The document was not saved', 'err')
      }
    })
  }

  async _docHistory(key) {
    const el = this._docBox(key)?.querySelector('[data-part="doc-history"]')
    if (!el) return
    el.innerHTML = '<p class="none">Reading…</p>'
    try {
      const { revisions } = await call(`/api/studio/job/document?id=${encodeURIComponent(this._job.id)}&key=${encodeURIComponent(key)}`)
      el.innerHTML = docHistory(key, revisions)
    } catch (err) {
      el.innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
  }

  _docRestore(key, revision, number) {
    const doc = this._job?.documents.find((d) => d.key === key)
    if (!doc) return
    this._confirmAsk(`<b>Restore version ${esc(number)} of “${esc(doc.title)}”?</b> It is saved as a new version; nothing is lost.`, 'Restore', async () => {
      try {
        await call('/api/studio/document', { action: 'restore', id: this._job.id, key, revision })
        this.actions.toast(`${doc.title} restored`)
        this.openJob(this._job.id)
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  /** Answer a question on the open job: a choice from its form, or a yes or no. */
  async _answerJobCard(id, verb, form) {
    const card = this._jobCards?.get(id)
    if (!card || !this._job || this._answering || verb === 'open') return
    let answers
    if (verb === 'respond') {
      answers = answersFrom(form, card.question.items)
      if (!answers) return this.actions.toast('Pick an answer or write one first', 'err')
    }
    this._answering = true
    try {
      await call('/api/studio/card', { chat: this._job.id, card: id, verb, answers })
      this.actions.toast('Answer sent')
      this.actions.refresh()
      this.openJob(this._job.id)
    } catch (err) {
      this.actions.toast(err.message || 'The answer was not sent', 'err')
    }
    this._answering = false
  }

  async _comment() {
    const form = this.sheet.querySelector('form.comment')
    if (!form?.reportValidity() || !this._job) return
    try {
      await call('/api/studio/job', { action: 'comment', id: this._job.id, text: form.elements.text.value.trim() })
      this.actions.toast('Comment added')
      this.openJob(this._job.id)
    } catch (err) {
      this.actions.toast(err.message || 'The comment was not added', 'err')
    }
  }

  /** Every job: a pile, a project, a bot, words, a page at a time. */
  openJobs(filter = null) {
    if (filter) this._jobs = { filter: { pile: 'active', project: '', bot: '', q: '', ...filter }, page: 0 }
    this._openSheet('jobs', 'Jobs', 'Every job the crew has had, newest first', { wide: true })
    this._reopen = () => this.openJobs()
    this._loadJobs(!filter)
  }

  _loadJobs(focus = false) {
    const col = this._colOf('jobs')
    if (!col) return
    this.cur = col
    const { filter, page } = this._jobs
    const seq = ++this._sheetSeq
    const q = new URLSearchParams({ pile: filter.pile, page: String(page), ...(filter.project ? { project: filter.project } : {}), ...(filter.bot ? { bot: filter.bot } : {}), ...(filter.q ? { q: filter.q } : {}) })
    this._fill('jobs', seq, () => call(`/api/studio/jobs?${q}`), (data) => jobsScreen({ filter, data })).then((data) => {
      if (data && focus) this._colOf('jobs')?.el.querySelector('input.search')?.focus()
    })
  }

  // ── connectors ───────────────────────────────────────────────────────────────────────

  /** The services the crew may use and the sign-ins of the engines the bots run on. */
  async openConnectors({ q = this._connectQ || '' } = {}) {
    this._connectQ = q
    if (this.screen !== 'connectors') this._openSheet('connectors', 'Connectors', 'Services the crew may use, and the sign-ins the bots run on', { wide: true })
    this._reopen = () => this.openConnectors()
    const seq = ++this._sheetSeq
    const d = await this._fill('connectors', seq, () => call('/api/studio/connectors'), (data) => connectorsScreen(data, { q }))
    if (d) this._connectors = d
    if (q) { const box = this._colOf('connectors')?.el.querySelector('input.search'); box?.focus(); box?.setSelectionRange(q.length, q.length) }
  }

  async openConnector(id) {
    this._openSheet('connector', 'Connector', '', { wide: true })
    this._reopen = () => this.openConnector(id)
    const seq = ++this._sheetSeq
    const d = await this._fill('connector', seq, () => call('/api/studio/connectors'), (data) => {
      const c = data.connectors.find((x) => x.id === id)
      return c ? connectorScreen(c) : '<p class="none">That connector was removed.</p>'
    })
    const c = d?.connectors.find((x) => x.id === id)
    const col = this._colOf('connector')
    if (!c || !col) return
    this._connector = c
    col.el.querySelector('.col-head strong').textContent = c.name
    col.el.querySelector('.col-head p').textContent = c.about || c.stateWords
  }

  openConnectorNew(from) {
    const app = this._connectors?.catalogue.find((a) => a.id === from) || null
    const body = this._openSheet('connector-new', app ? `Add ${app.name}` : 'Add a service', app ? 'How you sign in to it' : 'Any service with an MCP server', { wide: true })
    this._reopen = () => this.openConnectorNew(from)
    body.innerHTML = connectorNewScreen(app)
    body.querySelector('input')?.focus()
  }

  async _connectorAdd(input) {
    if (this._connecting) return
    this._connecting = true
    // Whose account it is, asked once on the page that adds it: the owner's own unless they say otherwise.
    const owner = this._colOf('connector-new')?.el.querySelector('input[name="owner"]:checked')?.value || input.owner || 'own'
    try {
      const made = await call('/api/studio/connector', { action: 'add', ...input, owner })
      this.openConnector(made.id)
      this._refreshConnectorList()
      if (made.state === 'signed-out') await this._connectorSignIn(made.id)
      else this.actions.toast(`${made.name} is added. Choose who may use it`)
    } catch (err) {
      this.actions.toast(err.message || 'It was not added', 'err')
    }
    this._connecting = false
  }

  /** The service's own sign-in page in a new tab; this page reads the connector again when the tab reports back or the owner returns. */
  async _connectorSignIn(id) {
    // Opened at the click, before the address is known: a tab opened later would be blocked as a pop-up.
    const tab = window.open('about:blank', '_blank')
    try {
      const { url } = await call('/api/studio/connector', { action: 'signin', id })
      if (tab) tab.location = url
      else window.location.assign(url)
      const back = () => { if (this.screen === 'connector' && this._connector?.id === id) this.openConnector(id); this._refreshConnectorList() }
      const told = (e) => { if (e.data && 'studioConnector' in e.data) { window.removeEventListener('message', told); back() } }
      window.addEventListener('message', told)
      window.addEventListener('focus', back, { once: true })
      this.openConnector(id)
    } catch (err) {
      tab?.close()
      this.actions.toast(err.message || 'The sign-in page could not be opened', 'err')
    }
  }

  _refreshConnectorList() {
    const A = this.cols.a
    if (A.screen === 'connectors' && !A.el.hidden) call('/api/studio/connectors').then((d) => { this._connectors = d; if (A.screen === 'connectors') A.el.querySelector('.sheet-body').innerHTML = connectorsScreen(d, { q: this._connectQ || '' }); this._applyPick() }).catch(() => {})
  }

  /** Who may use it and which changing tools are allowed, saved as soon as it is changed. */
  async _connectorAccess() {
    const col = this._colOf('connector')
    const c = this._connector
    if (!col || !c) return
    const bots = Object.fromEntries(c.bots.map((b) => [b.id, col.el.querySelector(`input[data-bot="${CSS.escape(b.id)}"]:checked`)?.value || 'off']))
    const writes = [...col.el.querySelectorAll('input[data-part="connector-write"]:checked')].map((i) => i.value)
    const owner = col.el.querySelector('input[data-part="connector-owner"]:checked')?.value || c.owner
    try {
      this._connector = await call('/api/studio/connector', { action: 'access', id: c.id, bots, writes, owner })
      const count = col.el.querySelector('h3 small')
      if (count) count.textContent = `${writes.length} of ${c.changes} allowed`
      this.actions.toast('Saved. It reaches each bot at its next run')
      this._refreshConnectorList()
    } catch (err) {
      this.actions.toast(err.message || 'That was not saved', 'err')
      this.openConnector(c.id)
    }
  }

  /** The Connectors screens' own buttons. @returns {boolean} whether it was one */
  _connectAct(el) {
    const { act, id } = el.dataset
    if (act === 'open-connector') { this._go(() => this.openConnector(id)); return true }
    if (act === 'connector-new') { this._go(() => this.openConnectorNew(el.dataset.from)); return true }
    if (act === 'connector-add') { this._connectorAdd({ from: el.dataset.from, how: el.dataset.how }); return true }
    if (act === 'connector-signin') { this._connectorSignIn(id); return true }
    if (act === 'connector-check') {
      el.disabled = true
      call('/api/studio/connector', { action: 'check', id }).then(() => this.actions.toast('Checked')).catch((err) => this.actions.toast(err.message, 'err')).finally(() => { this.openConnector(id); this._refreshConnectorList() })
      return true
    }
    if (act === 'connector-remove') {
      this._confirmAsk(`Remove ${this._connector?.name || 'this connector'}? Its key is deleted from this computer and every bot loses it.`, 'Remove it', async () => {
        await call('/api/studio/connector', { action: 'remove', id })
        this.actions.toast('Removed')
        this._closeCol(this.cols.b)
        this._refreshConnectorList()
      })
      return true
    }
    return false
  }

  // ── routines and timers ──────────────────────────────────────────────────────────

  /** Work that starts by itself, and the crew's own timers on this computer. */
  async openRoutines({ adding = false } = {}) {
    if (this.screen !== 'routines') this._openSheet('routines', 'Routines', 'Work that starts by itself, and the helpers that keep the crew moving', { wide: true })
    this._reopen = () => this.openRoutines()
    const seq = ++this._sheetSeq
    const m = this.view.manager
    const [routines, timers] = await Promise.all([
      call('/api/studio/routines').then((r) => r.routines),
      call('/api/studio/timers').then((r) => r.timers).catch(() => []),
    ]).catch((err) => { this.actions.toast(err.message, 'err'); return [null, null] })
    const col = this._colOf('routines')
    if (!col || seq !== col.seq) return
    if (!routines) { col.el.querySelector('.sheet-body').innerHTML = '<p class="none">The routines could not be read.</p>'; return }
    col.el.querySelector('.sheet-body').innerHTML = routinesScreen(routines, timers, { adding, crew: m.bots, projects: m.projects })
    if (adding) this.deck.querySelector('[data-part="routine-add"] input')?.focus()
    this._loadHelpers()
  }

  async openRoutine(id) {
    this._openSheet('routine', 'Routine', '', { wide: true })
    this._reopen = () => this.openRoutine(id)
    const seq = ++this._sheetSeq
    const m = this.view.manager
    const r = await this._fill('routine', seq, () => call(`/api/studio/routine?id=${encodeURIComponent(id)}`), (page) => routineScreen(page, { crew: m.bots, projects: m.projects }))
    const col = this._colOf('routine')
    if (!r || !col) return
    this._routinePage = r
    col.el.querySelector('.col-head strong').textContent = r.title
    col.el.querySelector('.col-head p').textContent = [r.bot, r.project, r.when].filter(Boolean).join(', ')
  }

  async _routine(id, action) {
    try {
      await call('/api/studio/routine', { id, action })
      this.actions.toast(action === 'run' ? 'Started' : action === 'pause' ? 'Paused' : 'Resumed')
      this._reopen?.()
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
  }

  async _addRoutine(form) {
    if (!form.reportValidity() || this._adding) return
    this._adding = true
    const field = (name) => form.elements[name].value.trim()
    try {
      await call('/api/studio/routine', { action: 'add', title: field('title'), description: field('description'), plan: readWhen(form), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', ...(field('botId') ? { botId: field('botId') } : {}), ...(field('projectId') ? { projectId: field('projectId') } : {}) })
      this.actions.toast('Routine added')
      this.openRoutines()
    } catch (err) {
      this.actions.toast(err.message || 'The routine was not added', 'err')
    }
    this._adding = false
  }

  _routineRemove(id) {
    const r = this._routinePage
    if (!r || r.id !== id) return
    this._confirmAsk(`<b>Remove the routine “${esc(r.title)}”?</b> It stops starting work. Jobs it already made stay.`, 'Remove it', async () => {
      try {
        await call('/api/studio/routine', { action: 'remove', id })
        this.actions.toast(`${r.title} is removed`)
        this._stack = []
        this.openRoutines()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  // ── the library ──────────────────────────────────────────────────────────────────

  openLibrary(shelf = this._shelf || 'made') {
    this._shelf = shelf
    this._openSheet('library', 'Library', shelf === 'skills' ? 'The skills the crew can be given' : 'What the crew made, newest first', { wide: true })
    this._reopen = () => this.openLibrary(shelf)
    const seq = ++this._sheetSeq
    if (shelf === 'skills') {
      this._fill('library', seq, () => call('/api/studio/skills'), ({ skills }) => { this._skills = skills; return skillsScreen(skills) })
      return
    }
    this._made = { items: [], next: '' }
    this._fill('library', seq, () => call('/api/studio/artifacts'), (page) => { this._made = { items: page.items, next: page.next }; return madeScreen(page.items, { more: Boolean(page.next) }) })
  }

  async _madeMore() {
    if (!this._made?.next) return
    const seq = ++this._sheetSeq
    await this._fill('library', seq, () => call(`/api/studio/artifacts?cursor=${encodeURIComponent(this._made.next)}`), (page) => {
      this._made = { items: [...this._made.items, ...page.items], next: page.next }
      return madeScreen(this._made.items, { more: Boolean(page.next) })
    })
  }

  async openSkill(id, file = null, { editing = false } = {}) {
    const skill = this._skills?.find((s) => s.id === id)
    if (!skill) return
    const path = file || (skill.files.includes('SKILL.md') ? 'SKILL.md' : skill.files[0])
    if (this.screen !== 'skill' || this._skill?.id !== id) this._openSheet('skill', skill.name, skill.editable ? 'A skill the crew may change' : skill.locked, { wide: true })
    this._reopen = () => this.openSkill(id, path)
    const seq = ++this._sheetSeq
    const body = this.sheet.querySelector('.sheet-body')
    body.innerHTML = skillScreen(skill, null)
    if (!path) { body.innerHTML = '<p class="none">This skill has no files.</p>'; return }
    const got = await this._fill('skill', seq, () => call(`/api/studio/skill/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`), (f) => skillScreen(skill, f, { editing: editing && f.editable && skill.editable }))
    if (got) this._skill = { id, skill, file: got }
  }

  _skillSave() {
    const s = this._skill
    const text = this.deck.querySelector('[data-part="skill-text"]')?.value
    if (!s || text == null) return
    if (text === s.file.content) return this.actions.toast('Nothing changed')
    this._confirmAsk(`<b>Change ${esc(s.file.path)} of the skill ${esc(s.skill.name)}?</b> ${esc(editSummary(s.file.content, text))}. Every bot given this skill reads it on its next run.`, 'Save the skill', async () => {
      try {
        await call('/api/studio/skill', { action: 'save', id: s.id, path: s.file.path, content: text })
        this.actions.toast(`${s.skill.name} saved`)
        this.openSkill(s.id, s.file.path)
      } catch (err) {
        this.actions.toast(err.message || 'The skill was not saved', 'err')
      }
    })
  }

  /** A screen by its id, from a room on the map or the dock: in column A, fresh. */
  openScreen(id) {
    if (id === 'manager') return this.show('attention')
    this._enter('a', () => this._screen(id))
  }

  _screen(id) {
    if (ownName(id)) return void this.openOwnPage(ownName(id))
    if (id === 'routines') return void this.openRoutines()
    if (id === 'setup') return void this.openSetup()
    if (id === 'connectors') return void this.openConnectors()
    if (id === 'bots') return void this.openBots()
    if (id === 'runs') return void this.openRuns()
    if (id === 'models') return void this.openMoney()
    if (id === 'improvements') return void this.openImprovements()
    if (id === 'library') return void this.openLibrary('made')
    const screen = this.view?.screens?.find((s) => s.id === id)
    if (!screen) return
    if (id === 'manager') {
      this.closeSheet()
      return this.show('attention')
    }
    // The dock's names, not the rooms': the same thing is called the same everywhere.
    const named = { settings: ['Settings', 'Claude limits, projects, the crew, phones and computers, the company'], chats: ['Chats', 'Every conversation with the crew, newest first'] }[id]
    const body = this._openSheet(id, named?.[0] || screen.room, named?.[1] || screen.does)
    this._reopen = () => this._screen(id)
    const load = id === 'chats' ? this._loadChats() : this._loadSettings()
    load.catch((err) => { if (this._colOf(id)) body.innerHTML = `<p class="none">${esc(err.message)}</p>` })
  }

  /** Close the right-most column that shows a screen: B, else A's screen. @returns {boolean} whether one closed */
  closeSheet() {
    const { a: A, b: B } = this.cols
    if (!B.el.hidden) { this._closeCol(B); return true }
    if (!A.el.hidden && A.screen) { this._closeCol(A); return true }
    return false
  }

  async _loadChats() {
    const { chats } = await call('/api/studio/chats')
    const col = this._colOf('chats')
    if (!col) return
    const rows = [...chats].sort((a, b) => Date.parse(b.lastActiveAt || 0) - Date.parse(a.lastActiveAt || 0))
    col.el.querySelector('.sheet-body').innerHTML = rows.map((c) => {
      const said = c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.text}` : 'Nothing said yet'
      return `<button class="chat-row" data-bot="${esc(c.id)}">
        ${this._face(c)}
        <span class="name">${esc(c.name)}</span><time>${c.lastActiveAt ? esc(since(Date.parse(c.lastActiveAt))) : ''}</time>
        <span class="said">${esc(said)}</span>
      </button>`
    }).join('') || '<p class="none">There is nobody to talk to yet.</p>'
  }

  async _loadSettings() {
    const g = await call('/api/studio/settings')
    const col = this._colOf('settings')
    if (!col) return
    col.el.querySelector('.sheet-body').innerHTML = `<form>
      <h3>Claude's week</h3>
      <p class="hint">The crew's Claude bots pause when this much of the weekly limit is used, and start again when it resets. The rest is yours.</p>
      <label>The crew stops at <span class="num"><input name="weekCeiling" type="number" min="50" max="100" step="1" value="${Math.round(g.weekCeiling * 100)}" required> %</span></label>
      <label>The lead stops at <span class="num"><input name="leadCeiling" type="number" min="50" max="100" step="1" value="${Math.round(g.leadCeiling * 100)}" required> %</span></label>
      <h3>Token limit</h3>
      <p class="hint">A second stop, counted in Claude tokens over 7 days. ${(g.used / 1e6).toFixed(1)} million used so far.</p>
      <label class="check"><input name="enabled" type="checkbox" ${g.enabled ? 'checked' : ''}> Pause the Claude bots at a token limit</label>
      <label>Limit <span class="num"><input name="limit" type="number" min="0" max="100000" step="1" value="${Math.round(g.limit / 1e6)}"> million</span></label>
      <button class="btn primary" type="submit">Save settings</button>
    </form>
    <h3>Projects</h3>
    <p class="hint">A project on the shelf gets no new work: The lead briefs nothing for it and gives the bots on free models nothing from it, until you take it off.</p>
    <div data-part="settings-projects"></div>
    <h3>Crew</h3>
    <div data-part="settings-crew"></div>
    <h3>Models, limits and money</h3>
    <p class="hint">Which model each bot runs on, the free models, Claude's pace and what the crew used have their own screen.</p>
    <div class="acts"><button class="btn" type="button" data-act="models">Open Models</button></div>
    <h3>Phones and computers</h3>
    <p class="hint">Each one has its own key to the studio. Removing one locks it out at once.</p>
    <div data-part="settings-devices"><p class="none">Reading…</p></div>
    <div class="acts"><button class="btn" type="button" data-act="first-open" data-step="phone">Pair a phone</button></div>
    <h3>Company</h3>
    <div data-part="settings-company"><p class="none">Reading…</p></div>`
    this._shelved = new Set(g.shelved || [])
    this._putSettingsCrew()
    this._loadDevices()
    this._loadCompany()
  }

  /**
   * The projects in the owner's order: the ranked ones first, as ranked, then any the ranking does
   * not name yet, in the order the crew lists them. Shelved ones stay where they are but hold no rank.
   */
  _rankedProjects() {
    const all = this.view?.manager?.projects || []
    return rankProjects(all, this._ranked || [])
  }

  /** Move a project up (by -1) or down (by +1) the ranking, and save the whole order. */
  async rank(name, by) {
    const live = this._rankedProjects().filter((p) => !this._shelved.has(p.name)).map((p) => p.name)
    const from = live.indexOf(name)
    const to = from + by
    if (from < 0 || to < 0 || to >= live.length) return
    live.splice(to, 0, live.splice(from, 1)[0])
    const before = this._ranked
    this._ranked = live
    this._rankTouched = true
    this._last.panel = null
    this._putPanel()
    try {
      const saved = await call('/api/studio/settings', { ranked: live })
      this._ranked = saved.ranked
      this.actions.toast(`${name} is now rank ${to + 1}. The lead is told within half an hour.`)
    } catch (err) {
      this._ranked = before
      this.actions.toast(err.message || 'That did not work', 'err')
    }
    this._last.panel = this._last.project = null
    this._putPanel()
    this._putProject()
    if (this._colOf('settings')) this._putSettingsCrew()
  }

  /** Put a project on the shelf, or take it off. */
  async shelve(name) {
    const shelved = new Set(this._shelved)
    if (!shelved.delete(name)) shelved.add(name)
    try {
      const saved = await call('/api/studio/settings', { shelved: [...shelved] })
      this._shelved = new Set(saved.shelved)
      this._shelfTouched = true
      this._last.panel = this._last.project = null
      this._putPanel()
      this._putProject()
      this.actions.toast(this._shelved.has(name) ? `${name} is on the shelf. The lead is told within half an hour.` : `${name} is active again`)
      this._putSettingsCrew()
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
  }

  _putSettingsCrew() {
    const el = this.deck.querySelector('[data-part="settings-crew"]')
    if (!el || !this.view) return
    const shelf = this._shelved || new Set()
    this._put('sheet-projects', this.deck.querySelector('[data-part="settings-projects"]'), this._rankedProjects().map((p) => {
      const on = shelf.has(p.name)
      const c = this._bayCounts().get(p.name) || {}
      const work = [c.build && `${c.build} building`, c.check && `${c.check} checking`, c.wait && `${c.wait} waiting`, c.stop && `${c.stop} stopped`, c.you && `${c.you} ${c.you === 1 ? 'needs' : 'need'} you`].filter(Boolean).join(', ') || 'No open jobs'
      return `<div class="crew-row project ${on ? 'paused' : ''}">
        <span class="name">${esc(p.name)}</span>
        <span class="said">${on ? 'On the shelf' : esc(work)}</span>
        <button class="btn ghost" type="button" data-act="shelve" data-project="${esc(p.name)}" aria-pressed="${on}">${on ? 'Make active' : 'Shelve'}</button>
      </div>`
    }).join('') || '<p class="none">No projects yet.</p>')
    this._put('sheet', el, this.view.manager.bots.map((b) => `<div class="crew-row ${esc(b.status)}">
      ${this._face(b)}
      <span class="name">${esc(b.name)}</span>
      <span class="said">${esc(b.status === 'paused' ? b.why || 'Paused' : BOT_STATE[b.status] || b.status)}</span>
      <button class="btn ghost" type="button" data-act="pause" data-bot="${esc(b.id)}">${b.status === 'paused' ? 'Resume' : 'Pause'}</button>
    </div>`).join(''))
  }

  async _loadModels() {
    const el = () => this.deck.querySelector('[data-part="settings-models"]')
    try {
      const m = await call('/api/studio/models')
      if (!el()) return
      const STATE = { answering: 'Answering', out: 'Set aside', unchecked: 'Not checked yet', failing: 'Failing' }
      el().innerHTML = `<p class="hint">${esc(m.health.text)}</p>
        <div class="said"><details><summary>Free models (${m.free.filter((f) => f.state === 'answering').length} of ${m.free.length} answering)</summary><div class="table"><table><thead><tr><th>Model</th><th>Now</th><th>Coding test</th></tr></thead><tbody>${m.free.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(STATE[f.state] || f.state)}</td><td>${f.pass != null ? `${f.pass} passed, ${f.fail} failed` : ''}</td></tr>`).join('')}</tbody></table></div>
        ${m.limits.map((l) => `<p class="hint"><b>${esc(l.provider)}:</b> ${esc(l.note)}</p>`).join('')}</details>
        ${m.switches.length ? `<details><summary>Latest switches</summary>${m.switches.slice(0, 8).map((x) => `<p class="event"><time>${clock(x.at * 1000)}</time>${esc(x.text)}</p>`).join('')}</details>` : ''}</div>`
    } catch (err) {
      if (el()) el().innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
  }

  async _loadDevices() {
    const el = () => this.deck.querySelector('[data-part="settings-devices"]')
    try {
      const { devices } = await call('/api/studio/devices')
      if (!el()) return
      el().innerHTML = devices.map((d) => `<div class="crew-row plain">
        <span class="name">${esc(d.name)}</span>
        <span class="said">${d.lastSeen ? `Last seen ${esc(since(Date.parse(d.lastSeen)))} ago` : 'Not seen yet'}</span>
        <button class="btn ghost" type="button" data-act="device" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button>
      </div>`).join('') || '<p class="none">No phone has a key yet.</p>'
    } catch (err) {
      if (el()) el().innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
  }

  /**
   * Who is in the company, open invites, the secrets it holds (names only) and the instance's
   * switches and backups. Read at a glance; inviting and taking an invite back ask first.
   */
  async _loadCompany() {
    const el = () => this.deck.querySelector('[data-part="settings-company"]')
    try {
      const c = await call('/api/studio/company')
      if (!el()) return
      const on = c.flags.filter((f) => f.on)
      const day = (at) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
      el().innerHTML = `<p class="hint"><b>${esc(c.name)}</b>${c.about ? ` · ${esc(c.about)}` : ''}${c.code ? ` · jobs are ${esc(c.code)}-…` : ''}</p>
        ${c.members.map((m) => `<div class="crew-row plain"><span class="name">${esc(m.name)}</span><span class="said">${esc(m.role)}${m.active ? '' : ', not active'}${m.email ? ` · ${esc(m.email)}` : ''}</span></div>`).join('')}
        ${c.invites.map((i) => `<div class="crew-row plain"><span class="name">Invite, ${esc(i.role || 'member')}</span><span class="said">Open${i.expires ? ` until ${esc(day(i.expires))}` : ''}</span><button class="btn ghost" type="button" data-act="invite-revoke" data-id="${esc(i.id)}">Take back</button></div>`).join('')}
        <div class="acts"><button class="btn" type="button" data-act="invite-add">Invite someone</button></div>
        <p class="hint">Secrets the crew can use, by name only (their values never leave this computer): ${c.secrets.length ? c.secrets.map((s) => `<b>${esc(s.name)}</b>`).join(', ') : 'none'}.</p>
        <p class="hint">Backups are kept ${c.backups.days} days daily, ${c.backups.weeks} weeks weekly and ${c.backups.months} month${c.backups.months === 1 ? '' : 's'} monthly.</p>
        <details class="flags"><summary>${on.length} of ${c.flags.length} experimental switches on</summary><p class="hint">${c.flags.map((f) => `${f.on ? '<b>' : ''}${esc(f.name)}${f.on ? '</b>' : ''}`).join(' · ')}</p></details>`
    } catch (err) {
      if (el()) el().innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
  }

  _invite() {
    this._confirmAsk('<b>Make an invite link for one person?</b> It lets whoever opens it join the company as a member, until it runs out or you take it back.', 'Make the link', async () => {
      try {
        const made = await call('/api/studio/invite', { action: 'add', role: 'member' })
        try { await navigator.clipboard.writeText(made.link) } catch { /* the toast still shows it */ }
        this.actions.toast(`Invite link copied: ${made.link}`)
        this._loadCompany()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  _takeBackInvite(id) {
    this._confirmAsk('<b>Take this invite back?</b> Its link stops working at once.', 'Take it back', async () => {
      try {
        await call('/api/studio/invite', { action: 'revoke', id })
        this.actions.toast('Invite taken back')
        this._loadCompany()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  _revoke(id, name) {
    this._confirmAsk(`<b>Remove ${esc(name)}?</b> It can no longer reach the studio until it is paired again.`, 'Remove it', async () => {
      try {
        await call('/api/studio/device', { action: 'revoke', id })
        this.actions.toast(`${name} removed`)
        this._loadDevices()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  async _saveSettings() {
    const form = this.sheet.querySelector('form')
    if (!form?.reportValidity()) return
    const value = (name) => Number(form.elements[name].value)
    try {
      const saved = await call('/api/studio/settings', {
        weekCeiling: value('weekCeiling') / 100, leadCeiling: value('leadCeiling') / 100,
        enabled: form.elements.enabled.checked, limit: value('limit') * 1e6,
      })
      // The server may have corrected a number: show what it kept.
      form.elements.weekCeiling.value = Math.round(saved.weekCeiling * 100)
      form.elements.leadCeiling.value = Math.round(saved.leadCeiling * 100)
      this.actions.toast('Settings saved')
    } catch (err) {
      this.actions.toast(err.message || 'The settings were not saved', 'err')
    }
  }

  // ── names over the crew ──────────────────────────────────────────────────────────

  /**
   * Called every frame with the agents and a way to find one on screen. A name sits under its
   * bot's feet, where the status badge over its head never covers it. Ten transforms
   * a frame, written only when a tag has moved a whole pixel.
   */
  placeTags(agents, screenOf) {
    if (!this.on) return
    const seen = new Set()
    for (const agent of agents) {
      const thread = agent.thread
      const crew = thread?.crew || (thread?.screen && { id: thread.id, status: 'screen', name: thread.title })
      if (!crew || agent.state === 'gone') continue
      seen.add(agent.id)
      let tag = this._tags.get(agent.id)
      if (!tag) {
        tag = { el: document.createElement('span'), x: -1, y: -1, text: '', shown: true }
        this.tagLayer.appendChild(tag.el)
        this._tags.set(agent.id, tag)
      }
      const face = thread.crew ? this._face(crew) : ''
      // Under the name, what the bot is on: the map answers "who is doing what" without a click.
      const doing = !thread.crew ? 'Click to open'
        : crew.job ? (/[A-Z]+-\d+/.test(crew.job.stage) ? crew.job.stage : `${crew.job.stage} ${crew.job.ref}`)
        : crew.status === 'paused' ? (crew.resting ? crew.why : 'Paused') : crew.status === 'error' ? 'Stopped on an error' : crew.last ? `Free, last on ${crew.last.ref}` : 'Free'
      const text = `${crew.status}|${crew.name}|${face}|${doing}`
      if (tag.text !== text) {
        tag.text = text
        tag.el.className = `tag ${crew.status}`
        tag.el.style.cssText = botStyle(crew.name)
        tag.el.innerHTML = `${face}<span><b>${esc(crew.name)}</b><small>${esc(doing || '')}</small></span>`
        tag.size = null
      }
      // Which name wins where two meet: a bot stopped on an error, then one at work, then the rest.
      tag.rank = crew.status === 'error' ? 0 : crew.status === 'running' ? 1 : thread.crew ? 2 : 3
      const at = agent.scale > 0.4 ? screenOf(agent, -0.12) : null
      const head = at ? screenOf(agent, 1.5 * (agent.thread?.size || 1)) : null
      tag.lift = head ? Math.round(head.y - at.y) : 0
      if (!at) {
        if (tag.shown) { tag.shown = false; tag.el.style.display = 'none' }
        continue
      }
      const x = Math.round(at.x), y = Math.round(at.y)
      if (!tag.shown) { tag.shown = true; tag.el.style.display = '' }
      if (x !== tag.x || y !== tag.y) {
        tag.x = x; tag.y = y
        tag.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`
      }
    }
    for (const [id, tag] of this._tags) {
      if (seen.has(id)) continue
      tag.el.remove()
      this._tags.delete(id)
    }
    this._untangleTags()
  }

  /**
   * Names on the map never sit on each other: where two meet, the one that matters less folds to its face
   * (its name shows again when there is room, and on hover). Sizes are measured once per change of text.
   */
  _untangleTags() {
    const shown = [...this._tags.values()].filter((t) => t.shown).sort((a, b) => a.rank - b.rank)
    // A bay's sign stays whole: a name that would lie across one folds to its face.
    const placed = [...(this._boards?.values() || [])].filter((b) => b.box).map((b) => b.box)
    for (const tag of shown) {
      if (!tag.size) {
        tag.el.classList.remove('tucked')
        tag.size = { w: tag.el.offsetWidth, h: tag.el.offsetHeight }
      }
      const box = { l: tag.x - tag.size.w / 2, r: tag.x + tag.size.w / 2, t: tag.y, b: tag.y + tag.size.h }
      const hit = placed.some((o) => box.l < o.r - 4 && box.r > o.l + 4 && box.t < o.b - 2 && box.b > o.t + 2)
      if (tag.tucked !== hit) { tag.tucked = hit; tag.el.classList.toggle('tucked', hit) }
      const lift = hit ? tag.lift : 0
      if (tag.lifted !== lift) { tag.lifted = lift; tag.el.style.marginTop = lift ? `${lift - 30}px` : '' }
      if (!hit) placed.push(box)
    }
  }

  // ── the bays' boards ─────────────────────────────────────────────────────────────

  /**
   * What each bay's board says, by project name: how many of its jobs are being built, are being
   * checked, wait their turn, and wait for the owner. Counted from the pipeline's own lines and
   * from "Needs you", so the map and the lists can never tell two stories.
   */
  _bayCounts() {
    const m = this.view?.manager
    if (!m) return new Map()
    const counts = new Map()
    const of = (name) => counts.get(name) || counts.set(name, { build: 0, check: 0, wait: 0, stop: 0, you: 0 }).get(name)
    for (const p of m.projects) of(p.name)
    for (const line of m.lines) {
      if (!line.project) continue
      const c = of(line.project)
      if (line.stage === 'build') c.build++
      else if (line.stage === 'check' || line.stage === 'ruling') c.check++
      else if (line.stage === 'queued' || line.stage === 'built') c.wait++
      // Stopped with nothing to replace it, or failed its check with no fix begun: nobody has it.
      else if (line.stage === 'stopped' || line.stage === 'fix') c.stop++
    }
    // What waits for the owner is exactly what "Needs you" lists: on its job's bay, or, when it is
    // not about a job (a question in a chat), on the bay the asking bot stands in, else the depot.
    const depot = this.view.depot
    for (const need of this._needs || []) {
      if (need.archived) continue
      const asker = m.bots.find((b) => b.id === need.botId)
      const home = need.project || (asker?.job && m.projects.find((p) => p.id === asker.projectId)?.name) || depot
      if (home) of(home).you++
    }
    return counts
  }

  /**
   * The boards over the bays: a sign plate with the project's name and, under it, its work as
   * painted tags. Placed against the frame just drawn, like the crew's names.
   * @param plots the floor's bays, each with `name`, `accent` and its `corners` in world space
   * @param project world point to page pixels, or null when it is behind the camera
   * @param gate where the yard's own name plate hangs
   */
  placeBoards(plots, project, gate) {
    if (!this.on) return
    const counts = this._bayCounts()
    const depot = this.view?.depot
    const seen = new Set()
    const put = (id, html, cls, x, y, accent, wide) => {
      seen.add(id)
      let board = this._boards.get(id)
      if (!board) {
        board = { el: document.createElement('div'), x: -1, y: -1, html: '', cls: '' }
        this.tagLayer.appendChild(board.el)
        this._boards.set(id, board)
      }
      const redrawn = board.html !== html || board.cls !== cls
      if (board.html !== html) { board.html = html; board.el.innerHTML = html }
      if (board.cls !== cls) { board.cls = cls; board.el.className = cls }
      // Measured once per change of words, never per frame.
      if (redrawn) board.size = { w: board.el.offsetWidth, h: board.el.offsetHeight }
      if (accent && board.accent !== accent) { board.accent = accent; board.el.style.setProperty('--bay', accent) }
      // Tags keep to their own bay's width and stack, so a long row never reaches the next bay's sign.
      const room = Math.max(150, Math.round(wide || 0))
      if (board.room !== room) { board.room = room; board.el.style.maxWidth = `${room}px`; board.size = { w: board.el.offsetWidth, h: board.el.offsetHeight } }
      if (x !== board.x || y !== board.y) {
        board.x = x; board.y = y
        board.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -34px)`
      }
      board.box = { l: x - board.size.w / 2, r: x + board.size.w / 2, t: y - 34, b: y - 34 + board.size.h }
    }
    for (const plot of plots) {
      let top = Infinity, left = Infinity, right = -Infinity, behind = false
      for (const corner of plot.corners || []) {
        const at = project(corner)
        if (!at) { behind = true; break }
        top = Math.min(top, at.y); left = Math.min(left, at.x); right = Math.max(right, at.x)
      }
      if (behind || top === Infinity) continue
      const width = right - left
      const c = counts.get(plot.name)
      const tag = (kind, n, word) => (n ? `<b class="t ${kind}">${n} ${word}</b>` : '')
      const isDepot = plot.name === depot
      let tags
      if (isDepot) {
        const free = this.view.manager.bots.filter((b) => !b.job && b.status !== 'paused').length
        tags = `<b class="t none">${free ? `${free} free ${free === 1 ? 'bot waits' : 'bots wait'} here` : 'Free bots wait here'}</b>`
          + (c?.you ? `<button type="button" class="t you" data-bay-you="${esc(plot.name)}" title="Open what waits for you">${c.you} ${c.you === 1 ? 'needs' : 'need'} you</button>` : '')
      } else if (this._shelved?.has(plot.name)) {
        // A shelved bay says so in small type; the lead gives nobody work there, so no work tags.
        tags = `<b class="t shelved" title="On the shelf: nothing is given out here until you take it off">\u{1F512} SHELVED</b>`
          + (c?.you ? `<button type="button" class="t you" data-bay-you="${esc(plot.name)}" title="Open what waits for you in ${esc(plot.name)}">${c.you} ${c.you === 1 ? 'needs' : 'need'} you</button>` : '')
      } else if (!c) tags = ''
      else {
        // What waits for the owner comes first, so it is never the tag that wraps out of sight.
        tags = (c.you ? `<button type="button" class="t you" data-bay-you="${esc(plot.name)}" title="Open what waits for you in ${esc(plot.name)}">${c.you} ${c.you === 1 ? 'needs' : 'need'} you</button>` : '')
          + tag('stop', c.stop, 'stopped') + tag('build', c.build, 'building') + tag('check', c.check, 'checking') + tag('wait', c.wait, 'waiting')
        if (!tags) tags = `<b class="t none">No open jobs</b><button type="button" class="t add" data-bay-job="${esc(plot.name)}">New job</button>`
      }
      const html = `<button type="button" class="name" data-bay="${esc(plot.name)}" title="${isDepot ? 'Open the crew' : `Open ${esc(plot.name)}`}"><i></i>${esc(plot.name)}</button><span class="tags">${tags}</span>`
      const accent = '#' + plot.accent.toString(16).padStart(6, '0')
      put(plot.name, html, `bay${c?.you ? ' you' : ''}${isDepot || !this._shelved?.has(plot.name) ? '' : ' shelved'}${width < 150 ? ' far' : ''}`, Math.round((left + right) / 2), Math.round(top) - 4, accent, width)
    }
    // Two signs never lie across each other: where they would, the one with nothing for the owner
    // keeps its name and drops its tags until there is room again.
    const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
    const boards = [...seen].map((id) => this._boards.get(id)).sort((a, b) => b.cls.includes(' you') - a.cls.includes(' you') || a.y - b.y)
    const kept = []
    for (const board of boards) {
      if (kept.some((o) => hits(board.box, o)) && !board.cls.includes(' far')) {
        board.cls += ' far'
        board.el.className = board.cls
        board.size = { w: board.el.offsetWidth, h: board.el.offsetHeight }
        board.box = { l: board.x - board.size.w / 2, r: board.x + board.size.w / 2, t: board.y - 34, b: board.y - 34 + board.size.h }
      }
      kept.push(board.box)
    }
    const at = gate && this.view?.yard ? project(gate) : null
    // An empty yard says so at its gate, with the one thing to do next.
    const nextStep = this._first?.left?.[0]
    const empty = !plots.length ? `<span class="tags"><b class="t none">Nothing in the yard yet</b><button type="button" class="t add" data-yard-next="${esc(nextStep || 'project')}">${nextStep ? 'Set up your yard' : 'Add a project'}</button></span>` : ''
    if (at) put('\u0000gate', `<span class="name gate">${esc(this.view.yard)}</span>${empty}`, 'bay yard', Math.round(at.x), Math.round(at.y) + 17)
    for (const [id, board] of this._boards) {
      if (seen.has(id)) continue
      board.el.remove()
      this._boards.delete(id)
    }
  }

  // ── talking to a bot ─────────────────────────────────────────────────────────────

  _bot(id = this.chatBot) {
    return this.view?.manager.bots.find((b) => b.id === id) || null
  }

  _syncChatHead() {
    const bot = this._bot()
    if (!bot) return
    const paused = bot.status === 'paused'
    this._put('chat-face', this.chat.querySelector('.portrait'), this._face(bot))
    this._put('chat-head', this.chat.querySelector('.who'), `<strong>${esc(bot.name)}</strong><span>${esc([bot.title, bot.model].filter(Boolean).join(', '))}</span>`)
    this.chat.querySelector('header').className = bot.status
    this.chat.style.cssText = botStyle(bot.name)
    const button = this.chat.querySelector('[data-act="pause"]')
    button.textContent = paused ? 'Resume' : 'Pause'
    const doing = bot.job
      ? `${bot.job.stage} ${bot.job.ref} ${bot.job.title}${bot.job.minutes ? `, ${bot.job.minutes} min in` : ''}`
      : bot.why || `${BOT_STATE[bot.status] || bot.status}${bot.last ? `. Last on ${bot.last.ref} ${bot.last.title}, ${since(bot.last.at)} ago` : ''}`
    this._put('chat-doing', this.chat.querySelector('.doing'), esc(doing))
  }

  /** Open the drawer on one bot of the crew. */
  openChat(botId) {
    if (!this.on) return
    if (this.chatBot !== botId) {
      this.chatBot = botId
      this._last.talk = null
      this.talk.innerHTML = '<p class="none">Reading the conversation…</p>'
      this.input.value = ''
      this._clearPictures()
    }
    this.chat.hidden = false
    this.root.classList.add('studio-chatting')
    if (this.view) this._putCrew()
    this._syncChatHead()
    this._loadChat()
  }

  focus() {
    this.input.focus()
  }

  /** The question the owner opened from Needs you: brought into view in the chat and marked. */
  _showFocusCard() {
    const id = this._focusCard
    if (!id) return
    const card = this.talk.querySelector(`.waiting-cards [data-card="${CSS.escape(id)}"]`) || this.talk.querySelector('.waiting-cards [data-card]')
    if (!card) return
    this._focusCard = null
    card.scrollIntoView({ block: 'nearest' })
    card.classList.remove('flash')
    void card.offsetWidth
    card.classList.add('flash')
    card.querySelector('input, textarea')?.focus({ preventScroll: true })
  }

  closeChat() {
    if (!this.chatBot) return false
    this.chatBot = null
    this.chat.hidden = true
    this.root.classList.remove('studio-chatting')
    clearTimeout(this._chatTimer)
    if (this.view) this._putCrew()
    return true
  }

  async _loadChat() {
    clearTimeout(this._chatTimer)
    const bot = this.chatBot
    if (!bot) return
    const seq = ++this._chatSeq
    try {
      const chat = await call(`/api/studio/chat?bot=${encodeURIComponent(bot)}`)
      if (seq !== this._chatSeq || bot !== this.chatBot) return
      this._chatId = chat.chatId
      this._chatCards = new Map((chat.cards || []).map((c) => [c.id, c]))
      // Messages and the cards a bot put between them, in the order they happened.
      // A question still waiting stays pinned at the top until it is answered, so no later message buries
      // it (the owner, 12 November 2026); where it was asked, the conversation keeps a line pointing up.
      const waiting = (chat.cards || []).filter((c) => c.state === 'pending')
      const parts = [
        ...chat.messages.map((m) => ({ at: Date.parse(m.at), html: `<div class="msg ${m.mine ? 'mine' : ''}"><span class="from">${esc(m.mine ? 'You' : m.from)} <time>${clock(m.at)}</time></span>${pictureStrip(m.pictures)}${m.text ? `<div class="said">${markdown(m.text, { jobs: true })}</div>` : ''}</div>` })),
        ...(chat.cards || []).map((c) => ({ at: Date.parse(c.at), html: c.state === 'pending'
          ? `<button type="button" class="asked-here" data-act="to-card" data-id="${esc(c.id)}">Asked here: ${esc(c.title)}. It waits at the top.</button>`
          : this._card(c) })),
      ].sort((a, b) => a.at - b.at)
      const pinnedCards = waiting.length
        ? `<section class="waiting-cards" aria-label="Waiting for your answer"><p class="waiting-head">Waiting for your answer${waiting.length > 1 ? ` (${waiting.length})` : ''}</p>${waiting.map((c) => this._card(c)).join('')}</section>`
        : ''
      const html = parts.length
        ? pinnedCards + parts.map((p) => p.html).join('')
          + (chat.working ? '<p class="typing">Writing an answer…</p>' : '')
        : '<p class="none">Nothing said yet. Write what you want done; the bot answers here.</p>'
      if (this._last.talk !== html) {
        // Stay at the bottom only if the reader was already there: scrolling back is reading.
        const pinned = this.talk.scrollHeight - this.talk.scrollTop - this.talk.clientHeight < 40 || this._last.talk == null
        this._last.talk = html
        // A typed answer not yet sent survives the next refresh of the conversation.
        const drafts = [...this.talk.querySelectorAll('textarea[name$="::other"]')].map((t) => [t.closest('[data-card]')?.dataset.card, t.name, t.value]).filter(([, , v]) => v)
        const checked = [...this.talk.querySelectorAll('.waiting-cards input:checked')].map((i) => [i.closest('[data-card]')?.dataset.card, i.name, i.value])
        this.talk.innerHTML = html
        for (const [card, name, value] of drafts) {
          const box = this.talk.querySelector(`[data-card="${CSS.escape(card || '')}"] textarea[name="${CSS.escape(name)}"]`)
          if (box) box.value = value
        }
        for (const [card, name, value] of checked) {
          const box = this.talk.querySelector(`[data-card="${CSS.escape(card || '')}"] input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`)
          if (box) box.checked = true
        }
        if (pinned) this.talk.scrollTop = this.talk.scrollHeight
      }
      this._showFocusCard()
    } catch (err) {
      if (seq === this._chatSeq && this._last.talk == null) this.talk.innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
    // A hidden page asks nothing; `wake` picks the conversation up again.
    if (bot === this.chatBot && !document.hidden) this._chatTimer = setTimeout(() => this._loadChat(), CHAT_MS)
  }

  /** A card in the conversation: one still waiting can be answered here, a settled one says how it ended. */
  _card(card) {
    const head = `<span class="from">${card.state === 'pending' ? 'Needs you' : card.state === 'done' ? 'Answered' : 'Withdrawn'} <time>${clock(card.at)}</time></span>`
    if (card.state !== 'pending') {
      return `<div class="card settled">${head}<p><b>${esc(card.title)}</b>${card.detail ? ` ${esc(card.detail)}` : ''}</p></div>`
    }
    if (card.kind === 'choice') {
      const items = card.question.items
      // Every question also takes an answer of the owner's own, typed in Other.
      return `<form class="card" data-card="${esc(card.id)}">${head}<p><b>${esc(card.title)}</b></p>${items.map((item) => `
        <fieldset>${item.prompt && item.prompt !== card.title ? `<legend>${esc(item.prompt)}</legend>` : ''}
          ${item.options.map((o) => `<label><input type="${item.multiple ? 'checkbox' : 'radio'}" name="${esc(item.id)}" value="${esc(o.id)}"><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`).join('')}
          <label class="other"><span><b>${item.options.length ? 'Other' : 'Your answer'}</b></span><textarea name="${esc(item.id)}::other" rows="2" placeholder="${item.options.length ? 'None of these? Write your own answer' : 'Write your answer'}"></textarea></label>
        </fieldset>`).join('')}
        <button class="btn primary" type="submit">Send answer</button>
      </form>`
    }
    if (card.kind === 'confirm') {
      return `<div class="card" data-card="${esc(card.id)}">${head}<p><b>${esc(card.title)}</b></p>${card.question.prompt ? `<p>${esc(card.question.prompt)}</p>` : ''}
        <div class="row"><button class="btn primary" data-verb="accept">${esc(card.question.accept)}</button><button class="btn ghost" data-verb="reject">${esc(card.question.reject)}</button></div></div>`
    }
    // A bot asked for a service: it is connected on the Connectors page, and the card is settled here.
    if (card.kind === 'connect') {
      return `<div class="card" data-card="${esc(card.id)}">${head}<p><b>${esc(card.title)}</b></p>${card.detail ? `<p>${esc(card.detail)}</p>` : ''}
        <p class="hint">Connect it on the Connectors page and choose who may use it. Then say so here, and the bot carries on.</p>
        <div class="row"><button class="btn primary" data-verb="connectors">Open Connectors</button><button class="btn" data-verb="connected">It is connected</button><button class="btn ghost" data-verb="not-connected">No</button></div></div>`
    }
    return `<div class="card" data-card="${esc(card.id)}">${head}<p><b>${esc(card.title)}</b></p>${card.detail ? `<p>${esc(card.detail)}</p>` : ''}
      <p class="hint">Answer it in a message below.</p></div>`
  }

  async _answerCard(id, verb, answers) {
    const card = this._chatCards?.get(id)
    if (!card || this._answering) return
    if (verb === 'connectors') return this.openScreen('connectors')
    this._answering = true
    try {
      await call('/api/studio/card', { chat: this._chatId, card: id, verb, answers, service: card.service })
      this.actions.toast('Answer sent')
      this._loadChat()
      this.actions.refresh()
    } catch (err) {
      this.actions.toast(err.message || 'The answer was not sent', 'err')
    }
    this._answering = false
  }

  /** The page came back into view. */
  wake() {
    if (this.chatBot) this._loadChat()
  }

  /** Pictures chosen for the next message, checked here first so a wrong one is named before it is sent. */
  async _addPictures(files) {
    for (const file of files) {
      if (!PICTURE_TYPES.includes(file.type)) { this.actions.toast(`${file.name || 'That file'} is not a picture Botyard can send. Use PNG, JPEG, WebP or GIF`, 'err'); continue }
      if (file.size > PICTURE_BYTES) { this.actions.toast(`${file.name || 'That picture'} is larger than 10 MB`, 'err'); continue }
      if (this._pictures.length >= MOST_PICTURES) { this.actions.toast(`A message carries at most ${MOST_PICTURES} pictures`, 'err'); break }
      // A pasted screenshot has no name of its own.
      const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${localStamp()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`
      const url = await thumbOf(file)
      if (!url) { this.actions.toast(`${file.name || 'That picture'} could not be read as a picture`, 'err'); continue }
      if (this._pictures.length >= MOST_PICTURES) break
      this._pictures.push({ file, name, url })
    }
    this._showTray()
    this.input.focus()
  }

  _showTray() {
    this.tray.hidden = !this._pictures.length
    this.tray.innerHTML = this._pictures.map((p, i) => `<figure><img src="${esc(p.url)}" alt="${esc(p.name)}"><button type="button" data-drop="${i}" title="Take this picture out" aria-label="Take ${esc(p.name)} out">${CLOSE_ICON}</button></figure>`).join('')
  }

  _clearPictures() {
    this._pictures = []
    if (this.tray) this._showTray()
  }

  async send() {
    const text = this.input.value.trim()
    const pictures = [...(this._pictures || [])]
    if ((!text && !pictures.length) || !this.chatBot || this._sending) return
    const bot = this.chatBot
    this._sending = true
    this.chat.classList.add('sending')
    try {
      // Each picture goes up first; the message then names them, so the bot sees them with the words.
      const ids = []
      for (const p of pictures) {
        p.id ||= (await upload(`/api/studio/chat/picture?bot=${encodeURIComponent(bot)}&name=${encodeURIComponent(p.name)}`, p.file)).id
        ids.push(p.id)
      }
      await call('/api/studio/chat', { bot, text, pictures: ids })
      this.input.value = ''
      if (this.chatBot === bot) this._clearPictures()
      await this._loadChat()
      this.talk.scrollTop = this.talk.scrollHeight
    } catch (err) {
      this.actions.toast(err.message || 'The message did not go', 'err')
    } finally {
      this._sending = false
      this.chat.classList.remove('sending')
    }
  }

  // ── bots, runs, models: the crew in full ─────────────────────────────────────────

  /** The sheet's own links and buttons for the crew screens. @returns {boolean} whether it was one */
  _crewAct(el) {
    const { act, id } = el.dataset
    if (act === 'back') { this._back(); return true }
    if (act === 'retry') { this._reopen?.(); return true }
    if (act === 'confirm-yes') { const yes = this._confirmFn; this._confirmAsk(null); yes?.(); return true }
    if (act === 'confirm-no') { this._confirmAsk(null); return true }
    if (act === 'open-bot') { this._go(() => this.openBot(id)); return true }
    if (act === 'open-run') { this._go(() => this.openRun(id)); return true }
    if (act === 'open-job') { this._go(() => this.openJob(id)); return true }
    if (act === 'models') { this._go(() => this.openMoney()); return true }
    if (act === 'improve-filter') { this._improve = el.dataset.status || ''; this.openImprovements(); return true }
    if (act === 'improve-reject-open') {
      const form = el.closest('.rec-acts, .rec-detail')?.querySelector('.imp-reject')
      if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input')?.focus() }
      return true
    }
    if (act === 'rec-toggle') { toggleRecord(el); return true }
    if (['improve-accept', 'improve-ask', 'improve-send', 'improve-reject-go'].includes(act)) {
      const action = { 'improve-accept': 'accept', 'improve-ask': 'ask', 'improve-send': 'send', 'improve-reject-go': 'reject' }[act]
      const reason = action === 'reject' ? (el.closest('.imp-reject')?.querySelector('input')?.value || '').trim() : ''
      if (action === 'reject' && !reason) { this.actions.toast('Say in one line why you reject it', 'err'); return true }
      this._improveDecide(id, action, reason)
      return true
    }
    if (act === 'bot-runs') { this._runs = { view: 'runs', filter: { bot: id, status: '' }, page: 0 }; this._go(() => this.openRuns()); return true }
    if (act === 'talk') { this.actions.pickBot(id); return true }
    if (act === 'runs-view') { this._runs.view = el.dataset.view; this._runs.page = 0; this._loadRuns(); return true }
    if (act === 'page') { this._runs.page += Number(el.dataset.by); this._loadRuns(); return true }
    if (act === 'reset') { this._resetBot(); return true }
    if (act === 'rollback') { this._rollback(id); return true }
    return false
  }

  /** The sheet's own links and buttons for the jobs, routines and library screens. @returns {boolean} whether it was one */
  _workAct(el) {
    const { act, id, key } = el.dataset
    if (act === 'jobs-pile') { this._jobs.filter.pile = el.dataset.pile; this._jobs.page = 0; this._loadJobs(); return true }
    if (act === 'jobs-page') { this._jobs.page = Math.max(0, this._jobs.page + Number(el.dataset.by)); this._loadJobs(); return true }
    if (act === 'job-edit') { this.openJob(this._job?.id, { editing: el.getAttribute('aria-pressed') !== 'true' }); return true }
    if (act === 'job-attach') { this.deck.querySelector('[data-part="attach"]')?.click(); return true }
    if (act === 'job-changes') { this._jobChanges(); return true }
    if (act === 'doc-edit') { this._docEdit(key); return true }
    if (act === 'doc-save') { this._docSave(key); return true }
    if (act === 'doc-cancel') { this.openJob(this._job?.id); return true }
    if (act === 'doc-history') { this._docHistory(key); return true }
    if (act === 'doc-restore') { this._docRestore(key, id, el.dataset.n); return true }
    if (act === 'open-routine') { this._go(() => this.openRoutine(id)); return true }
    if (act === 'routine-add') { this.openRoutines({ adding: !this.deck.querySelector('[data-part="routine-add"]') }); return true }
    if (act === 'routine-remove') { this._routineRemove(id); return true }
    if (act === 'shelf') { this._stack = []; this.openLibrary(el.dataset.shelf); return true }
    if (act === 'made-more') { this._madeMore(); return true }
    if (act === 'unclip') { el.previousElementSibling?.classList.remove('clip'); el.remove(); return true }
    if (act === 'open-skill') { this._go(() => this.openSkill(id)); return true }
    if (act === 'skill-edit') { this.openSkill(this._skill.id, this._skill.file.path, { editing: true }); return true }
    if (act === 'skill-cancel') { this.openSkill(this._skill.id, this._skill.file.path); return true }
    if (act === 'skill-save') { this._skillSave(); return true }
    return false
  }

  /** Open another sheet screen from this one, so Back returns here. */
  /** Open another screen from this one: from A it opens in B, beside it; from B one step deeper, so Back returns. */
  _go(open) {
    if (this.cur === this.cols.a) return this._enter('b', open)
    if (this.screen && this._reopen) this._stack.push(this._reopen)
    this._navigating = true
    try { open() } finally { this._navigating = false }
  }

  _back() {
    const open = this._stack.pop()
    if (!open) return
    this._navigating = true
    try { open() } finally { this._navigating = false }
    this._syncBack(this.cur)
  }

  /**
   * Ask before anything that changes a bot: the question sits at the foot of the sheet, with the
   * safe answer first. `null` takes it away.
   */
  _confirmAsk(text, yes = '', fn = null) {
    const bar = this.sheet?.querySelector('.sheet-confirm')
    if (!bar) return
    this._confirmFn = fn
    bar.hidden = !text
    if (!text) return
    bar.querySelector('p').innerHTML = text
    bar.querySelector('[data-act="confirm-yes"]').textContent = yes
    bar.querySelector('[data-act="confirm-no"]').focus()
  }

  /** Fill the open screen if it is still the one asked for. */
  async _fill(screen, seq, load, render) {
    const col = this.cur
    const body = col.el.querySelector('.sheet-body')
    try {
      const data = await load()
      if (col.screen !== screen || seq !== col.seq) return null
      body.innerHTML = render(data)
      if (col === this.cols.a) this._applyPick()
      return data
    } catch (err) {
      if (col.screen === screen && seq === col.seq) body.innerHTML = `<p class="none">${esc(err.message)}</p><div class="acts"><button class="btn" data-act="retry">Try again</button></div>`
      return null
    }
  }

  /** The live view of each bot by id: it knows the job a bot is on this minute. */
  _liveBots() {
    return new Map((this.view?.manager?.bots || []).map((b) => [b.id, b]))
  }

  openBots() {
    this._openSheet('bots', 'Crew', 'Who runs on what, and whose runs are wasted', { wide: true })
    this._reopen = () => this.openBots()
    const seq = ++this._sheetSeq
    this._fill('bots', seq, () => call('/api/studio/bots'), (list) => botsScreen(list, this._liveBots(), (b) => this._face(b)))
  }

  async openBot(id) {
    const known = this._liveBots().get(id)
    this._openSheet('bot', known?.name || 'Bot', known ? [known.title, known.model].filter(Boolean).join(', ') : '', { wide: true })
    this._reopen = () => this.openBot(id)
    const seq = ++this._sheetSeq
    const bot = await this._fill('bot', seq, () => call(`/api/studio/bot?id=${encodeURIComponent(id)}`), (b) => botScreen(b, this._liveBots().get(b.id)))
    const col = this._colOf('bot')
    if (!bot || !col) return
    this._botPage = bot
    // What the engine was too slow to give comes on a second read, in place, while the page stays open.
    if (bot.pending && !this._botRetry) {
      this._botRetry = setTimeout(() => {
        this._botRetry = 0
        const page = this._colOf('bot')
        if (page && this._botPage?.id === id) { this.cur = page; this._navigating = true; try { this.openBot(id) } finally { this._navigating = false } }
      }, 4000)
    }
    col.el.querySelector('.col-head strong').textContent = bot.name
    col.el.querySelector('.col-head p').textContent = [bot.title, `${bot.engine}${bot.model ? `, ${bot.model}` : ''}`].filter(Boolean).join(' · ')
  }

  openRuns() {
    this._openSheet('runs', 'Runs and activity', 'Every run across the crew, and who did what to which job', { wide: true })
    this._reopen = () => this.openRuns()
    this._loadRuns()
  }

  _loadRuns() {
    const col = this._colOf('runs')
    if (!col) return
    this.cur = col
    const { view, filter, page } = this._runs
    const seq = ++this._sheetSeq
    const q = new URLSearchParams({ page: String(page), ...(filter.bot ? { bot: filter.bot } : {}), ...(view === 'runs' && filter.status ? { status: filter.status } : {}) })
    // The activity page needs the bot names for its filter too: the runs answer carries them.
    const load = view === 'runs'
      ? () => call(`/api/studio/runs?${q}`).then((d) => { this._runBots = d.bots; return d })
      : async () => ({ ...(await call(`/api/studio/activity?${q}`)), bots: this._runBots || (await call('/api/studio/runs').then((d) => (this._runBots = d.bots))) })
    this._fill('runs', seq, load, (data) => runsScreen({ view, filter, data }))
  }

  async openRun(id) {
    this._openSheet('run', 'Run', '', { wide: true })
    this._reopen = () => this.openRun(id)
    const seq = ++this._sheetSeq
    const run = await this._fill('run', seq, () => call(`/api/studio/run?id=${encodeURIComponent(id)}`), runScreen)
    const col = this._colOf('run')
    if (!run || !col) return
    const here = () => this._colOf('run') === col && col.seq === seq
    // When a run it was following ends, the page is read again for how it ended.
    this._followRun(col.el.querySelector('[data-part="run-feed"]'), run, here, () => { if (here()) { this.cur = col; this._navigating = true; try { this.openRun(id) } finally { this._navigating = false } } })
    col.el.querySelector('.col-head strong').textContent = `${run.bot}${run.job ? ` on ${run.job.ref}` : ''}`
    col.el.querySelector('.col-head p').textContent = `${run.state}${run.at ? `, ${new Date(run.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`
  }

  /**
   * Show a run's feed in `root` and keep it current while the run goes: read every few seconds while
   * `here()` holds and the feed is on the page. `run` is a run already read, or its id.
   */
  async _followRun(root, run, here, ended) {
    if (!root) return
    const view = new FeedView(root)
    let wasLive = false
    let data = typeof run === 'object' ? run : null
    const id = typeof run === 'object' ? run.id : run
    for (let misses = 0; root.isConnected && here();) {
      if (!data) {
        try { data = await call(`/api/studio/run?id=${encodeURIComponent(id)}`); misses = 0 } catch (err) {
          // A read that fails is tried again; three in a row and the feed says so.
          if (++misses >= 3) { root.querySelector('.feed-says').textContent = err.message || 'The run could not be read'; return }
        }
      }
      if (!root.isConnected || !here()) return
      if (data) {
        view.update(data)
        if (wasLive && !data.live) return void ended?.()
        wasLive = data.live
        if (!data.live) return
      }
      data = null
      await new Promise((go) => setTimeout(go, document.hidden ? 8000 : 2500))
    }
  }

  /** The owner's decision on one finding; the page is read again so the change shows at once. */
  async _improveDecide(id, action, reason) {
    try {
      const done = await call(`/api/studio/improvements/${encodeURIComponent(id)}`, { action, reason })
      const said = { accept: 'Accepted', reject: 'Rejected', ask: 'Marked Ask me', send: 'Sent to the lead' }[action]
      this.actions.toast(done.jobRef ? `${said}: job ${done.jobRef}` : said)
    } catch (err) {
      this.actions.toast(err.message || 'That did not save', 'err')
    }
    this.openImprovements()
  }

  async openImprovements() {
    this._improve = this._improve ?? 'open'
    this._openSheet('improvements', 'Improvements', 'What the audits found worth improving, and who is on it', { wide: true })
    this._reopen = () => this.openImprovements()
    const seq = ++this._sheetSeq
    await this._fill('improvements', seq, () => call('/api/studio/improvements'), (d) => improvementsScreen(d, this._improve))
  }

  async openMoney() {
    this._openSheet('models', 'Models, limits and money', 'How close the crew is to its limits, and what is using them', { wide: true })
    this._reopen = () => this.openMoney()
    const seq = ++this._sheetSeq
    if (await this._fill('models', seq, () => call('/api/studio/spend'), (m) => moneyScreen(m, this.view?.plans))) this._loadModels()
  }

  _resetBot() {
    const b = this._botPage
    if (!b) return
    this._confirmAsk(`<b>Start ${esc(b.name)}'s conversations afresh?</b> Its ${b.sessions} saved conversation${b.sessions === 1 ? '' : 's'} are dropped; the next run starts from its instructions and the job, without what it remembered.`, 'Start afresh', async () => {
      try {
        await call('/api/studio/bot', { bot: b.id, action: 'reset' })
        this.actions.toast(`${b.name} starts afresh on its next run`)
        this._reopen?.()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  _rollback(revision) {
    const b = this._botPage
    const rev = b?.revisions.find((r) => r.id === revision)
    if (!rev) return
    this._confirmAsk(`<b>Put ${esc(b.name)}'s settings back</b> as they were after ${esc(rev.what.toLowerCase())}${rev.detail ? ` (${esc(rev.detail)})` : ''}? Its next run uses them. The crew's scripts may change them again.`, 'Roll back', async () => {
      try {
        await call('/api/studio/bot', { bot: b.id, action: 'rollback', revision })
        this.actions.toast(`${b.name}'s settings are rolled back`)
        this.actions.refresh()
        this._reopen?.()
      } catch (err) {
        this.actions.toast(err.message || 'That did not work', 'err')
      }
    })
  }

  async pause(id) {
    const bot = this._bot(id)
    if (!bot) return
    const action = bot.status === 'paused' ? 'resume' : 'pause'
    try {
      await call('/api/studio/bot', { bot: bot.id, action })
      this.actions.toast(action === 'pause' ? `${bot.name} is paused` : `${bot.name} is back at work`)
      this.actions.refresh()
      const page = this._colOf('bot')
      if (page) { this.cur = page; page.reopen?.() }
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
  }
}

Object.assign(Studio.prototype, shapeMethods({ call, STAGE }))
