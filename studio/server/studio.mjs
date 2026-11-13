#!/usr/bin/env node
/**
 * Botyard, the whole of it, in one process:
 *
 *   the map       the built page and its API, for people, on PORT (5274)
 *   the engine    the store, the jobs, the wake queue and the routines, for this computer only,
 *                 on BOTYARD_ENGINE_PORT (3210) and under /api on the people port
 *   the phone     the phone app's door, on BOTYARD_PHONE_PORT (5288), once a phone has been paired
 *   the timetable the crew's helper scripts on their times (lib/timetable.mjs)
 *
 * `npm start` runs this file. `--demo` starts the same service on a made-up yard in a throwaway
 * home folder: no bot is started, no helper runs, the phone's door stays closed (tools/sample-yard.mjs).
 *
 * Who answers a path under /api on the people port:
 *   /api/studio/setup, /api/studio/timetable      this file (lib/setup.mjs, lib/timetable.mjs)
 *   /api/studio..., and the map's own short list   the map's API (api.mjs)
 *   anything else                                  the engine, and only for a caller on this computer
 * Someone who comes in through the phone's door or from the internet never reaches the engine raw:
 * the door has its own short list of what a phone may ask.
 *
 * Each bot's run has a keeper process of its own, so stopping or restarting this service never
 * stops a bot in the middle of its work.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Console } from 'node:console'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtPage } from './lib/built-page.mjs'
import { configDir, dataDir, studioRoot } from './lib/home.mjs'
import { setupAct, setupState } from './lib/setup.mjs'
import { readEnvFile, startTimetable, stopTimetable, timetableAct, timetableState } from './lib/timetable.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Where `npm run build` leaves the page, and the answerer that hands it out. */
const BUILT = path.join(studioRoot(), 'dist')
const page = builtPage(BUILT)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** A request that was passed on by something else did not start on this computer, whatever its socket says. */
const PASSED_ON = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-botyard-edge']
/** The map's own paths outside /api/studio. A new one goes under /api/studio, which is always the map's. */
const MAP_PATHS = new Set(['health', 'state'])
const MINE = new Set(['/api/studio/setup', '/api/studio/timetable'])
const MAX_BODY = 64 * 1024


const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const nameOf = (value) => { try { return new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname } catch { return '' } }

/**
 * Did this request start on this computer? Loopback, not handed on by a tunnel or a proxy, and
 * asked for by this computer's own name: a page on another site that points its name at 127.0.0.1
 * still says its own name in `Host`, and a page elsewhere that posts here says so in `Origin`.
 */
export function fromThisComputer(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress) || PASSED_ON.some((name) => req.headers[name] !== undefined)) return false
  if (!LOCAL_NAMES.has(nameOf(req.headers.host || ''))) return false
  const origin = req.headers.origin
  return !origin || origin === 'null' || LOCAL_NAMES.has(nameOf(origin))
}

/** Whose path is it: 'mine', 'map' or 'engine'. */
export function whose(pathname) {
  if (MINE.has(pathname)) return 'mine'
  if (pathname === '/api/studio' || pathname.startsWith('/api/studio/')) return 'map'
  return MAP_PATHS.has(pathname.split('/')[2] || '') && pathname.split('/').length === 3 ? 'map' : 'engine'
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('That is too much to send here')); req.destroy() } else chunks.push(chunk) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('The body is not JSON')) } })
    req.on('error', reject)
  })
}

/** Setup and the timetable, for the person at this computer. */
async function mine(req, res, url) {
  if (!fromThisComputer(req)) return send(res, 403, { error: 'Setup and the timetable are for the person at this computer' })
  const setup = url.pathname === '/api/studio/setup'
  try {
    if (req.method === 'GET') {
      if (setup) return send(res, 200, await setupState({ fresh: url.searchParams.get('fresh') === '1' }))
      const log = url.searchParams.get('log')
      const out = timetableState(log ? { log } : {})
      return out ? send(res, 200, out) : send(res, 404, { error: 'The timetable has no helper by that name' })
    }
    if (req.method === 'POST') {
      const [status, body] = await (setup ? setupAct : timetableAct)(await readBody(req))
      return send(res, status, body)
    }
    return send(res, 405, { error: 'Use GET or POST' })
  } catch (err) {
    return send(res, 400, { error: String(err?.message || err).slice(0, 200) })
  }
}

/** Hand a call on to the engine's own listener, bytes in and bytes out, so nothing is read twice. */
function toEngine(req, res, engineUrl) {
  const target = new URL(engineUrl)
  const onward = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (answer) => {
    res.writeHead(answer.statusCode || 502, answer.headers)
    answer.pipe(res)
  })
  onward.on('error', () => { if (!res.headersSent) send(res, 503, { error: 'Botyard\'s engine is not answering' }); else res.destroy() })
  req.pipe(onward)
}

