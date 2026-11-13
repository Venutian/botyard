/**
 * Botyard for the desktop: the yard's map, and nothing else.
 *
 * On the PC the map is the whole studio: the crew, their chats, the jobs, what needs the owner,
 * routines, settings, models, money and the phones with a key.
 *
 * Everything runs as one service, botyard.service, so the phone door and the bots do not depend
 * on this window. Opening the app starts the service if it is down, and closing it stops nothing.
 */
const { app, BaseWindow, ipcMain, Menu, shell, WebContentsView } = require('electron')
const { execFile } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const BAR_HEIGHT = 46
const CHECK_MS = 5000

const VIEWS = {
  office: { label: 'Map', origin: 'http://127.0.0.1:5274', health: '/api/health', view: null, up: false },
}

let window = null
let bar = null
let active = 'office'
let startedAt = 0

function answers(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Everything is one service, so whichever part is down, this brings it all up. */
function startStudio() {
  execFile('systemctl', ['--user', 'start', 'botyard.service'], () => {})
}

async function refresh() {
  for (const entry of Object.values(VIEWS)) {
    const up = await answers(entry.origin + entry.health)
    if (up && !entry.up) entry.view.webContents.loadURL(entry.origin)
    if (!up && entry.up === false && !entry.tried) {
      entry.tried = true
      startedAt = Date.now()
      startStudio()
    }
    entry.up = up
  }
  sendState()
}

function sendState() {
  bar?.webContents.send('state', {
    active,
    // Still waiting on a start made in the last 20 seconds: the bar says Starting, not Start.
    starting: Date.now() - startedAt < 20000,
    tabs: Object.entries(VIEWS).map(([name, entry]) => ({ name, label: entry.label, up: entry.up })),
  })
}

function layout() {
  if (!window) return
  const { width, height } = window.getContentBounds()
  bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT })
  for (const [name, entry] of Object.entries(VIEWS)) {
    entry.view.setVisible(name === active)
    entry.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) })
  }
}

function select(name) {
  active = name
  layout()
  sendState()
}

/** A link to the map opens in the map, at that page. */
function route(url) {
  const [name, entry] = Object.entries(VIEWS).find(([, e]) => url.startsWith(e.origin)) || []
  if (!entry) return false
  if (entry.view.webContents.getURL() !== url) entry.view.webContents.loadURL(url)
  select(name)
  return true
}

/** Links to the map stay inside the window; anything else goes to the normal browser. */
function keepInside(view, origin) {
  const elsewhere = (url) => {
    if (!route(url) && /^https?:/.test(url)) shell.openExternal(url)
  }
  view.webContents.setWindowOpenHandler(({ url }) => {
    elsewhere(url)
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      elsewhere(url)
    }
  })
}

function createWindow() {
  window = new BaseWindow({ width: 1440, height: 920, minWidth: 800, minHeight: 560, title: 'Botyard', backgroundColor: '#000000' })
  bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window.contentView.addChildView(bar)
  bar.webContents.loadFile(path.join(__dirname, 'bar.html'))
  for (const entry of Object.values(VIEWS)) {
    entry.view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    keepInside(entry.view, entry.origin)
    window.contentView.addChildView(entry.view)
  }
  window.on('resize', layout)
  window.on('closed', () => {
    window = null
    app.quit()
  })
  layout()
  bar.webContents.once('did-finish-load', () => {
    refresh()
    setInterval(refresh, CHECK_MS)
  })
}

ipcMain.on('select', (_event, name) => {
  if (VIEWS[name]) select(name)
})

ipcMain.on('reload', () => VIEWS[active].view.webContents.reload())

// The bar's Start button: bring the service up by hand, and say so until the map answers.
ipcMain.on('start', () => {
  startedAt = Date.now()
  startStudio()
  sendState()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()
  })
}
