/**
 * The runner: turns a wake into a run, and a finished run into its record.
 *
 * `tick` is called every few seconds. It first books every run whose keeper has ended (status,
 * tokens, the session to resume, the log), then starts the wakes that may start now: the bot is not
 * paused, it has room for another run, and the job is one this engine owns with nothing running on
 * it. A run is started through its own keeper (`run-one.mjs`), so it outlives a restart of the
 * engine; after a restart `tick` simply finds the keepers still going and the results left behind.
 *
 * Everything outside the store goes through `io`, so the tests run it without starting anything.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AdapterError, canRun, commandFor, inlinesInstructions, providerOf, readOutput, sessionIsGone } from './adapters.mjs'
import { envForRun } from './bots.mjs'
import { addComment } from './write.mjs'
import { fileOf } from './files.mjs'
import { instructionsOf, wakePrompt } from './prompt.mjs'
import { MAY_NOT_VAR, PASS_PREFIX, PROVIDER_KEYS, isHidden, keysDir, runLogsDir, runVars, runsDir, worktreeDir } from './names.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const iso = (now) => new Date(now).toISOString()
const EXCERPT = 4000
const DEFAULT_TIMEOUT_SEC = 3600

const slugOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
const hashOf = (token) => createHash('sha256').update(token).digest('hex')

/**
 * The files a bot is woken with: those tied to the words it is shown, and those someone else attached
 * to the job since its last run. Each is copied into the run's own folder, where every kind of bot may
 * read it, so a Claude or OpenCode bot can open a screenshot the owner sent. A file whose bytes are
 * gone is named as missing rather than left out.
 */
export function filesForRun(store, job, agent, comments, since, into, { dataDir } = {}) {
  const shown = new Set(comments.map((c) => c.id))
  const all = store.objects('SELECT raw FROM attachments WHERE job_id = ? ORDER BY position', job.id)
  const wanted = all.filter((a) => (a.issueCommentId ? shown.has(a.issueCommentId) : a.createdByAgentId !== agent.id && (!since || a.createdAt > since)))
  return wanted.slice(-20).map((a, n) => {
    const name = `${n + 1}-${String(a.originalFilename || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 100)}`
    const place = path.join(into, name)
    try {
      fs.mkdirSync(into, { recursive: true })
      fs.copyFileSync(fileOf(store, a.id, { dataDir }).path, place)
      return { id: a.id, commentId: a.issueCommentId || '', name: a.originalFilename || 'file', type: a.contentType || '', path: place }
    } catch {
      return { id: a.id, commentId: a.issueCommentId || '', name: a.originalFilename || 'file', type: a.contentType || '', path: '' }
    }
  })
}

/** What the runner does outside the store. Replaced in tests. */
export const realIo = {
  /** Start a run's keeper and let go of it. */
  startKeeper(specFile) {
    const keeper = spawn(process.execPath, [path.join(here, 'run-one.mjs'), specFile], { detached: true, stdio: 'ignore' })
    keeper.unref()
    return keeper.pid
  },
  alive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  },
  stop(pid) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } },
  git: (cwd, args) => run('git', ['-C', cwd, ...args], { timeout: 60_000 }).then((r) => r.stdout.trim()),
}

// ── who is calling ──────────────────────────────────────────────────────────────────

/** A run's own pass, given to the bot as its API key. Only its hash is kept. */
export function issueToken(store, runId, agentId) {
  const token = `${PASS_PREFIX}${randomBytes(24).toString('base64url')}`
  store.setMeta(`run-token:${hashOf(token)}`, JSON.stringify({ runId, agentId }))
  return token
}
/** The run and bot behind a pass, while that run is live. */
export function whoHolds(store, token) {
  const found = token ? store.meta(`run-token:${hashOf(token)}`) : null
  if (!found) return null
  try { return JSON.parse(found) } catch { return null }
}
const dropToken = (store, runId) => {
  for (const row of store.rows("SELECT key, value FROM meta WHERE key LIKE 'run-token:%'")) {
    try { if (JSON.parse(row.value).runId === runId) store.db.prepare('DELETE FROM meta WHERE key = ?').run(row.key) } catch { /* not ours */ }
  }
}

