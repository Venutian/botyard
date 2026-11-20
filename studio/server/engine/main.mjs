#!/usr/bin/env node
/**
 * Botyard's engine: it answers the crew's calls from Botyard's store and runs the wake queue and the
 * routines. `startEngine` gives it to whoever holds it: one process can carry the engine beside the
 * map (calls answered in-process through `handle`, no port needed), or this file is run by itself
 * and listens on a port of this computer. Each run has its own keeper, so stopping the engine never
 * stops a bot in the middle of its work.
 *
 * Run by itself it reads three variables (their names are in names.mjs): the port (3210 unless
 * given), Botyard's home folder (the store, the run logs, the runs' folders; `~/.botyard` unless
 * given), and runs "off" to answer calls but start nothing.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { answer } from './api.mjs'
import { callerOf, ensureKeys, keyMode as modeFromEnv, logUnkeyed, onWouldRefuse } from './caller.mjs'
import { notFromHere } from '../lib/local-call.mjs'
import { DEFAULT_PORT, ENGINE_VARS, defaultDataDir, keysDir as keysIn, storeFile } from './names.mjs'
import { tickRoutines } from './routines.mjs'
import { tick } from './runner.mjs'
import { tickTracks } from './tracks.mjs'
import { dailyBlockedSweep } from './signals.mjs'
import { openStore } from './store.mjs'
import { convertBookedRuns } from './run-usage.mjs'
import { ensureStudio } from './studio.mjs'

const TICK_MS = 5000
const MAX_BODY = 12 * 1024 * 1024

/**
 * Start the engine.
 * @param {object} options
 * @param {string} options.dataDir  where the store, the run logs and the runs' folders live
 * @param {number|null} [options.port]  a port of this computer to listen on (0 picks a free one); none when left out
 * @param {boolean} [options.runs]  false answers calls but starts no bot and no routine
 * @param {boolean} [options.tracks]  move trips along their tracks (with runs, unless asked: the demo moves its sample trip with no bot)
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.apiUrl]  the address a bot's run is told to call; needed when the engine has no port of its own
 * @param {number} [options.tickMs]
 * @param {string} [options.keysDir]  where the owner's and the scripts' keys are kept (made when missing); `<dataDir>/keys` when left out
 * @param {'log'|'enforce'} [options.keyMode]  a call with no pass and no key: still the owner and written down, or refused (caller.mjs)
 * @returns {Promise<{ store, server: http.Server|null, apiUrl: string, handle: (req) => Promise<object>, turn: () => Promise<void>, stop: () => Promise<void> }>}
 */
