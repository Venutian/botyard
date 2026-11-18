import { MapSettings, QUALITIES } from './yard/settings.js'
import { Stage } from './yard/stage.js'
import { View } from './yard/view.js'
import { Yard } from './yard/yard.js'
import { Shell } from './shell/shell.js'
import { Studio } from './ui/studio.js'
import { waitingCount } from './ui/needs-count.js'
import { keepFresh } from './ui/fresh.js'

/**
 * Botyard's page: the yard drawn on a canvas, the panels over it, and the few things that join
 * them. It asks the service for the yard's view every few seconds while it is looked at; the
 * yard is drawn again only when something in it changed or a hand is on it.
 */

const ASK_EVERY_MS = 5000
// A window left open (the desktop app, a browser tab) reloads itself once the service hands out a new build.
keepFresh()
const app = document.getElementById('app')
const settings = new MapSettings()
const stage = new Stage(app, settings)
const view = new View(stage)
const yard = new Yard(stage)

let studio = null
const shell = new Shell(app, settings, {
  whole: () => view.whole(),
  next: () => nextBot(),
  notify: () => notices(),
})

// ── what the panels may ask of the page ────────────────────────────────────────────

/** The robot of a bot of the crew, by the bot's id. */
const robotOf = (botId) => [...yard.robots.values()].find((r) => r.thread?.crew?.id === botId) || null

studio = new Studio(shell.el, {
  pickBot: (botId) => {
    const robot = robotOf(botId)
    if (robot) view.go(robot.pos, 30)
    studio.openChat(botId)
    return Boolean(robot)
  },
  // A job is shown by its panels, not by a place in the yard.
  pickJob: () => false,
  closed: () => {},
  focusProject: (name) => {
    const bay = yard.bays.get(name)
    if (bay) view.go(bay.middle, 42)
  },
  home: () => view.whole(),
  look: () => shell.toggleSettings(),
  help: () => shell.toggleHelp(),
  platesShift: (to) => settings.set('shift', to),
  shiftNow: () => settings.get('shift'),
  redraw: () => stage.redraw(),
  refresh: () => ask(),
  toast: (text, kind) => shell.toast(text, kind),
  // The crew map is the home: the yard is not drawn under it, so an idle page draws no frames.
  homeChanged: (mode) => { stage.pause(mode === 'map'); if (mode === 'yard') view.whole({ glide: false }) },
})

// ── settings ───────────────────────────────────────────────────────────────────────

const applySettings = () => {
  const hour = settings.get('shift')
  yard.shiftTo(hour)
  if (studio.on) studio._shift(hour, { asked: false })
  yard.shadows(QUALITIES[settings.get('quality')].shadows)
}
settings.watch(applySettings)
applySettings()

// ── the yard's view, asked for every few seconds ──────────────────────────────────

let asking = false
let framed = false
let lastKey = ''
async function ask() {
  if (asking) return
  asking = true
  try {
    const answer = await fetch('/api/studio', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!answer?.on) {
      // No answer is not "nothing here": the plate stays up and says so until the service answers.
      if (!studio.on) shell.boot('waiting', 'Botyard is not answering yet. Trying again every few seconds.')
      return
    }
    if (!studio.on) {
      studio.mount()
      studio._shift(settings.get('shift'), { asked: false })
      // The map's two buttons come after the panels for the keyboard.
      shell.el.append(shell.$('.rail'))
      shell.boot('gone')
      watchCover()
    }
    studio.setView(answer)
    const projects = answer.manager.projects.map((p) => p.name)
    const key = JSON.stringify([projects, answer.depot, answer.shelved || [], answer.threads.map((t) => [t.id, t.project, t.crew?.status, t.crew?.job?.stage, t.crew?.look, t.crew?.alsoIn])])
    if (key !== lastKey) {
      lastKey = key
      const moved = yard.show({ projects, depot: answer.depot, crew: answer.threads, shelved: answer.shelved })
      if (moved || !framed) {
        // The first picture with the yard in it is marked, so how soon the map shows can be measured.
        if (!framed) {
          const first = () => { stage.drawn.delete(first); performance.mark('yard-first-picture') }
          stage.drawn.add(first)
        }
        view.frame(yard.extent(), { glide: framed })
        framed = true
      }
    }
    noticeCount()
    if (studio.home === 'map') studio.crewMap.refresh()
    else stage.redraw()
  } finally {
    asking = false
  }
}

