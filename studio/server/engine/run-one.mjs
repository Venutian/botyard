#!/usr/bin/env node
/**
 * One run's own keeper. The engine starts this small program for each run and lets go of it: it
 * starts the bot's tool, writes everything the tool prints to the run's log, stops it at its time
 * limit, and leaves a result file when it ends. Because the keeper owns the run, restarting Botyard
 * or its engine does not kill a bot in the middle of its work.
 *
 * Usage: node run-one.mjs <spec.json>
 * The spec: { runId, command, args, cwd, env, promptFile, logFile, resultFile, pidFile, timeoutSec, graceSec }
 * The log is one JSON object a line (ts, stream, chunk, seq): the shape the crew's scripts that
 * read run logs expect.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { launchable, notStarted, stopTree } from './start-tool.mjs'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const startedAt = new Date().toISOString()
const log = fs.createWriteStream(spec.logFile, { flags: 'a' })
let seq = 0
let bytes = 0
const write = (stream, chunk) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), stream, chunk, seq: seq++ }) + '\n'
  bytes += Buffer.byteLength(line)
  log.write(line)
}

let ended = false
let timedOut = false
let cancelled = false
function finish(exitCode, signal, error = '') {
  if (ended) return
  ended = true
  const result = { runId: spec.runId, exitCode, signal: signal || null, timedOut, cancelled, error, startedAt, finishedAt: new Date().toISOString(), logBytes: bytes }
  log.end(() => {
    fs.writeFileSync(`${spec.resultFile}.tmp`, JSON.stringify(result))
    fs.renameSync(`${spec.resultFile}.tmp`, spec.resultFile)
    process.exit(0)
  })
}

let child
try {
  // On Windows a tool installed with npm is a .cmd file, started through cmd.exe (start-tool.mjs).
  const start = launchable(spec.command, spec.args, spec.env)
  if (!start.found) throw Object.assign(new Error(`spawn ${spec.command} ENOENT`), { code: 'ENOENT' })
  child = spawn(start.command, start.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, ...start.options })
} catch (err) {
  const why = notStarted(spec.command, err)
  write('stderr', `${why}\n`)
  finish(null, null, why)
}

if (child) {
  fs.writeFileSync(spec.pidFile, JSON.stringify({ keeper: process.pid, tool: child.pid, startedAt }))
  /** The tool and everything it started. */
  const stop = (signal) => stopTree(child.pid, signal)
  const grace = () => setTimeout(() => stop('SIGKILL'), Math.max(1, Number(spec.graceSec) || 15) * 1000).unref()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => write('stdout', chunk))
  // A tool that says it is refused for now (spec.refuseOn) and would only wait is stopped at once, with the reason.
  const refuseOn = (spec.refuseOn || []).map((w) => String(w).toLowerCase())
  let refused = false
  child.stderr.on('data', (chunk) => {
    write('stderr', chunk)
    if (!refused && refuseOn.length && refuseOn.some((w) => chunk.toLowerCase().includes(w))) {
      refused = true
      write('stderr', `${spec.refuseWhy || 'The tool was refused.'}\n`)
      stop('SIGTERM'); grace()
      child.removeAllListeners('close')
      child.on('close', () => finish(1, null, spec.refuseWhy || 'The tool was refused.'))
    }
  })
  child.on('error', (err) => { const why = notStarted(spec.command, err); write('stderr', `${why}\n`); finish(null, null, why) })
  child.on('close', (code, signal) => finish(code, signal))
  child.stdin.on('error', () => { /* the tool closed its input early */ })
  child.stdin.end(spec.promptFile ? fs.readFileSync(spec.promptFile) : '')
  if (Number(spec.timeoutSec) > 0) {
    setTimeout(() => { timedOut = true; write('stderr', `Stopped at its time limit of ${spec.timeoutSec} seconds.\n`); stop('SIGTERM'); grace() }, Number(spec.timeoutSec) * 1000).unref()
  }
  // The engine cancels a run by asking its keeper to stop.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!cancelled) { cancelled = true; write('stderr', 'Cancelled.\n'); stop('SIGTERM'); grace() } })
}