export async function startEngine({ dataDir, port = null, runs = true, tracks = runs, log = console.log, apiUrl = '', tickMs = TICK_MS, keysDir = '', keyMode = modeFromEnv() } = {}) {
  if (!dataDir) throw new Error('The engine needs its data folder')
  const dir = path.resolve(dataDir)
  const store = openStore(storeFile(dir))
  const made = ensureStudio(store)
  const converted = convertBookedRuns(store)
  if (converted) log(`[engine] ${converted} runs booked before now were set to their own share of a resumed session`)
  if (made) log(`[engine] a new studio was made in ${dir}`)

  /**
   * Answer one call in-process: `{ method, url, headers, body, raw }` → `{ status, body }`, or
   * `{ status, file }` for a file's own bytes. `headers` are lower-cased; `raw` is an upload's bytes.
   */
  const keys = ensureKeys(keysDir || keysIn(dir))
  const callersLog = path.join(dir, 'engine-callers.log')
  onWouldRefuse((line) => log(`[engine] would refuse: ${line}`))
  const handle = async (req = {}, caller = null) => {
    const call = { method: 'GET', url: '/', headers: {}, body: {}, ...req }
    try {
      return call.notJson ? { status: 400, body: { error: 'That was not JSON' } } : answer(store, call, { dataDir: dir, caller, keyMode })
    } catch (err) {
      return { status: 500, body: { error: `The engine failed on this call: ${String(err?.message || err).slice(0, 160)}` } }
    }
  }

  let server = null
  if (port !== null && port !== undefined && port !== false) {
    server = http.createServer((req, res) => {
      const send = (status, body) => {
        const text = JSON.stringify(body)
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
        res.end(text)
        if (status >= 400) log(`[engine] ${status} ${req.method} ${String(req.url).slice(0, 160)}: ${String(body?.error || '').slice(0, 200)}`)
      }
      // Only this computer, asked for by this computer's own name: the crew's scripts, the bots, and
      // Botyard's own server. A page elsewhere, or one that points its name here, is refused.
      const away = notFromHere(req)
      if (away) return send(403, { error: `The engine only answers this computer: this call was ${away}` })
      // "Is the engine up?" says nothing about the studio, so a probe may ask it with no key.
      const probe = String(req.method).toUpperCase() === 'GET' && /^\/api\/health\/?(\?.*)?$/.test(String(req.url))
      const told = callerOf(req.headers, keys)
      const caller = told.kind === 'none' && probe ? { kind: 'probe' } : told
      if (caller.kind === 'wrong') return send(401, { error: 'That key is not one of this engine\'s keys' })
      const enginePort = server.address().port
      if (caller.kind === 'none') {
        if (keyMode === 'enforce') return send(401, { error: 'Say who is calling: a run\'s pass, or the owner\'s or a script\'s key' })
        logUnkeyed(callersLog, { req, why: 'no key', enginePort })
      }
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      const plain = write && type !== 'application/json' && type !== 'multipart/form-data'
      const chunks = []
      let size = 0
      req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) req.destroy(); else chunks.push(chunk) })
      req.on('end', async () => {
        let body = {}
        const raw = Buffer.concat(chunks)
        const form = String(req.headers['content-type'] || '').startsWith('multipart/form-data')
        let notJson = false
        if (raw.length && !form) { try { body = JSON.parse(raw.toString('utf8')) } catch { notJson = true } }
        // A write says it is JSON (or a file's form): a page elsewhere cannot send that without asking first.
        if (plain && raw.length) {
          if (keyMode === 'enforce') return send(415, { error: 'The engine takes JSON: send Content-Type: application/json' })
          logUnkeyed(callersLog, { req, why: `not JSON (${type || 'no type'})`, enginePort })
        }
        const out = await handle({ method: req.method, url: req.url, headers: req.headers, body, raw: form ? raw : null, notJson }, caller)
        if (out.file) {
          res.writeHead(200, { 'Content-Type': out.file.type, 'Content-Length': fs.statSync(out.file.path).size, 'Content-Disposition': `${/[?&]download=1/.test(req.url) ? 'attachment' : 'inline'}; filename="${encodeURIComponent(out.file.name)}"`, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
          return fs.createReadStream(out.file.path).pipe(res)
        }
        send(out.status, out.body)
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(port) || 0, '127.0.0.1', resolve)
    })
  }
  const address = apiUrl || (server ? `http://127.0.0.1:${server.address().port}` : '')

  let ticking = false
  const sweepState = {}
  let stopped = false
  /** One turn of the engine's own work: routines whose time has come, runs that ended, wakes that may start. */
  const turn = async ({ bots = true } = {}) => {
    if (ticking || stopped) return
    ticking = true
    try {
      if (bots) {
        for (const run of tickRoutines(store)) log(`[engine] routine ${run.routineId}: ${run.status}`)
        const report = await tick(store, { dataDir: dir, apiUrl: address })
        for (const run of report.started) log(`[engine] started ${run.id} for ${run.agentId} on ${run.issueId}`)
        for (const run of report.finished) log(`[engine] ${run.status} ${run.id}${run.error ? `: ${run.error}` : ''}`)
        for (const skip of report.skipped) log(`[engine] wake ${skip.id} not started: ${skip.why}`)
      }
      // Tracks move after the runs are booked, so a step whose job just ended is read on this same turn.
      for (const stuck of (await tickTracks(store, { dataDir: dir })).stuck) log(`[engine] trip ${stuck.id} is stuck: ${stuck.reason}`)
      const swept = dailyBlockedSweep(store, sweepState)
      if (swept) log(`[engine] blocked-jobs sweep: ${swept.closed} closed, ${swept.found - swept.closed} left for the owner or ruler`)
    } catch (err) {
      log(`[engine] tick failed: ${err.message}`)
    }
    ticking = false
  }
  let timer = null
  if (runs || tracks) {
    if (runs && !address) log('[engine] no address was given for the bots to call back: runs will start without one')
    // With runs off, the timer moves only the tracks: no bot and no routine is started.
    const own = () => turn({ bots: runs })
    own()
    timer = setInterval(own, tickMs)
    timer.unref?.()
  }

  /** Stop answering and ticking, and close the store. Runs in progress go on under their keepers. */
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })
    // A turn that is halfway through finishes before the store closes under it.
    for (let n = 0; ticking && n < 200; n++) await new Promise((resolve) => setTimeout(resolve, 25))
    store.close()
  }

  return { store, server, apiUrl: address, dataDir: dir, keyMode, handle, turn, stop, close: stop }
}

// Run by itself: the engine as its own service.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const dataDir = path.resolve(process.env[ENGINE_VARS.dataDir] || defaultDataDir())
  const port = Number(process.env[ENGINE_VARS.port]) || DEFAULT_PORT
  const runs = process.env[ENGINE_VARS.runs] !== 'off'
  const engine = await startEngine({ dataDir, port, runs })
  console.log(`Botyard engine → ${engine.apiUrl} (${runs ? 'running bots' : 'reading only'}), store ${storeFile(dataDir)}`)
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { engine.stop().finally(() => process.exit(0)) })
}