/** The panels cover the window's edges; the yard is centred in what they leave. */
function watchCover() {
  const measure = () => {
    view.cover(shell.covered())
    if (framed) view.whole({ glide: false })
  }
  const watch = new ResizeObserver(measure)
  for (const sel of ['.studio-top', '.studio-dock', '.studio-crew', '.rail']) {
    const el = shell.$(sel)
    if (el) watch.observe(el)
  }
  measure()
}

// ── after every drawing: the signs over the bays and the names under the robots ────

const lifted = { x: 0, y: 0, z: 0 }
const screenOf = (agent, lift = 0.95) => {
  lifted.x = agent.pos.x
  lifted.y = agent.pos.y + lift
  lifted.z = agent.pos.z
  return stage.toPage(lifted)
}
stage.drawn.add(() => {
  if (!studio.on) return
  studio.placeBoards(yard.plotOrder, (p) => stage.toPage(p), yard.gateAnchor)
  studio.placeTags(yard.agents, screenOf)
})

// ── a hand on the yard ─────────────────────────────────────────────────────────────

const robotUnder = (e) => yard.pick(view.rayUnder(e.clientX, e.clientY))
function listen(canvas) {
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return
    canvas.classList.toggle('over-bot', Boolean(robotUnder(e)))
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || view.moved > 6 || !studio.on) return
    const robot = robotUnder(e)
    if (robot?.thread?.crew) return void studio.openChat(robot.thread.crew.id)
    const ground = view.groundUnder(e.clientX, e.clientY)
    const bay = ground && yard.bayAt(ground)
    if (!bay) return
    if (bay.depot) studio.dockKey(String(dockNumber('bots')))
    else studio.openProject(bay.name, { fly: true })
  })
}
listen(stage.canvas)
stage.onCanvas(listen)

/** The number key of a dock page, found from the dock itself. */
function dockNumber(tab) {
  const kbd = shell.$(`.studio-dock [data-tab="${tab}"] kbd`)
  return kbd ? Number(kbd.textContent) : 4
}

/** Go to the next bot that is stopped or waiting, in turn. */
let nextAt = -1
function nextBot() {
  const wanted = [...yard.robots.values()].filter((r) => r.state === 'stopped' || r.state === 'waiting')
  if (!wanted.length) return shell.hint('No bot is stopped or waiting')
  nextAt = (nextAt + 1) % wanted.length
  const robot = wanted[nextAt]
  view.go(robot.pos, 28)
  shell.hint(`${robot.thread?.crew?.name || 'A bot'}: ${robot.state}`)
}

// Nothing on the page scrolls as a whole: a focus or scrollIntoView that tries slides every panel and the crew bar sideways.
window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0) })

// ── keys ───────────────────────────────────────────────────────────────────────────

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
const SLIDE = { arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0], arrowup: [0, 1], w: [0, 1], arrowdown: [0, -1] }
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (shell.helpOpen) return void shell.toggleHelp(false)
    if (shell.settingsOpen) return void shell.toggleSettings(false)
    if (studio.usageOpen) return void studio.closeUsage()
    // The panel the owner is in closes first: a chat when the focus is in it, else the top column, then the chat.
    if (studio.chatBot && studio.chat.contains(document.activeElement)) return void studio.closeChat()
    if (studio.on && (studio.closeSheet() || studio.closePanel())) return
    if (studio.chatBot) studio.closeChat()
    return
  }
  if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return
  const key = e.key.toLowerCase()
  // Keys that slide the yard work only while it has the focus, so Tab and the arrows still go round the page.
  if (SLIDE[key] && document.activeElement === stage.canvas) {
    e.preventDefault()
    return void view.nudge(...SLIDE[key])
  }
  if (/^[1-9]$/.test(key) && studio.on) return void studio.dockKey(key)
  if (key === '0') return void view.whole()
  if (key === '?') return void shell.toggleHelp()
  if (key === '+' || key === '=') return void view.zoom(0.8)
  if (key === '-') return void view.zoom(1.25)
  if (key === 'm' && studio.on) return void studio.setHome(studio.home === 'map' ? 'yard' : 'map')
  if (key === 'n') return void nextBot()
  if (key === 'h') return void shell.toggleUi()
  if (key === 's') return void shell.toggleSettings()
  if (key === 'p') return void savePicture()
})