// ── where a job is worked ───────────────────────────────────────────────────────────

/**
 * The folder a job is worked in: its own git worktree on its own branch, cut from the project's
 * main line, kept between runs. A project that is not a git repository is worked in place.
 */
export async function workspaceFor(store, job, { io = realIo, now = Date.now() } = {}) {
  const known = job.executionWorkspaceId ? store.object('SELECT raw FROM workspaces WHERE id = ?', job.executionWorkspaceId) : null
  if (known && fs.existsSync(known.cwd)) return known
  const project = job.projectId ? store.object('SELECT raw FROM projects WHERE id = ?', job.projectId) : null
  const root = (project?.primaryWorkspace || project?.workspaces?.[0])?.cwd
    || store.row('SELECT cwd FROM project_workspaces WHERE project_id = ? ORDER BY is_primary DESC LIMIT 1', job.projectId || '')?.cwd
  if (!root || !fs.existsSync(root)) return null
  const name = `${job.identifier}-${slugOf(job.title)}`
  let cwd = root
  let branch = ''
  let baseRef = ''
  let missedStart = ''
  let isRepo = false
  try { isRepo = (await io.git(root, ['rev-parse', '--is-inside-work-tree'])) === 'true' } catch { isRepo = false }
  if (isRepo) {
    cwd = worktreeDir(root, name)
    branch = name
    // A job told which commit to start from (a fix round goes on from the build's own commit) has its
    // branch cut there. A commit this repository does not have cannot be started from: the branch is cut
    // from the main line and the bot is told, so it never builds on the wrong code without knowing.
    let from = 'HEAD'
    if (job.startFrom) {
      const there = await io.git(root, ['rev-parse', '--verify', '--quiet', `${job.startFrom}^{commit}`]).then(() => true, () => false)
      if (there) from = job.startFrom
      else missedStart = job.startFrom
    }
    baseRef = await io.git(root, ['rev-parse', '--short', from]).catch(() => '')
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(path.dirname(cwd), { recursive: true })
      const has = await io.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
      await io.git(root, has ? ['worktree', 'add', cwd, branch] : ['worktree', 'add', '-b', branch, cwd, from])
    }
  }
  const workspace = {
    id: known?.id || randomUUID(), companyId: job.companyId, projectId: job.projectId || null, sourceIssueId: job.id,
    mode: isRepo ? 'isolated_workspace' : 'shared_workspace', strategyType: isRepo ? 'git_worktree' : 'project_primary', name, status: 'active',
    cwd, baseRef, startFrom: job.startFrom || null, startFromMissing: missedStart || null, branchName: branch, repoUrl: null, openedAt: known?.openedAt || iso(now), lastUsedAt: iso(now), createdAt: known?.createdAt || iso(now), updatedAt: iso(now),
  }
  store.put('workspaces', workspace)
  store.put('jobs', { ...job, executionWorkspaceId: workspace.id })
  return workspace
}

/**
 * OpenCode asks before each tool unless its settings say otherwise, and a bot has nobody to ask. So a
 * run gets its own copy of the owner's OpenCode settings with every tool allowed, as a bot needs
 * gave it; the bot's own settings file (its skills, its connectors) still applies on top, and what a
 * bot may not do is refused by the crew's guards, not by a prompt nobody answers.
 */
function openCodeSettings(scratch, env) {
  const home = path.join(scratch, 'config')
  const mine = path.join(home, 'opencode')
  fs.mkdirSync(mine, { recursive: true })
  const source = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'opencode')
  try { fs.cpSync(source, mine, { recursive: true, force: true }) } catch { /* the owner has no OpenCode settings */ }
  const file = path.join(mine, 'opencode.json')
  let had = {}
  try { had = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* none, or not JSON */ }
  fs.writeFileSync(file, `${JSON.stringify({ ...(had && typeof had === 'object' && !Array.isArray(had) ? had : {}), permission: 'allow' }, null, 2)}\n`)
  return home
}

