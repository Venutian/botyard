/**
 * Guided reading of a big change: the files of a job's branch sorted into chapters, the heart of the
 * change first, then what it touches, then how it is checked, then the glue, each with a two-line
 * overview beside the real diff.
 *
 * The sorting is a script: what a file is (a test, a document, settings) is read from its path, the
 * heart is the source that changed most (a new file most of all), and its effects are the other
 * source files whose changes name it. The overview a script can write (how much, what is new, the
 * names it adds) is there at once; a cheap model can be asked to say the same in plain words, once per
 * change, and its words are kept beside the commit so the next reading costs nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { configDir } from './home.mjs'

const TEST = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)tools\/[\w-]*-test\.[a-z]+$/i
const DOC = /\.(md|txt|rst)$|(^|\/)docs?\//i
const SETTINGS = /(^|\/)(package(-lock)?\.json|app\.json|eas\.json|tsconfig[\w.-]*\.json|\.gitignore|\.npmrc|yarn\.lock|pnpm-lock\.yaml|[\w.-]+\.config\.[cm]?[jt]s)$|(^|\/)(\.github|android|ios)\//i
const STYLE = /\.(css|scss|less)$/i
const SMALL = 15

export const kindOfFile = (p) => (TEST.test(p) ? 'test' : DOC.test(p) ? 'doc' : SETTINGS.test(p) ? 'settings' : STYLE.test(p) ? 'style' : 'source')
const stem = (p) => path.basename(p).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')
// The patches start at their first hunk: a new file's first hunk starts from nothing.
const isNew = (f) => /^@@ -0,0 /m.test(f.patch || '')
const size = (f) => (f.added || 0) + (f.removed || 0)
const added = (f) => String(f.patch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))

/** The names a file's change adds: functions, classes, exported values. */
export function namesAdded(f, most = 6) {
  const shown = []
  const inner = []
  for (const line of added(f)) {
    const m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>))/.exec(line)
      || /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
      || /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line)
    const name = m && m.slice(1).find(Boolean)
    // What a file offers others (exported, public) comes before its own small helpers.
    const list = /^\s*export\b|^\s*(?:pub|public)\b|^\s*(?:async\s+)?def\s+[a-z]/.test(line) ? shown : inner
    if (name && !shown.includes(name) && !inner.includes(name)) list.push(name)
    if (shown.length >= most) break
  }
  return [...shown, ...inner].slice(0, most)
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The overview a script can write: how much, what is new, the names it adds. Two lines. */
export function scriptOverview(files) {
  const plus = files.reduce((n, f) => n + (f.added || 0), 0)
  const minus = files.reduce((n, f) => n + (f.removed || 0), 0)
  const made = files.filter(isNew).map((f) => path.basename(f.path))
  const names = [...new Set(files.flatMap((f) => namesAdded(f, 4)))].slice(0, 6)
  const first = `${plural(files.length, 'file')}, +${plus} −${minus}${made.length ? `; new: ${made.slice(0, 4).join(', ')}${made.length > 4 ? ` and ${made.length - 4} more` : ''}` : ''}.`
  const second = names.length ? `Adds ${names.join(', ')}.` : `Changes ${files.slice(0, 3).map((f) => path.basename(f.path)).join(', ')}${files.length > 3 ? ', …' : ''}.`
  return `${first}\n${second}`
}

const TITLES = { heart: 'The heart of it', effects: 'What it touches', checks: 'How it is checked', glue: 'The glue' }

/**
 * The chapters of a change, by script. `files` are the change's files with their patches
 * (lib/changes.mjs). Every file is in exactly one chapter; an empty chapter is left out.
 */
export function chaptersOf(files = []) {
  const live = files.filter((f) => !f.binary || f.path)
  const source = live.filter((f) => kindOfFile(f.path) === 'source' && !f.binary)
  const ranked = [...source].sort((a, b) => (size(b) + (isNew(b) ? 60 : 0)) - (size(a) + (isNew(a) ? 60 : 0)))
  const total = source.reduce((n, f) => n + size(f), 0)
  const heart = []
  let covered = 0
  for (const f of ranked) {
    if (heart.length && (heart.length >= 5 || covered >= total * 0.6 || size(f) <= SMALL)) break
    heart.push(f)
    covered += size(f)
  }
  const heartStems = new Set(heart.map((f) => stem(f.path)))
  // A style sheet named like a heart file is part of it (the page and its look).
  for (const f of live) if (kindOfFile(f.path) === 'style' && heartStems.has(stem(f.path))) heart.push(f)
  const inHeart = new Set(heart.map((f) => f.path))
  const names = [...heartStems].filter((s) => s.length > 2)
  const mentions = (f) => added(f).some((line) => names.some((n) => line.includes(n)))
  const effects = source.filter((f) => !inHeart.has(f.path) && (size(f) > SMALL || mentions(f)) && !(size(f) <= 3 && mentions(f)))
  const inEffects = new Set(effects.map((f) => f.path))
  const checks = live.filter((f) => kindOfFile(f.path) === 'test')
  const glue = live.filter((f) => !inHeart.has(f.path) && !inEffects.has(f.path) && kindOfFile(f.path) !== 'test')
  return [['heart', heart], ['effects', effects], ['checks', checks], ['glue', glue]]
    .filter(([, list]) => list.length)
    .map(([kind, list]) => ({ id: kind, kind, title: TITLES[kind], overview: scriptOverview(list), by: 'script', files: list }))
}

