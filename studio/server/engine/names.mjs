/**
 * Every name the engine gives to something outside itself, in one place: the variables a run is
 * told, the folder a job is worked in, and the folders under the engine's data folder. The rest of
 * the engine asks here and never writes one of these out by hand, so renaming them is a change to
 * this file alone.
 */
import os from 'node:os'
import path from 'node:path'

/** The start of every variable a run is told. */
const RUN_PREFIX = 'BOTYARD_'

/** The variables a run is told, by what each one is. */
export const RUN_VARS = {
  apiUrl: `${RUN_PREFIX}API_URL`,
  apiKey: `${RUN_PREFIX}API_KEY`,
  runId: `${RUN_PREFIX}RUN_ID`,
  jobId: `${RUN_PREFIX}JOB_ID`,
  botId: `${RUN_PREFIX}BOT_ID`,
  studioId: `${RUN_PREFIX}ID`,
  wakeReason: `${RUN_PREFIX}WAKE_REASON`,
  wakeCommentId: `${RUN_PREFIX}WAKE_COMMENT_ID`,
  cwd: `${RUN_PREFIX}WORKSPACE_CWD`,
  branch: `${RUN_PREFIX}WORKSPACE_BRANCH`,
  scratch: `${RUN_PREFIX}SCRATCH_DIR`,
  command: `${RUN_PREFIX}RESOLVED_COMMAND`,
}

/** The run's variables with their values: `{ apiUrl: 'http://…' }` → `{ <name>: 'http://…' }`. Anything not given is ''. */
export function runVars(values = {}) {
  const out = {}
  for (const [what, name] of Object.entries(RUN_VARS)) out[name] = values[what] === undefined || values[what] === null ? '' : String(values[what])
  // Says which engine woke the bot, for the crew's launchers.
  out.BOTYARD_ENGINE = '1'
  return out
}

/** How a run's own pass starts, so the engine knows its own at a glance. */
export const PASS_PREFIX = 'stu_'

/** A job's own folder inside its project's repository. */
export const worktreeDir = (repo, name) => path.join(repo, '.botyard', 'worktrees', name)

// ── the engine's own variables and folders ──────────────────────────────────────────

/** What the engine itself reads from its surroundings when started directly. */
export const ENGINE_VARS = { port: 'BOTYARD_ENGINE_PORT', dataDir: 'BOTYARD_HOME', runs: 'BOTYARD_ENGINE_RUNS' }
export const DEFAULT_PORT = 3210

/** The data folder when none is given: Botyard's home folder, `~/.botyard`. */
export const defaultDataDir = () => path.join(os.homedir(), '.botyard')

export const storeFile = (dataDir) => path.join(dataDir, 'studio.db')
export const runLogsDir = (dataDir) => path.join(dataDir, 'run-logs')
export const runsDir = (dataDir) => path.join(dataDir, 'runs')
export const filesDir = (dataDir) => path.join(dataDir, 'files')
/** Secret values: a folder only the owner can read. */
export const keysDir = (dataDir) => path.join(dataDir, 'keys')
export const botSecretsFile = (dataDir) => path.join(keysDir(dataDir), 'bot-env.json')
/** The instructions of bots that have no file of their own elsewhere. */
export const instructionsDir = (dataDir) => path.join(dataDir, 'instructions')
/** What a hidden value reads as. */
export const HIDDEN = '***REDACTED***'
export const isHidden = (value) => /^\*+REDACTED\*+$/.test(String(value ?? ''))

/** What a bot is kept from, told to its run as words (push, commit, edit), for the tool's own guards. */
export const MAY_NOT_VAR = 'BOTYARD_MAY_NOT'

/**
 * Keys for the free-model providers, pasted on the setup page: one line each in the keys folder.
 * A free-model bot's run is handed the ones that are there, under the name the provider's tools read.
 */
export const PROVIDER_KEYS = { 'openrouter.key': 'OPENROUTER_API_KEY', 'nvidia.key': 'NVIDIA_API_KEY' }