/**
 * The bot's own variables from its settings. A value that reads as the hidden marker (a secret with
 * nothing held for it) is left out rather than passed on as nonsense. The bot's PATH goes in front of this computer's, never instead of it.
 */
export function botEnv(given = {}, env = process.env) {
  const out = {}
  for (const [name, raw] of Object.entries(given || {})) {
    const value = raw && typeof raw === 'object' ? raw.value : raw
    if (value === undefined || value === null || isHidden(value)) continue
    out[name] = String(value)
  }
  if (out.PATH) out.PATH = [...new Set([...out.PATH.split(':'), ...String(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')])].filter(Boolean).join(':')
  return out
}

/** What a bot can be kept from. `push` covers everything that leaves this computer; `edit` means no commit either. */
export const MAY_NOT = ['push', 'commit', 'edit']
export const mayNotOf = (agent) => (Array.isArray(agent?.adapterConfig?.mayNot) ? MAY_NOT.filter((word) => agent.adapterConfig.mayNot.includes(word)) : [])

/**
 * A guard in front of git for a bot that is kept from something: a small `git` that refuses `push`
 * (and `commit`, for a bot that may not commit or edit) and hands everything else to the real one,
 * and a `gh` that refuses outright, since everything it changes is on GitHub. It stands first on the
 * run's PATH. It is a floor under every kind of bot, beside whatever the tool's own settings refuse.
 */
export function gitGuard(scratch, mayNot) {
  const dir = path.join(scratch, 'guard')
  fs.mkdirSync(dir, { recursive: true })
  const refused = ['push', ...(mayNot.includes('commit') || mayNot.includes('edit') ? ['commit'] : [])]
  const next = (tool) => `self="${dir}"
real=""
old_ifs=$IFS; IFS=:
for d in $PATH; do
  if [ "$d" != "$self" ] && [ -x "$d/${tool}" ]; then real="$d/${tool}"; break; fi
done
IFS=$old_ifs`
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
# Written by Botyard's engine for this run: this bot may not ${refused.join(' or ')}.
sub=""; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix) skip=1;;
    -*) ;;
    *) sub="$a"; break;;
  esac
done
case " ${refused.join(' ')} " in
  *" $sub "*) echo "Botyard: this bot may not run git $sub. Leave it to the owner and say so in your report." >&2; exit 1;;
esac
${next('git')}
[ -n "$real" ] || { echo "git is not installed" >&2; exit 127; }
exec "$real" "$@"
`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
# Written by Botyard's engine for this run: what gh changes is on GitHub, which this bot may not touch.
case "$1 $2" in
  "pr view"|"pr list"|"pr diff"|"pr checks"|"pr status"|"issue view"|"issue list"|"repo view"|"run view"|"run list"|"auth status") ;;
  *) echo "Botyard: this bot may not change anything on GitHub (gh $1 $2). Leave it to the owner and say so in your report." >&2; exit 1;;
esac
${next('gh')}
[ -n "$real" ] || { echo "gh is not installed" >&2; exit 127; }
exec "$real" "$@"
`, { mode: 0o755 })
  return dir
}

/** The free-model providers' keys that are in the keys folder, under the names their tools read. */
export function providerKeys(dataDir) {
  const out = {}
  for (const [file, name] of Object.entries(PROVIDER_KEYS)) {
    try {
      const key = fs.readFileSync(path.join(keysDir(dataDir), file), 'utf8').split('\n')[0].trim()
      if (key) out[name] = key
    } catch { /* no such key was given */ }
  }
  return out
}

// ── starting ────────────────────────────────────────────────────────────────────────

