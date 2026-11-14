/**
 * Botyard for the desktop: the yard's map in a window of its own, with Botyard itself inside.
 *
 * On the PC the map is the whole studio: the crew, their chats, the jobs, what needs the owner,
 * routines, settings, models and the phones with a key.
 *
 * Opening the app looks for a Botyard that is already running on this computer (one started with
 * `npm start`, or installed as a service) and shows it. When none answers, the app starts the copy
 * of Botyard it carries, with its own built-in Node.js, and stops it again when the window closes.
 * A bot in the middle of a run is never stopped by that: each run has a keeper process of its own.
 */
const { app, BaseWindow, ipcMain, Menu, shell, WebContentsView } = require('electron')
const { execFile, execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const BAR_HEIGHT = 46
const CHECK_MS = 5000
const PORT = Number(process.env.PORT) || 5274
const ORIGIN = `http://127.0.0.1:${PORT}`

const VIEWS = {
  office: { label: 'Map', origin: ORIGIN, health: '/api/health', view: null, up: false },
}

let window = null
let bar = null
let active = 'office'
let startedAt = 0
/** The copy of Botyard this app started, if it started one. */
let child = null
/** Why the last start did not work, in words, for the bar and the help page. */
let problem = ''
const logDir = () => path.join(app.getPath('logs'), 'botyard')

/** Where the Botyard this app carries is: inside the app once installed, beside this folder in a clone. */
function carried() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'botyard') : path.resolve(__dirname, '..')
  const entry = path.join(root, 'studio', 'server', 'studio.mjs')
  return fs.existsSync(entry) ? { root, entry } : null
}

/**
 * The PATH a terminal would have. An app opened from the Dock or a menu is given a short one, so
 * the AI tools installed with npm, Homebrew or their own installers would not be found. The login
 * shell is asked once; the usual folders are added in case it does not answer.
 */
function fullPath() {
  const sep = path.delimiter
  const have = String(process.env.PATH || '').split(sep).filter(Boolean)
  if (process.platform === 'win32') return have.join(sep)
  let fromShell = []
  try {
    const shellFile = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const out = execFileSync(shellFile, ['-ilc', 'printf "\\n__PATH__%s__PATH__\\n" "$PATH"'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] })
    fromShell = (/__PATH__(.*)__PATH__/.exec(out)?.[1] || '').split(sep).filter(Boolean)
  } catch { /* no answer from the shell: the usual folders below will do */ }
  const home = os.homedir()
  const usual = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set([...fromShell, ...have, ...usual])].join(sep)
}

/** Does Botyard answer on its port? Something else answering there is not Botyard. */
function answers(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(res.statusCode < 500 ? 'other' : false)
        try { resolve(JSON.parse(body).service === 'botyard' ? true : 'other') } catch { resolve('other') }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** A Botyard service installed on this Linux computer (`npm run install-service`), if there is one. */
function linuxService() {
  if (process.platform !== 'linux') return false
  try {
    execFileSync('systemctl', ['--user', 'cat', 'botyard.service'], { stdio: 'ignore', timeout: 4000 })
    return true
  } catch { return false }
}

/** The last lines Botyard wrote about a problem, for the help page. */
function lastError() {
  try {
    const text = fs.readFileSync(path.join(logDir(), 'server-error.log'), 'utf8').trim().split('\n')
    return text.slice(-4).join('\n')
  } catch { return '' }
}

function startStudio() {
  problem = ''
  startedAt = Date.now()
  if (linuxService()) {
    execFile('systemctl', ['--user', 'start', 'botyard.service'], () => {})
    return
  }
  const here = carried()
  if (!here) {
    problem = 'This copy of the app carries no Botyard to start. Start Botyard yourself with npm start, then press Reload.'
    return
  }
  fs.mkdirSync(logDir(), { recursive: true })
  const env = {
    ...process.env,
    PATH: fullPath(),
    // The app's own program runs Botyard as plain Node.js, and so do the keepers of the bots' runs.
    ELECTRON_RUN_AS_NODE: '1',
    BOTYARD_LOG_DIR: logDir(),
    BOTYARD_DESKTOP: '1',
  }
  child = spawn(process.execPath, [here.entry], { cwd: path.join(here.root, 'studio'), env, stdio: 'ignore', windowsHide: true })
  child.once('exit', (code) => {
    child = null
    if (!app.isQuitting && code) {
      const said = lastError()
      problem = /Port \d+ is in use/.test(said) ? said.split('\n').find((line) => /Port \d+ is in use/.test(line)) : `Botyard stopped as it started${said ? `: ${said.split('\n').pop()}` : '.'}`
      showProblem()
      sendState()
    }
  })
}

function stopStudio() {
  if (!child) return
  try { child.kill('SIGTERM') } catch { /* already gone */ }
}

/** A page of plain words in place of the map when Botyard cannot be shown. */
function showProblem(other = false) {
  const entry = VIEWS.office
  const title = other ? `Something else is using port ${PORT}` : 'Botyard did not start'
  const text = other
    ? `Another program answers on port ${PORT}, where Botyard's map should be. Close that program and press Start, or start Botyard by hand on another port: PORT=5300 npm start in the studio folder of a clone.`
    : problem
  const html = `<!doctype html><meta charset="utf-8"><title>Botyard</title><style>body{margin:0;background:#15181d;color:#eef1f4;font:15px/1.55 system-ui,sans-serif;display:grid;place-items:center;height:100vh}main{max-width:620px;padding:24px}h1{font-size:26px;margin:0 0 10px}pre{white-space:pre-wrap;background:#0b0d10;padding:12px;border-radius:8px;color:#f2b05e}code{color:#5fd0b5}</style><main><h1>${title}</h1><p>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</p><p>What Botyard wrote is in <code>${logDir().replace(/[<>&]/g, '')}</code>.</p><p>Press <b>Start Botyard</b> above to try again.</p></main>`
  entry.view?.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

async function refresh() {
  for (const entry of Object.values(VIEWS)) {
    const up = await answers(entry.origin + entry.health)
    if (up === true && entry.up !== true) entry.view.webContents.loadURL(entry.origin)
    if (up === 'other' && entry.up !== 'other') { problem = `Port ${PORT} is taken by another program.`; showProblem(true) }
    if (up === false && !entry.tried) {
      entry.tried = true
      startStudio()
      if (problem) showProblem()
    }
    entry.up = up
  }
  sendState()
}

function sendState() {
  const up = VIEWS.office.up === true
  bar?.webContents.send('state', {
    active,
    // Still waiting on a start made in the last 60 seconds (the first start builds nothing, but a slow disk can take a while).
    starting: !up && !problem && Date.now() - startedAt < 60000,
    problem: up ? '' : problem,
    tabs: Object.entries(VIEWS).map(([name, entry]) => ({ name, label: entry.label, up: entry.up === true })),
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

// The bar's Start button: bring Botyard up by hand, and say so until the map answers.
ipcMain.on('start', () => {
  if (!child) startStudio()
  if (problem) showProblem()
  sendState()
})

ipcMain.on('logs', () => {
  fs.mkdirSync(logDir(), { recursive: true })
  shell.openPath(logDir())
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
  app.on('before-quit', () => {
    app.isQuitting = true
    stopStudio()
  })
  // Stopped by the system (a log-out, a kill) rather than closed: Botyard stops with it all the same.
  process.on('exit', stopStudio)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => app.quit())
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()
  })
}
