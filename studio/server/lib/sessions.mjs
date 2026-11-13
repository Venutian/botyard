/**
 * The coding sessions being worked in on this computer right now, for the phone's short list.
 *
 * A session counts as live when its own record was written to in the last two minutes. Only the
 * tools' records are looked at, only their dates are read for every session, and only the live
 * few are opened, for two things: the folder the session works in, and the first thing it was
 * asked. Nothing is ever written, and nothing of a session but those two things is passed on.
 *
 *   Claude Code   <its folder>/projects/<project>/<session>.jsonl
 *   Codex         <its folder>/sessions/<year>/<month>/<day>/rollout-<...>.jsonl
 *
 * A sample yard, and anyone who asks not to be looked at (`BOTYARD_SCAN=off`), gets an empty list.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LIVE_MS = 2 * 60_000
const HEAD_BYTES = 48 * 1024
const TITLE_MAX = 80

const ls = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => [])
const two = (n) => String(n).padStart(2, '0')

/** The records of each tool that could be live, as `{ tool, file }`. Cheap: names only. */
async function candidates(env, now) {
  const user = env.HOME || env.USERPROFILE || os.homedir()
  const out = []
  const claude = path.join(env.CLAUDE_CONFIG_DIR || path.join(user, '.claude'), 'projects')
  for (const project of await ls(claude)) {
    if (!project.isDirectory()) continue
    for (const record of await ls(path.join(claude, project.name))) {
      if (record.isFile() && record.name.endsWith('.jsonl')) out.push({ tool: 'claude-code', file: path.join(claude, project.name, record.name) })
    }
  }
  // Codex files its records by the day a session began: one that is live began today or yesterday.
  const codex = path.join(env.CODEX_HOME || path.join(user, '.codex'), 'sessions')
  for (const back of [0, 1]) {
    const day = new Date(now - back * 86_400_000)
    const dir = path.join(codex, String(day.getFullYear()), two(day.getMonth() + 1), two(day.getDate()))
    for (const record of await ls(dir)) if (record.isFile() && record.name.endsWith('.jsonl')) out.push({ tool: 'codex', file: path.join(dir, record.name) })
  }
  return out
}

/** Any text a person typed, out of the shapes the tools write a message's content in. */
function typed(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part && typeof part.text === 'string' && (part.type === 'text' || part.type === 'input_text') ? part.text : '')).join(' ')
}

/** The folder and the first request, read from the start of a record. Lines that are not JSON are skipped. */
export function readStart(text) {
  let cwd = ''
  let asked = ''
  for (const line of text.split('\n')) {
    if (cwd && asked) break
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object') continue
    const inner = row.payload && typeof row.payload === 'object' ? row.payload : row
    if (!cwd) cwd = [row.cwd, inner.cwd].find((value) => typeof value === 'string' && value) || ''
    if (asked) continue
    const message = row.message && typeof row.message === 'object' ? row.message : inner
    const from = message.role || row.type
    if (from !== 'user') continue
    const words = typed(message.content).replace(/\s+/g, ' ').trim()
    // What a tool puts in a person's mouth (its own notices, wrapped in tags) is not what they asked.
    if (words && !words.startsWith('<')) asked = words
  }
  return { cwd, asked }
}

/** A job's own folder is inside its project: the project is what a person knows it by. */
function projectOf(cwd) {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  const job = parts.findIndex((part, i) => part.startsWith('.') && parts[i + 1] === 'worktrees')
  return (job > 0 ? parts[job - 1] : parts.at(-1)) || ''
}

/**
 * @returns {Promise<Array<{ title: string, harness: string, project: string, at: number }>>} newest first
 */
export async function liveSessions({ env = process.env, now = Date.now(), limit = 12 } = {}) {
  if (env.BOTYARD_DEMO === '1' || env.BOTYARD_SCAN === 'off') return []
  const live = []
  await Promise.all((await candidates(env, now)).map(async (one) => {
    const at = await fs.stat(one.file).then((s) => s.mtimeMs, () => 0)
    if (now - at <= LIVE_MS) live.push({ ...one, at })
  }))
  live.sort((a, b) => b.at - a.at)
  return Promise.all(live.slice(0, limit).map(async ({ tool, file, at }) => {
    let start = { cwd: '', asked: '' }
    const handle = await fs.open(file, 'r').catch(() => null)
    if (handle) {
      try {
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0)
        start = readStart(buffer.toString('utf8', 0, bytesRead))
      } finally { await handle.close() }
    }
    const title = start.asked.length > TITLE_MAX ? `${start.asked.slice(0, TITLE_MAX - 1).trimEnd()}…` : start.asked
    return { title: title || 'Session', harness: tool, project: projectOf(start.cwd), at: Math.round(at) }
  }))
}
