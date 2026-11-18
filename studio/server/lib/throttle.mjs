/**
 * The PC load control: how hard the crew may work this computer, set by the owner from the page or the phone.
 *
 * Botyard does not hold the throttle itself. A yard that has one names its tool in `config/pc-load.json`:
 *
 *   { "tool": "/absolute/path/to/the/tool" }
 *
 * The tool answers `show --json` with `{ day, night, now, paused: [ { state, ... } ], heldMB }` and takes
 * `<level> [--day|--night]` to set a level. With no tool named, the control is hidden and the route says so.
 *
 * The level is one of five names, checked against that list and handed to the tool as an argument (no
 * shell), so nothing else can ever be run. Every change is made as the owner's: the tool is told who
 * asked (BOTYARD_SET_BY) and writes it in its own log. The route is reached only by the owner (see
 * studio.mjs and phone.mjs), never with a bot's pass.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './home.mjs'

export const LEVELS = ['none', 'light', 'medium', 'heavy', 'full']
export const SCOPES = ['both', 'day', 'night']
const WAIT_MS = 15_000

/** The tool this yard names, or '' when it names none (or names one that is not an absolute, runnable file). */
export function throttleTool({ settingsFile = path.join(configDir(), 'pc-load.json'), env = process.env } = {}) {
  let tool = (env.BOTYARD_THROTTLE_TOOL || '').trim()
  if (!tool) {
    try { tool = String(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tool || '').trim() } catch { return '' }
  }
  if (!path.isAbsolute(tool)) return ''
  try { fs.accessSync(tool, fs.constants.X_OK); return fs.statSync(tool).isFile() ? tool : '' } catch { return '' }
}

/** The variables the tool runs with: the page's own, less anything that would make it look like a bot's run. */
function toolEnv(setBy, env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!/^BOTYARD_(RUN_ID|JOB_ID|BOT_ID|API_KEY|WAKE_)/.test(k)) out[k] = v
  if (setBy) out.BOTYARD_SET_BY = setBy
  return out
}

/** Run the tool with plain arguments, never through a shell. */
export function runTool(tool, args, { setBy = '', env } = {}) {
  return new Promise((resolve) => {
    execFile(tool, args, { timeout: WAIT_MS, maxBuffer: 256 * 1024, shell: false, env: toolEnv(setBy, env) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') })
    })
  })
}

const level = (v) => (LEVELS.includes(String(v)) ? String(v) : '')
const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)

/**
 * Read what `show --json` printed. `paused` is the list of paused jobs; only the ones still there
 * (state "ok") count, and `heldMB` is the memory they hold. Anything that is not that JSON reads as unknown.
 */
export function readShow(text) {
  let j = null
  try { j = JSON.parse(String(text || '').trim()) } catch { /* not JSON */ }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { day: '', night: '', now: '', paused: 0, heldGb: 0 }
  const now = level(j.now)
  const rows = Array.isArray(j.paused) ? j.paused : []
  const paused = rows.filter((r) => r && typeof r === 'object' && (r.state === undefined || r.state === 'ok')).length
  const heldGb = Math.round((count(j.heldMB) / 1024) * 10) / 10
  // A tool may say in one line what the level lets run (and anything else the owner should see): shown under the button.
  const note = typeof j.note === 'string' ? j.note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : ''
  return { day: level(j.day) || now, night: level(j.night) || now, now, paused, heldGb, note }
}

const NAMES = { none: 'None', light: 'Light', medium: 'Medium', heavy: 'Heavy', full: 'Full' }

/** The one line under the control. */
export function stateLine(s) {
  if (!s.now) return 'The PC load is not known'
  if (s.now === 'full') {
    const held = s.heldGb ? `, ${s.heldGb} GB held` : ''
    return `Full: ${s.paused} job${s.paused === 1 ? '' : 's'} paused${held}`
  }
  const split = s.day && s.night && s.day !== s.night ? ` (day ${NAMES[s.day]}, night ${NAMES[s.night]})` : ''
  return s.note ? `${s.note}${split}` : `${NAMES[s.now]}${split}`
}

/** What the control shows. `{ configured: false }` when this yard has no throttle tool. */
export async function throttleState(options = {}) {
  const tool = options.tool ?? throttleTool(options)
  if (!tool) return { configured: false, levels: LEVELS }
  const shown = await runTool(tool, ['show', '--json'], options)
  const s = readShow(shown.ok ? shown.out : '')
  return { configured: true, ...s, levels: LEVELS, line: shown.ok ? stateLine(s) : 'The PC load could not be read' }
}

/**
 * Set a level. `body` is `{ level, scope }`; anything else is refused before the tool is touched.
 * `options.setBy` names the owner's door ('owner (page)', 'owner (phone)') for the tool's log.
 */
export async function throttleAct(body = {}, options = {}) {
  const tool = options.tool ?? throttleTool(options)
  if (!tool) return [404, { error: 'This yard has no PC load tool: name one in config/pc-load.json' }]
  const wanted = typeof body?.level === 'string' ? body.level : ''
  if (!LEVELS.includes(wanted)) return [400, { error: `The level must be one of ${LEVELS.join(', ')}` }]
  const scope = body.scope === undefined ? 'both' : body.scope
  if (!SCOPES.includes(scope)) return [400, { error: `The scope must be one of ${SCOPES.join(', ')}` }]
  const ran = await runTool(tool, [wanted, ...(scope === 'both' ? [] : [`--${scope}`])], options)
  if (!ran.ok) return [502, { error: (ran.err || 'The load could not be set').trim().slice(0, 200) }]
  return [200, await throttleState({ ...options, tool })]
}
