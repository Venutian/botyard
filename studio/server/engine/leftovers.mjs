/**
 * Programs a run left running after it ended. A run's tools start servers, headless browsers and workers that often
 * leave their process group (a browser's own helpers, a `serve` started in the background), so the run's end does not
 * stop them: on 21 Nov 2026, 39 such processes from seven ended runs had been running for up to three days.
 *
 * Every process a run starts carries BOTYARD_RUN_ID. Once a run has been over for GRACE_MS, its processes are told to
 * stop (SIGTERM), and on a later turn killed (SIGKILL) if they are still there. A run the store does not know is left
 * alone, as are the shared servers in SHARED (adb's server serves every run that uses the test phone).
 */
import { readAll } from '../lib/heavy.mjs'
import { RUN_VARS } from './names.mjs'

export const GRACE_MS = 10 * 60_000
export const EVERY_MS = 5 * 60_000
const SHARED = /(^|\/)(adb|ngen-device-test)$/

/**
 * One sweep. `processes` is a Map of pid → { pid, cmd, env } (lib/heavy.mjs readAll). Returns what was stopped:
 * [{ pid, runId, what, signal }].
 */
export function stopLeftovers(store, { processes = readAll(), now = Date.now(), kill = process.kill.bind(process), told = new Map(), self = process.pid } = {}) {
  const runOf = new Map()
  const ended = (id) => {
    if (!runOf.has(id)) {
      const row = store.row('SELECT status, finished_at FROM runs WHERE id = ?', id)
      runOf.set(id, row && !['running', 'queued'].includes(row.status) ? Date.parse(row.finished_at || '') || 0 : null)
    }
    const at = runOf.get(id)
    return at !== null && at !== undefined && (at === 0 || now - at >= GRACE_MS)
  }
  const out = []
  for (const p of processes.values()) {
    const runId = p.env?.[RUN_VARS.runId]
    if (!runId || p.pid === self || SHARED.test(p.cmd[0] || '') || !ended(runId)) continue
    const signal = told.has(p.pid) && now - told.get(p.pid) >= 60_000 ? 'SIGKILL' : 'SIGTERM'
    if (signal === 'SIGTERM' && told.has(p.pid)) continue // told already; waits a minute before the kill
    try { kill(p.pid, signal) } catch { continue } // gone already, or not ours
    told.set(p.pid, now)
    out.push({ pid: p.pid, runId, what: (p.cmd[0] || '').split('/').pop(), signal })
  }
  for (const pid of told.keys()) if (!processes.has(pid)) told.delete(pid)
  return out
}

/** The engine's turn calls this; it sweeps at most every EVERY_MS. Linux only (it reads /proc). */
export function leftoverSweeper({ every = EVERY_MS, platform = process.platform } = {}) {
  let last = 0
  const told = new Map()
  return (store, { now = Date.now(), ...rest } = {}) => {
    if (platform !== 'linux' || now - last < every) return []
    last = now
    return stopLeftovers(store, { now, told, ...rest })
  }
}