const limitOf = (agent) => Math.min(50, Math.max(1, Number(agent.runtimeConfig?.heartbeat?.maxConcurrentRuns) || 1))
const liveRuns = (store, where, ...params) => store.objects(`SELECT raw FROM runs WHERE status IN ('running', 'queued') AND ${where}`, ...params)

/** Why this wake cannot start now, or '' when it can. `skip` means it never will. */
function hold(store, wake, agent, job) {
  if (!agent) return { skip: 'That bot no longer exists' }
  if (agent.status === 'terminated') return { skip: 'That bot was removed' }
  if (!canRun(agent)) return { skip: `Botyard's engine cannot start a ${agent.adapterType} bot yet` }
  if (!job) return { skip: 'A wake needs a job' }
  // A chat with a bot is never closed, so a word in it always reaches the bot.
  if (!job.conversationAgentId && ['done', 'cancelled'].includes(job.status)) return { skip: 'The job is closed' }
  if (agent.status === 'paused') return { wait: 'The bot is paused' }
  if ((job.blockedBy || []).length) return { wait: 'The job waits on another job' }
  if (liveRuns(store, 'job_id = ?', job.id).length) return { wait: 'A run is already going on this job' }
  if (liveRuns(store, 'agent_id = ?', agent.id).length >= limitOf(agent)) return { wait: 'The bot has no room for another run' }
  return {}
}

/** A run that cannot start because the folder it needs is not there. */
export class FolderGone extends Error {}

/** The folder a job's project names when it is not on disk (so the job would be worked in another folder), else ''. */
function projectFolderMissing(store, job) {
  if (!job.projectId) return ''
  const project = store.object('SELECT raw FROM projects WHERE id = ?', job.projectId)
  const root = (project?.primaryWorkspace || project?.workspaces?.[0])?.cwd
    || store.row('SELECT cwd FROM project_workspaces WHERE project_id = ? ORDER BY is_primary DESC LIMIT 1', job.projectId)?.cwd
  return root && !fs.existsSync(root) ? root : ''
}

