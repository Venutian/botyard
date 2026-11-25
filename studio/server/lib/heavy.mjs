/**
 * What is running on this computer right now, and for whom: the processes the crew started, each named by the bot,
 * the job and the run behind it, with what it takes of the processor and the memory.
 *
 * The task manager shows a heavy job as "python" or "node". Every process a bot's run starts carries its run, job and
 * bot in its environment (BOTYARD_RUN_ID, BOTYARD_JOB_ID, BOTYARD_BOT_ID, set by the engine), and every timetable
 * helper carries its name (BOTYARD_HELPER, set by lib/timetable.mjs); a process with neither is the crew's when one of
 * its parents is. Linux only (/proc); elsewhere the list says it cannot be read.
 *
 * The processor share is measured over a short window (two readings), so 100% is one core in full use.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUN_VARS } from '../engine/names.mjs'

const PROC = '/proc'
/** The tags read from a process's environment: the engine's run, job and bot (engine/names.mjs), and the timetable helper's name. */
export const HELPER = 'BOTYARD_HELPER'
const TAGS = [RUN_VARS.runId, RUN_VARS.jobId, RUN_VARS.botId, HELPER]
const TICKS = 100 // clock ticks a second on Linux
const PAGE = 4096

/** One process from /proc: its parent, its command line, its processor time (ticks), its memory (bytes), its start. */
export function readProcess(pid, proc = PROC) {
  try {
    const stat = fs.readFileSync(path.join(proc, String(pid), 'stat'), 'utf8')
    // The name sits in brackets and may hold spaces or brackets itself: the fields start after the last ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(after[1])
    const ticks = Number(after[11]) + Number(after[12])
    const startTicks = Number(after[19])
    const rss = Number(after[21]) * PAGE
    const cmd = fs.readFileSync(path.join(proc, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean)
    let env = {}
    try {
      for (const pair of fs.readFileSync(path.join(proc, String(pid), 'environ'), 'utf8').split('\0')) {
        if (!pair.startsWith('BOTYARD_')) continue
        const at = pair.indexOf('=')
        const key = pair.slice(0, at)
        if (TAGS.includes(key)) env[key] = pair.slice(at + 1)
      }
    } catch { env = {} } // another user's process: no environment to read
    return { pid: Number(pid), ppid, ticks, startTicks, rss, cmd, env }
  } catch {
    return null // gone while being read, or not readable
  }
}

/** Every process now, by pid. */
export function readAll(proc = PROC) {
  const out = new Map()
  let names = []
  try { names = fs.readdirSync(proc) } catch { return out }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const p = readProcess(name, proc)
    if (p && p.cmd.length) out.set(p.pid, p)
  }
  return out
}

/** Seconds since the computer started. */
function uptime(proc = PROC) {
  try { return Number(fs.readFileSync(path.join(proc, 'uptime'), 'utf8').split(' ')[0]) } catch { return os.uptime() }
}

const base = (file) => path.basename(String(file || ''))
const INTERPRETERS = /^(python[\d.]*|node|bash|sh|zsh|ruby|perl|deno|bun|uv|npx|pnpm|npm)$/

/**
 * What a command line is, in a few words: the script an interpreter runs (with its folder, where it says what it is),
 * else the program; plus the model a coding tool was given.
 */
export function describe(command) {
  // Some programs (Electron, Chrome) write their whole command line back as one string.
  const cmd = command.length === 1 && /\s--?\w/.test(command[0]) ? command[0].split(/\s+/) : command
  const prog = base(cmd[0])
  const args = cmd.slice(1)
  if (/^opencode$/.test(prog) || /^(claude|codex|gemini|agy)$/.test(prog)) {
    const m = args.indexOf('-m') >= 0 ? args[args.indexOf('-m') + 1] : args.indexOf('--model') >= 0 ? args[args.indexOf('--model') + 1] : ''
    return { what: m ? `${prog} on ${m}` : prog, kind: 'ai' }
  }
  if (INTERPRETERS.test(prog)) {
    const script = args.find((a) => !a.startsWith('-') && /[./]/.test(a)) || ''
    if (/^-c$|^-e$|--input-type/.test(args[0] || '')) return { what: `${prog} (inline code)`, kind: 'script' }
    if (args[0] === '-m' && args[1]) return { what: `${prog} -m ${args[1]}`, kind: 'script' }
    if (script) {
      const folder = base(path.dirname(script))
      return { what: folder && folder !== '.' ? `${base(script)} (${folder})` : base(script), kind: 'script' }
    }
    return { what: prog, kind: 'script' }
  }
  if (/^(godot|blender|ffmpeg|chrome|chromium|headless_shell|java|gradle|gradlew|cargo|rustc|gcc|cc1plus|clang)/i.test(prog)) return { what: prog, kind: 'tool' }
  return { what: prog, kind: 'program' }
}