// ── the overviews in plain words, by a cheap model ───────────────────────────────

/**
 * The command that writes overviews: the prompt goes in on stdin, the words come out on stdout.
 * `BOTYARD_OVERVIEW_COMMAND` names one, or the settings folder's `overview-command` file; otherwise Claude
 * Code's smallest model when it is installed.
 * Empty means none, and the script's overviews stand.
 */
export function overviewCommand(env = process.env) {
  if (env.BOTYARD_OVERVIEW_COMMAND !== undefined) return String(env.BOTYARD_OVERVIEW_COMMAND).trim()
  // Or one line in the file `overview-command` in Botyard's settings folder, for a service started without it.
  try { return fs.readFileSync(path.join(configDir(env), 'overview-command'), 'utf8').split('\n')[0].trim() } catch { /* none written */ }
  return 'claude --print --model claude-haiku-5-5'
}

const CLIP = 2400
export function overviewPrompt(chapters, commits = []) {
  const parts = chapters.map((c) => `## ${c.id}: ${c.title}\n${c.files.map((f) => `### ${f.path} (+${f.added} -${f.removed})\n${String(f.patch || '').slice(0, CLIP)}`).join('\n')}`)
  return [
    'You write overviews for a person reading a code change in chapters. For each chapter below, write exactly two short plain lines:',
    'line 1 says what this part of the change does; line 2 says why it matters or what to look at. No markdown, no file lists, no praise.',
    'Answer with JSON only, an object from chapter id to its two lines joined by a newline.',
    commits.length ? `Commits: ${commits.map((c) => c.subject).join(' | ')}` : '',
    ...parts,
  ].filter(Boolean).join('\n\n')
}

/** Run the overview command once; its JSON answer, or null. */
export function askModel(command, prompt, { timeoutMs = 90_000 } = {}) {
  const [cmd, ...args] = String(command).match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, '')) || []
  if (!cmd) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    let child
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }) } catch { resolve(null); return }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => {
      clearTimeout(timer)
      const json = /\{[\s\S]*\}/.exec(out)?.[0]
      try { resolve(json ? JSON.parse(json) : null) } catch { resolve(null) }
    })
    child.stdin.end(prompt)
  })
}

/** Overviews in plain words for these chapters, kept by what the change is so it is asked once. */
export async function modelOverviews(chapters, { commits = [], folder, command = overviewCommand(), ask = askModel } = {}) {
  if (!command || !chapters.length) return null
  const key = createHash('sha256').update(JSON.stringify(chapters.map((c) => [c.id, c.files.map((f) => [f.path, f.patch])]))).digest('hex').slice(0, 24)
  const file = folder ? path.join(folder, `${key}.json`) : ''
  if (file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* not asked yet */ } }
  const answer = await ask(command, overviewPrompt(chapters, commits))
  if (!answer || typeof answer !== 'object') return null
  const words = Object.fromEntries(chapters.map((c) => [c.id, String(answer[c.id] || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n').slice(0, 400)]).filter(([, v]) => v))
  if (file && Object.keys(words).length) { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, JSON.stringify(words)) }
  return words
}

/** A change read in chapters: the script's sorting, and the model's words when asked for and given. */
export async function guidedChange(detail, { overview = false, folder, command, ask } = {}) {
  const chapters = chaptersOf(detail.files)
  if (overview) {
    const words = await modelOverviews(chapters, { commits: detail.commits, folder, command, ask })
    for (const c of chapters) if (words?.[c.id]) Object.assign(c, { overview: words[c.id], by: 'model' })
  }
  return { branch: detail.branch, base: detail.base, commits: detail.commits, cut: detail.cut, chapters }
}