/** Everything a run needs on disk, and its row in the store. @returns the run */
export async function startRun(store, wake, { dataDir, apiUrl, io = realIo, now = Date.now(), env = process.env } = {}) {
  const agent = store.object('SELECT raw FROM agents WHERE id = ?', wake.agentId)
  const job = store.object('SELECT raw FROM jobs WHERE id = ?', wake.payload?.issueId || '')
  const company = store.object('SELECT raw FROM company LIMIT 1') || {}
  // The session this bot left this job in is looked at before the folder is made: a folder that was removed and is cut again
  // is a new checkout, and the conversation about the old one would talk of files that are not there.
  const kept = store.objects('SELECT raw FROM sessions WHERE agent_id = ? AND task_key = ?', agent.id, job.id).at(-1)
  const keptFolder = kept?.sessionParamsJson?.sessionId ? kept.sessionParamsJson.cwd || '' : ''
  const sessionFolderGone = Boolean(keptFolder) && !fs.existsSync(keptFolder)
  const workspace = await workspaceFor(store, job, { io, now })
  const cwd = workspace?.cwd || agent.adapterConfig?.cwd || os.homedir()
  const wrongBase = workspace ? '' : projectFolderMissing(store, job)
  if (wrongBase) throw new FolderGone(`The project's folder does not exist: ${wrongBase}. The run did not start, so the bot is not left to work in another folder.`)
  if (!fs.existsSync(cwd)) throw new FolderGone(`The folder this run would start in does not exist: ${cwd}.`)
  const config = agent.adapterConfig || {}
  const override = store.object('SELECT raw FROM jobs WHERE id = ?', job.id).assigneeAdapterOverrides || {}
  const model = override.model || config.model || ''

  // It is carried on unless a fresh one was asked for, the folder moved, or the folder it was in is gone: then the run starts a
  // fresh session in the current folder and is told so.
  const session = !wake.payload?.forceFreshSession && keptFolder && !sessionFolderGone && keptFolder === cwd && kept.adapterType === agent.adapterType ? kept.sessionParamsJson.sessionId : ''
  const freshBecauseGone = sessionFolderGone && !wake.payload?.forceFreshSession ? keptFolder : ''

  const runId = randomUUID()
  const runDir = path.join(runsDir(dataDir), runId)
  fs.mkdirSync(runDir, { recursive: true })
  const logRef = path.join(company.id || 'studio', agent.id, `${runId}.ndjson`)
  const logFile = path.join(runLogsDir(dataDir), logRef)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })

  // What was said and settled since this bot's last run here: the news it is woken for.
  const last = store.objects("SELECT raw FROM runs WHERE job_id = ? AND agent_id = ? AND status NOT IN ('running', 'queued') ORDER BY created_at DESC LIMIT 1", job.id, agent.id)[0]
  const since = last?.startedAt || ''
  const comments = store.objects('SELECT raw FROM comments WHERE job_id = ? ORDER BY position', job.id).filter((c) => !c.deletedAt && c.authorAgentId !== agent.id && (!since || c.createdAt > since)).slice(-20)
  const cards = store.objects('SELECT raw FROM cards WHERE job_id = ? ORDER BY position', job.id).filter((c) => since && c.resolvedAt && c.resolvedAt > since)
  const names = new Map(store.rows('SELECT id, name FROM agents').map((a) => [a.id, a.name]))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `botyard-run-${job.identifier.toLowerCase()}-`))
  const files = filesForRun(store, job, agent, comments, since, path.join(scratch, 'files'), { dataDir })
  const prompt = wakePrompt({ agent, company, job, wake, branch: workspace?.branchName || '', startFrom: workspace?.startFrom || '', startMissing: workspace?.startFromMissing || '', comments, cards, files, resumed: Boolean(session), sessionFolderGone: freshBecauseGone, inline: inlinesInstructions(agent), names })
  const promptFile = path.join(runDir, 'prompt.txt')
  fs.writeFileSync(promptFile, prompt)
  const mcpConfig = path.join(runDir, 'mcp.json')
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }))

  const token = issueToken(store, runId, agent.id)
  const mayNot = mayNotOf(agent)
  const { command, args, env: toolEnv = {} } = commandFor(agent, { model, session, cwd, instructionsFile: instructionsOf(agent).file, mcpConfig, mayNot, readDirs: files.length ? [path.join(scratch, 'files')] : [] })
  const runEnv = {
    HOME: env.HOME, PATH: env.PATH, LANG: env.LANG || 'C.UTF-8', USER: env.USER, SHELL: env.SHELL, SSH_AUTH_SOCK: env.SSH_AUTH_SOCK, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, DISPLAY: env.DISPLAY, WAYLAND_DISPLAY: env.WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
    ...toolEnv,
    // A free-model bot gets the providers' keys the owner pasted on the setup page; its own variables win.
    ...(agent.adapterType === 'opencode_local' ? providerKeys(dataDir) : {}),
    ...botEnv(envForRun(dataDir, agent), env),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    // The names the crew's rules and scripts already use, pointing at this engine.
    ...runVars({ apiUrl, apiKey: token, runId, jobId: job.id, botId: agent.id, studioId: company.id, wakeReason: wake.reason, wakeCommentId: wake.payload?.commentId, cwd, branch: workspace?.branchName, scratch, command }),
    ...(agent.adapterType === 'opencode_local' ? { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } : {}),
    // In the desktop app, Node.js is the app's own program run as plain Node: a run started with it has to be told so.
    ...(process.versions.electron && command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
  if (agent.adapterType === 'opencode_local') runEnv.XDG_CONFIG_HOME = openCodeSettings(scratch, env)
  if (mayNot.length) {
    runEnv[MAY_NOT_VAR] = mayNot.join(',')
    runEnv.PATH = `${gitGuard(scratch, mayNot)}:${runEnv.PATH || '/usr/local/bin:/usr/bin:/bin'}`
  }
  for (const key of Object.keys(runEnv)) if (runEnv[key] === undefined) delete runEnv[key]

  const spec = {
    runId, command, args, cwd, env: runEnv, promptFile, logFile,
    resultFile: path.join(runDir, 'result.json'), pidFile: path.join(runDir, 'pid.json'),
    timeoutSec: Number(config.timeoutSec) || DEFAULT_TIMEOUT_SEC, graceSec: Number(config.graceSec) || 15,
  }
  const specFile = path.join(runDir, 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 })

  const made = {
    id: runId, companyId: company.id || null, agentId: agent.id, scopeKind: 'issue', issueId: job.id,
    invocationSource: wake.source, triggerDetail: wake.reason, wakeupRequestId: wake.id, status: 'running',
    startedAt: iso(now), finishedAt: null, error: null, errorCode: null, exitCode: null, signal: null, usageJson: null, resultJson: null,
    sessionIdBefore: session || null, sessionIdAfter: null, logStore: 'local_file', logRef, logBytes: 0, stdoutExcerpt: '', stderrExcerpt: '',
    retryOfRunId: wake.payload?.failedRunId || null, contextSnapshot: { issueId: job.id, wakeReason: wake.reason, wakeSource: wake.source, model, cwd, command, args: args.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…` : a)) },
    createdAt: iso(now), updatedAt: iso(now),
  }
  store.tx(() => {
    store.put('runs', made)
    store.put('job_runs', { runId }, { job_id: job.id, position: store.row('SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ?', job.id).n })
    store.put('wakes', { ...wake, status: 'claimed', runId, claimedAt: iso(now), updatedAt: iso(now) })
    const fresh = store.object('SELECT raw FROM jobs WHERE id = ?', job.id)
    if (fresh.status === 'todo' || fresh.status === 'backlog') store.put('jobs', { ...fresh, status: 'in_progress', startedAt: fresh.startedAt || iso(now), updatedAt: iso(now) })
    store.put('agents', { ...store.object('SELECT raw FROM agents WHERE id = ?', agent.id), lastHeartbeatAt: iso(now) })
  })
  io.startKeeper(specFile)
  return made
}

// ── ending ──────────────────────────────────────────────────────────────────────────

/** The tool's own output lines out of a run's log, and the tail of each stream. */
function readLog(logFile) {
  const out = { lines: [], stdout: '', stderr: '' }
  let text = ''
  try { text = fs.readFileSync(logFile, 'utf8') } catch { return out }
  let pending = ''
  for (const row of text.split('\n')) {
    if (!row) continue
    let e
    try { e = JSON.parse(row) } catch { continue }
    if (e.stream === 'stderr') { out.stderr = (out.stderr + e.chunk).slice(-EXCERPT); continue }
    out.stdout = (out.stdout + e.chunk).slice(-EXCERPT)
    pending += e.chunk
    const parts = pending.split('\n')
    pending = parts.pop()
    out.lines.push(...parts.filter(Boolean))
  }
  if (pending) out.lines.push(pending)
  return out
}

/** Book a run that has ended: its status, tokens and session, and the wake that asked for it. */
export function finishRun(store, made, result, { dataDir, now = Date.now() } = {}) {
  const agent = store.object('SELECT raw FROM agents WHERE id = ?', made.agentId) || {}
  const log = readLog(path.join(runLogsDir(dataDir), made.logRef || ''))
  const read = readOutput(agent.adapterType, log.lines)
  const status = result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out' : result.exitCode === 0 && !read.failed ? 'succeeded' : 'failed'
  const why = status === 'succeeded' ? null
    : result.cancelled ? 'Cancelled'
      : result.timedOut ? 'It was stopped at its time limit'
        : read.why || result.error || (log.stderr.trim().split('\n').at(-1) || '').slice(0, 400) || (result.lost ? 'Its keeper stopped without leaving a result' : `The tool ended with code ${result.exitCode}`)
  // `partial` says the tool never added its tokens up (the run was cut): the counts are what its messages reported, at least.
  const usage = { model: read.model || made.contextSnapshot?.model || '', inputTokens: read.inputTokens, cachedInputTokens: read.cachedInputTokens, outputTokens: read.outputTokens, ...(read.partial ? { partial: true } : {}), costUsd: read.costUsd, billingType: 'subscription_included' }
  const done = {
    ...made, status, finishedAt: result.finishedAt || iso(now), exitCode: result.exitCode ?? null, signal: result.signal || null,
    error: why, errorCode: status === 'timed_out' ? 'timeout' : status === 'failed' ? 'adapter_failed' : null,
    usageJson: usage, resultJson: { summary: read.said.slice(0, 2000) }, sessionIdAfter: read.session || made.sessionIdBefore || null,
    logBytes: result.logBytes || 0, stdoutExcerpt: log.stdout, stderrExcerpt: log.stderr, updatedAt: iso(now),
  }
  const job = store.object('SELECT raw FROM jobs WHERE id = ?', made.issueId)
  store.tx(() => {
    store.put('runs', done)
    const wake = store.object('SELECT raw FROM wakes WHERE id = ?', made.wakeupRequestId || '')
    if (wake) store.put('wakes', { ...wake, status: status === 'succeeded' ? 'completed' : status === 'timed_out' ? 'timed_out' : status === 'cancelled' ? 'cancelled' : 'failed', finishedAt: iso(now), error: why, updatedAt: iso(now) })
    if (read.session) {
      const before = store.objects('SELECT raw FROM sessions WHERE agent_id = ? AND task_key = ?', made.agentId, made.issueId).at(-1)
      store.put('sessions', {
        ...(before || { id: randomUUID(), companyId: made.companyId, agentId: made.agentId, taskKey: made.issueId, createdAt: iso(now) }),
        adapterType: agent.adapterType, sessionParamsJson: { sessionId: read.session, cwd: made.contextSnapshot?.cwd || '' }, sessionDisplayId: read.session, lastRunId: made.id, lastError: why, updatedAt: iso(now),
      }, { position: before ? store.row('SELECT position FROM sessions WHERE id = ?', before.id).position : store.row('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?', made.agentId).n })
    }
    if (usage.inputTokens || usage.outputTokens || usage.cachedInputTokens) {
      store.put('usage', { id: randomUUID(), companyId: made.companyId, heartbeatRunId: made.id, agentId: made.agentId, issueId: made.issueId, projectId: job?.projectId || null, provider: providerOf(agent.adapterType), biller: providerOf(agent.adapterType), billingType: 'subscription_included', model: usage.model, costStatus: 'unpriced', inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens, costCents: 0, occurredAt: iso(now) })
    }
    store.put('activity', { id: randomUUID(), action: `heartbeat.${status}`, entityType: 'heartbeat_run', entityId: made.id, actorType: 'system', actorId: 'engine', agentId: made.agentId, runId: made.id, details: { issueId: made.issueId }, createdAt: iso(now) })
  })
  dropToken(store, made.id)
  answerInChat(store, made, job, status, read.said, now)
  // A run that failed because the session it was to carry on is gone is tried once more from a fresh one.
  if (status === 'failed' && made.sessionIdBefore && !read.session && sessionIsGone(`${why}\n${log.stderr}\n${log.stdout}`) && job && !['done', 'cancelled'].includes(job.status)) {
    store.tx(() => {
      for (const kept of store.objects('SELECT raw FROM sessions WHERE agent_id = ? AND task_key = ?', made.agentId, made.issueId)) store.drop('sessions', kept.id)
      store.put('wakes', {
        id: randomUUID(), companyId: made.companyId, agentId: made.agentId, source: 'automation', reason: 'retry_failed_run', status: 'queued', coalescedCount: 0,
        payload: { issueId: made.issueId, forceFreshSession: true, failedRunId: made.id }, requestedByActorType: 'system', requestedByActorId: 'engine',
        runId: null, requestedAt: iso(now), claimedAt: null, finishedAt: null, error: null, createdAt: iso(now), updatedAt: iso(now),
      })
    })
  }
  return done
}

/**
 * In a chat, what the bot said at the end of its run is its answer: it is put in the conversation as the
 * bot's message, unless the bot already wrote there itself during the run.
 */
function answerInChat(store, made, job, status, said, now) {
  if (status !== 'succeeded' || !job || job.conversationAgentId !== made.agentId || !String(said || '').trim()) return
  const wrote = store.row('SELECT COUNT(*) AS n FROM comments WHERE job_id = ? AND created_by_run_id = ?', job.id, made.id).n
  if (wrote) return
  addComment(store, job.id, { body: said }, { now, actor: { agent: made.agentId, run: made.id } })
}

/** Ask a live run to stop. Its keeper ends the tool and leaves the result, which the next tick books. */
export function cancelRun(store, runId, { dataDir, io = realIo } = {}) {
  const made = store.object('SELECT raw FROM runs WHERE id = ?', runId)
  if (!made || made.status !== 'running') return false
  try { io.stop(JSON.parse(fs.readFileSync(path.join(runsDir(dataDir), runId, 'pid.json'), 'utf8')).keeper) } catch { return false }
  return true
}

// ── the tick ────────────────────────────────────────────────────────────────────────

/** How long a run may have no keeper and no result before it is called lost: the keeper needs a moment to start. */
const LOST_AFTER_MS = 20_000

export async function tick(store, { dataDir, apiUrl, io = realIo, now = Date.now(), env = process.env } = {}) {
  const report = { finished: [], started: [], skipped: [] }
  for (const made of liveRuns(store, "status = 'running'")) {
    const dir = path.join(runsDir(dataDir), made.id)
    let result = null
    try { result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) } catch { /* still going, or lost */ }
    if (!result) {
      let pid = 0
      try { pid = JSON.parse(fs.readFileSync(path.join(dir, 'pid.json'), 'utf8')).keeper } catch { /* not written yet */ }
      if (io.alive(pid) || now - Date.parse(made.startedAt) < LOST_AFTER_MS) continue
      result = { exitCode: null, lost: true, finishedAt: iso(now) }
    }
    report.finished.push(finishRun(store, made, result, { dataDir, now }))
  }
  // The owner's conversation with a bot goes first: a message from the owner is not left behind the bot's queued
  // jobs (18 Nov: a question waited eleven minutes behind four crew jobs). Otherwise, oldest first.
  const queued = store.objects("SELECT raw FROM wakes WHERE status = 'queued' ORDER BY requested_at")
    .map((wake) => ({ wake, job: store.object('SELECT raw FROM jobs WHERE id = ?', wake.payload?.issueId || '') }))
    .sort((a, b) => Number(Boolean(b.job?.conversationAgentId)) - Number(Boolean(a.job?.conversationAgentId)))
  for (const { wake, job } of queued) {
    const agent = store.object('SELECT raw FROM agents WHERE id = ?', wake.agentId)
    const held = hold(store, wake, agent, job)
    if (held.skip) { store.put('wakes', { ...wake, status: 'skipped', error: held.skip, finishedAt: iso(now), updatedAt: iso(now) }); report.skipped.push({ id: wake.id, why: held.skip }); continue }
    if (held.wait) continue
    try {
      report.started.push(await startRun(store, wake, { dataDir, apiUrl, io, now, env }))
    } catch (err) {
      const why = err instanceof AdapterError ? err.message : `The run could not be set up: ${err.message}`
      store.put('wakes', { ...wake, status: 'failed', error: why, finishedAt: iso(now), updatedAt: iso(now) })
      report.skipped.push({ id: wake.id, why })
    }
  }
  return report
}