/** Whose a process is: its own tags, else the nearest parent's. */
function owner(p, all) {
  let at = p
  for (let i = 0; at && i < 40; i += 1) {
    if (at.env[RUN_VARS.runId] || at.env[HELPER]) return at.env
    at = all.get(at.ppid)
  }
  return null
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Two readings `windowMs` apart → every process with its processor share (%, 100 = one core) and memory, tagged with
 * its run, job, bot or helper when it is the crew's.
 */
export async function sample({ proc = PROC, windowMs = 700, read = readAll } = {}) {
  const first = read(proc)
  const t0 = Date.now()
  await wait(windowMs)
  const second = read(proc)
  const seconds = Math.max(0.05, (Date.now() - t0) / 1000)
  const up = uptime(proc)
  const out = []
  for (const p of second.values()) {
    const before = first.get(p.pid)
    const used = before && before.startTicks === p.startTicks ? p.ticks - before.ticks : 0
    out.push({ ...p, cpu: Math.max(0, (used / TICKS / seconds) * 100), ageS: Math.max(0, Math.round(up - p.startTicks / TICKS)), crew: owner(p, second) })
  }
  return out
}

/** A process counts as heavy from here on. */
export const HEAVY = { cpu: 20, rssMB: 400 }
const heavy = (p) => p.cpu >= HEAVY.cpu || p.rss >= HEAVY.rssMB * 1024 * 1024

/**
 * The crew's work grouped by run or helper (summed over all its processes), heaviest first, each with its heaviest
 * processes named; and the heaviest programs that are not the crew's, so the owner sees what else is using the PC.
 * `names` gives the store's words: { bot(id), job(id), run(id) }.
 */
export function group(processes, { names = {}, cores = os.cpus().length, totalMB = Math.round(os.totalmem() / 1048576) } = {}) {
  const groups = new Map()
  const others = []
  for (const p of processes) {
    if (!p.crew) { if (heavy(p)) others.push(p); continue }
    const key = p.crew[RUN_VARS.runId] ? `run:${p.crew[RUN_VARS.runId]}` : `helper:${p.crew[HELPER]}`
    if (!groups.has(key)) groups.set(key, { key, env: p.crew, cpu: 0, rss: 0, ageS: 0, processes: [] })
    const g = groups.get(key)
    g.cpu += p.cpu; g.rss += p.rss; g.ageS = Math.max(g.ageS, p.ageS)
    g.processes.push(p)
  }
  const proc = (p) => ({ pid: p.pid, self: p.pid === process.pid, ...describe(p.cmd), cpu: Math.round(p.cpu), memMB: Math.round(p.rss / 1048576), ageS: p.ageS })
  const work = [...groups.values()].map((g) => {
    const e = g.env
    const [runId, jobId, botId] = [e[RUN_VARS.runId], e[RUN_VARS.jobId], e[RUN_VARS.botId]]
    const job = jobId ? names.job?.(jobId) : null
    // The same program run many times (a judge per picture, a worker pool) shows once, with how many there are.
    const same = new Map()
    for (const p of g.processes.sort((a, b) => (b.cpu - a.cpu) || (b.rss - a.rss))) {
      const d = proc(p)
      const had = same.get(d.what)
      if (had) { had.cpu += d.cpu; had.memMB += d.memMB; had.count += 1; had.ageS = Math.max(had.ageS, d.ageS) } else same.set(d.what, { ...d, count: 1 })
    }
    const top = [...same.values()].sort((a, b) => (b.cpu - a.cpu) || (b.memMB - a.memMB)).slice(0, 4)
    return {
      kind: runId ? 'run' : 'helper',
      runId: runId || '',
      bot: botId ? names.bot?.(botId) || '' : '',
      job: job ? { id: jobId, ref: job.identifier || '', title: job.title || '' } : null,
      helper: e[HELPER] || '',
      cpu: Math.round(g.cpu), memMB: Math.round(g.rss / 1048576), ageS: g.ageS, count: g.processes.length,
      heavy: g.cpu >= HEAVY.cpu || g.rss >= HEAVY.rssMB * 1048576,
      top,
    }
  }).sort((a, b) => (b.heavy - a.heavy) || (b.cpu - a.cpu) || (b.memMB - a.memMB))
  const crewCpu = work.reduce((n, w) => n + w.cpu, 0)
  const crewMem = work.reduce((n, w) => n + w.memMB, 0)
  return {
    cores, totalMB,
    crew: { cpu: crewCpu, memMB: crewMem, heavy: work.filter((w) => w.heavy).length, count: work.length },
    work,
    others: others.sort((a, b) => b.cpu - a.cpu).slice(0, 5).map(proc),
  }
}

/** The whole answer for the page: what runs now, for whom. */
export async function runningNow({ names = {}, proc = PROC, windowMs, read } = {}) {
  if (process.platform !== 'linux' && proc === PROC) return { at: Date.now(), readable: false, why: 'Only a Linux computer lets Botyard read its processes.' }
  const processes = await sample({ proc, windowMs, read })
  return { at: Date.now(), readable: true, ...group(processes, { names }) }
}