const portFree = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const probe = net.createServer()
  probe.once('error', () => resolve(false))
  probe.listen(port, host, () => probe.close(() => resolve(true)))
})
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, () => { server.off('error', reject); resolve() })
})
const inUse = (what, port, name) => new Error(`Port ${port} is in use, so ${what} cannot start. Botyard may already be running on this computer; to start a second one, set ${name} to a free port.`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

/**
 * One store, one engine. Two engines over the same store would each start the same bot's run.
 * Returns '' when this process may run bots, else why not.
 */
function anotherEngine(data, enginePort) {
  const lock = path.join(data, 'engine.lock')
  try {
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'))
    if (held.pid !== process.pid && alive(held.pid)) return `another Botyard (process ${held.pid}) already runs the bots of this yard`
  } catch { /* no lock, or one left by a process that is gone */ }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port: enginePort, at: new Date().toISOString() }))
  return ''
}

/**
 * Start the parts of Botyard that are not the page: the engine, the phone's door and the timetable,
 * and give back the middleware that answers /api. `startStudio` adds the built page on a port;
 * `npm run dev` hangs the same middleware on Vite's server.
 *
 * @param {object} [options]
 * @param {boolean} [options.demo]       the sample yard in a throwaway home: the engine answers, no bot is started
 * @param {boolean} [options.engine]     false: no engine in this process (the map alone)
 * @param {boolean} [options.phone]      false: no phone's door
 * @param {boolean} [options.timetable]  false: no helper scripts
 * @param {boolean} [options.lenient]    a part that cannot start is said and left out, in place of stopping
 */
export async function createStudio({ env = process.env, demo = false, engine = true, phone = true, timetable = true, lenient = false, log = console.log } = {}) {
  const closers = []
  const close = async () => { for (const closer of closers.reverse()) await closer().catch((err) => log(`[botyard] while stopping: ${err.message}`)) }
  const part = async (name, start) => {
    try { return await start() } catch (err) {
      if (!lenient) { await close(); throw err }
      log(`[botyard] ${name} was not started: ${err.message}`)
      return null
    }
  }

  // The map's modules read these once, when they load: set before `api.mjs` is imported.
  if (demo) {
    // A home of its own, gone when the demo stops: the demo never reads or writes a real yard.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-demo-'))
    closers.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    Object.assign(env, { BOTYARD_DEMO: '1', BOTYARD_HOME: home, BOTYARD_ENGINE_RUNS: 'off' })
    for (const own of ['BOTYARD_DATA', 'BOTYARD_API_URL', 'BOTYARD_CREW_FOLDER', 'BOTYARD_KEYS', 'BOTYARD_GUARD_DIR', 'BOTYARD_DEVICES_FILE', 'BOTYARD_EDGE_FILE', 'BOTYARD_AWAY_FILE', 'BOTYARD_PREVIEW_ROOT']) delete env[own]
    // Its engine takes any free port, so the demo runs beside a Botyard that is already going.
    env.BOTYARD_ENGINE_PORT ||= String(await freePort())
    phone = false
  }
  // Every other folder is asked of lib/home.mjs by the module that needs it.
  const config = configDir(env)

  let engineUrl = ''
  let running = null
  if (engine) {
    running = await part('The engine', async () => {
      const enginePort = Number(env.BOTYARD_ENGINE_PORT) || 3210
      if (!(await portFree(enginePort))) throw inUse('the engine', enginePort, 'BOTYARD_ENGINE_PORT')
      const { startEngine } = await import('./engine/main.mjs')
      const data = dataDir(env)
      const why = env.BOTYARD_ENGINE_RUNS === 'off' ? 'BOTYARD_ENGINE_RUNS is off' : anotherEngine(data, enginePort)
      if (why) log(`[botyard] The engine answers calls but starts no bot: ${why}.`)
      const started = await startEngine({ dataDir: data, port: enginePort, runs: !why, log })
      closers.push(async () => {
        await started.stop()
        if (!why) fs.rmSync(path.join(data, 'engine.lock'), { force: true })
      })
      return started
    })
    if (running && demo) {
      const { fillSampleYard } = await import('../tools/sample-yard.mjs')
      const made = await fillSampleYard(running, { dataDir: dataDir(env) })
      log(`[botyard] The sample yard: ${made.studio.name}, ${Object.keys(made.bots).length} bots, ${Object.keys(made.jobs).length} jobs. Nothing here is real, and no bot is started. It is kept in ${dataDir(env)} until you stop the demo.`)
    }
    if (running) {
      engineUrl = running.apiUrl
      // One name says where the engine is: the map's client, the timetable's helpers and every run read it.
      env.BOTYARD_API_URL = engineUrl
    }
  }

  const { apiMiddleware } = await import('./api.mjs')

  let door = null
  if (phone) {
    door = await part('The phone\'s door', async () => {
      const file = path.join(config, 'phone.env')
      const own = { ...(fs.existsSync(file) ? readEnvFile(file) : {}), ...env }
      if (!own.BOTYARD_PHONE_TOKEN) {
        log('[botyard] The phone\'s door is closed: no phone has been paired with this yard yet.')
        return null
      }
      const phonePort = Number(own.BOTYARD_PHONE_PORT) || 5288
      if (!(await portFree(phonePort, own.BOTYARD_PHONE_HOST || '127.0.0.1'))) throw inUse('the phone\'s door', phonePort, 'BOTYARD_PHONE_PORT')
      const { startPhoneDoor } = await import('./phone.mjs')
      const server = startPhoneDoor(own)
      server.on('error', (err) => log(`[botyard] the phone's door stopped: ${err.message}`))
      closers.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() }))
      return server
    })
  }

  if (timetable) {
    await part('The timetable', async () => {
      startTimetable({ ...(demo ? { locked: 'This is the sample yard: its helpers are listed with made-up times, and none of them runs here.' } : {}), env: engineUrl ? { BOTYARD_API_URL: engineUrl } : {}, log })
      closers.push(stopTimetable)
    })
  }

  /** Everything under /api; anything else is `next()`'s. */
  const middleware = (req, res, next) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.slice(0, 5) !== '/api/') return next ? next() : send(res, 404, { error: 'Nothing is here' })
    const owner = whose(url.pathname)
    if (owner === 'mine') return mine(req, res, url)
    if (owner === 'map') return apiMiddleware(req, res, next)
    // The engine speaks to this computer only. Anyone else is told nothing is here.
    if (!engineUrl || !fromThisComputer(req)) return send(res, 404, { error: 'Not found' })
    return toEngine(req, res, engineUrl)
  }

  return { middleware, engine: running, engineUrl, phone: door, close }
}