function savePicture() {
  const a = document.createElement('a')
  a.href = stage.picture()
  a.download = `botyard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`
  a.click()
  shell.toast('Picture saved')
}

// ── the tab's title and browser notices: what waits for the owner ─────────────────

let waiting = 0
function noticeCount() {
  // THE Needs-you number (ui/needs-count.js): the same on the badge, the crew map and the phone.
  const now = waitingCount(studio._cards || studio._needs || [])
  document.title = now ? `(${now}) Botyard` : 'Botyard'
  if (now > waiting && document.hidden && settings.get('notify') && globalThis.Notification?.permission === 'granted') {
    try { new Notification('Botyard', { body: now === 1 ? 'One thing waits for you.' : `${now} things wait for you.`, tag: 'botyard-waiting' }) } catch { /* the system may refuse */ }
  }
  waiting = now
}

async function notices() {
  if (settings.get('notify')) return void settings.set('notify', false)
  if (!('Notification' in globalThis)) return shell.toast('This browser cannot show notices', 'err')
  const answer = await Notification.requestPermission()
  settings.set('notify', answer === 'granted')
  if (answer !== 'granted') shell.toast('Notices are blocked for this page; the tab title still shows the count')
}

// ── start ──────────────────────────────────────────────────────────────────────────

ask()
setInterval(() => { if (!document.hidden) ask() }, ASK_EVERY_MS)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  ask()
  studio.wake()
})
window.addEventListener('focus', () => ask())

/**
 * Put one view on the page by name, for the picture script and for anyone at the console: 'map',
 * 'night' (night with the work in hand open), 'night-map', 'needs', 'work', 'setup', 'bot-edit'
 * (a bot's id, else the first bot), 'job' (only with a job's id). Resolves true once the view has
 * had time to fill, false for a view it does not know.
 */
async function show(name, id = '') {
  const settle = (ms = 900) => new Promise((resolve) => setTimeout(() => { stage.redraw(); resolve(true) }, ms))
  if (!studio.on || !studio.view) return false
  studio.closeSheet()
  studio.closeSheet()
  studio.show(null)
  const m = studio.view.manager
  if (name === 'crew' || name === 'crew-night') {
    settings.set('shift', name === 'crew' ? 'day' : 'night')
    studio.setHome('map', { quiet: true })
    return settle(1200)
  }
  if (name === 'map' || name === 'night' || name === 'night-map') {
    studio.setHome('yard', { quiet: true })
    settings.set('shift', name === 'map' ? 'day' : 'night')
    view.whole({ glide: false })
    if (name === 'night') studio.show('work')
    return settle(1600)
  }
  if (name === 'needs') { studio.show('attention'); return settle() }
  if (name === 'work') { studio.show('work'); return settle() }
  if (name === 'setup') { studio.openScreen('setup'); return settle(2500) }
  if (name === 'job') {
    if (!id) return false
    studio.show('work')
    studio._beside(() => studio.openJob(id))
    return settle(1800)
  }
  if (name === 'bot-edit') {
    const bot = m.bots.find((b) => b.id === id) || m.bots[0]
    if (!bot) return false
    studio.openScreen('bots')
    studio._beside(() => studio.openBotEdit(bot.id))
    return settle(1500)
  }
  return false
}

window.botyard = { stage, view, yard, settings, studio, shell, ask, show }