/** The whole service on its ports. Resolves once the page answers. */
export async function startStudio({ env = process.env, log = console.log, ...options } = {}) {
  const demo = options.demo === true
  const port = Number(env.PORT) || (demo ? 5275 : 5274)
  const host = env.BOTYARD_HOST || '127.0.0.1'
  // The people port first: if Botyard is already running here, stop before anything else is touched.
  if (!(await portFree(port, host))) throw inUse('Botyard', port, 'PORT')
  const studio = await createStudio({ env, log, ...options })
  const server = http.createServer((req, res) => studio.middleware(req, res, () => page(req, res)))
  try { await listen(server, port, host) } catch (err) { await studio.close(); throw err.code === 'EADDRINUSE' ? inUse('Botyard', port, 'PORT') : err }
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`
  log(`Botyard → ${url}${demo ? ' (the demo: a made-up yard, gone when you stop it)' : ''}`)
  return {
    ...studio, server, url,
    close: async () => {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })
      await studio.close()
    },
  }
}

/** Build the page when this folder has never been built: the first `npm start` after a clone. */
function buildIfMissing(log) {
  if (fs.existsSync(path.join(BUILT, 'index.html'))) return
  log('Building the map: this happens once, on the first start.')
  const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: studioRoot(), stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0 || !fs.existsSync(path.join(BUILT, 'index.html'))) throw new Error('The map could not be built. Run `npm install`, then `npm run build`, and read what it says.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const has = (flag) => process.argv.includes(flag)
  try {
    // A launch with no terminal behind it (a desktop shortcut) writes its log to a folder instead.
    if (process.env.BOTYARD_LOG_DIR) {
      fs.mkdirSync(process.env.BOTYARD_LOG_DIR, { recursive: true })
      globalThis.console = new Console({
        stdout: fs.createWriteStream(path.join(process.env.BOTYARD_LOG_DIR, 'server.log'), { flags: 'a' }),
        stderr: fs.createWriteStream(path.join(process.env.BOTYARD_LOG_DIR, 'server-error.log'), { flags: 'a' }),
      })
      process.on('warning', (warning) => console.warn(warning.message))
    }
    buildIfMissing(console.log)
    const studio = await startStudio({ demo: has('--demo') })
    let stopping = false
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, async () => {
        if (stopping) return
        stopping = true
        // Runs in progress go on under their keepers; everything this process holds is closed.
        await Promise.race([studio.close(), new Promise((resolve) => setTimeout(resolve, 8000))])
        process.exit(0)
      })
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
