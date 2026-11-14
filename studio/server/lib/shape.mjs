/**
 * Shaping a studio: everything its owner does to set it up, for the map and the phone alike.
 *
 *   the crew      a bot's settings read for the editor and saved, a bot added (blank or from a
 *                 template the repository ships), removed, its variables set by name
 *   projects      added from a folder on this computer or a repository to copy, renamed, moved, archived
 *   first run     where an empty studio stands on its way to a first job, and its name
 *   setup         what the studio needs (AI tools, sign-ins, git) and the helper timetable, passed on
 *                 from the service's own modules when this process has them
 *
 * The engine is reached only through `call`. A bot's record carries commands, paths and variables;
 * the editor is given only what its form shows, and a variable's value never leaves this file: the
 * page sees its name and the word "set".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EngineError as Refusal, call, companyId, crewOf, engineBase, orElse } from './engine.mjs'
import { forgetReads } from './crew.mjs'
import * as homes from './home.mjs'
import { devicesFile, readDevices } from './devices.mjs'
import { modelLabel } from './models.mjs'
import { pcSkills } from './pc-skills.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..', '..', '..')
const MAX_NAME = 80
const MAX_TITLE = 160
const MAX_DOES = 600
const MAX_INSTRUCTIONS = 200_000
const MAX_VALUE = 8000
const MODEL = /^[\w.:/@+-]{1,120}$/
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** The engine's mark for a value it keeps to itself: sent back as it came, the stored value stays. */
const KEPT = '***REDACTED***'

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const whole = (value, min, max, words) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Refusal(400, words)
  return n
}

// ── which AI runs a bot ─────────────────────────────────────────────────────────────

const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Highest']]
/**
 * The four kinds of AI a bot can run on: the engine's own name for each, the setting its effort is
 * kept in, and the models offered first (any model id can be typed).
 */
export const AIS = {
  free: { type: 'opencode_local', name: 'Free models', about: 'Costs nothing and needs no account. Slower, and each model has a daily limit.', effortKey: 'variant', turns: false, setup: 'opencode',
    models: ['auto'] },
  claude: { type: 'claude_local', name: 'Claude', about: 'Your Claude subscription, through Claude Code.', effortKey: 'effort', turns: true, setup: 'claude',
    models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  codex: { type: 'codex_local', name: 'Codex', about: 'Your ChatGPT subscription, through Codex.', effortKey: 'modelReasoningEffort', turns: false, setup: 'codex',
    models: ['gpt-6.1-sol', 'gpt-6-luna'] },
  gemini: { type: 'gemini_local', name: 'Gemini', about: 'Your Google account, through Gemini.', effortKey: '', turns: false, setup: 'gemini',
    models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'] },
}
const AI_OF_TYPE = Object.fromEntries(Object.entries(AIS).map(([id, ai]) => [ai.type, id]))
const ROLES = [['general', 'General'], ['ceo', 'Leads the crew'], ['engineer', 'Builds'], ['qa', 'Checks'], ['researcher', 'Researches'], ['designer', 'Designs'], ['pm', 'Plans']]

const modelName = (id) => (id === 'auto' ? 'The best free model answering now' : modelLabel(id) || id)

// ── what a bot may not do ───────────────────────────────────────────────────────────

/** The three levels, strongest last. Every bot is kept from the first: it cannot be switched off here. */
export const MAY_NOT = [
  ['push', 'Push, merge, publish or delete', 'Always on. Sending work out of this computer is yours to do or approve.'],
  ['commit', 'Commit', 'For a bot that only reads and reports.'],
  ['edit', 'Change any file', 'For a reviewer: it reads, runs and judges, and changes nothing.'],
]
const DENY_PUSH = ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)', 'Bash(git worktree remove:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)', 'Bash(npm publish:*)', 'Bash(eas submit:*)', 'Bash(gh:*)']
const DENY = { push: DENY_PUSH, commit: [...DENY_PUSH, 'Bash(git commit:*)'], edit: [...DENY_PUSH, 'Edit', 'Write', 'NotebookEdit', 'Bash(git commit:*)'] }

/** What the page sent as the levels kept: always `push`, and the strongest of the rest. */
function mayNotOf(value) {
  const asked = new Set(Array.isArray(value) ? value : [])
  return asked.has('edit') ? ['push', 'edit'] : asked.has('commit') ? ['push', 'commit'] : ['push']
}

/** The levels a bot is under now: what Botyard wrote, or read off a Claude bot's own deny list. */
function mayNotNow(config = {}) {
  if (Array.isArray(config.mayNot)) return mayNotOf(config.mayNot)
  const args = Array.isArray(config.extraArgs) ? config.extraArgs : []
  const at = args.indexOf('--disallowedTools')
  const deny = at >= 0 ? String(args[at + 1] || '').split(',') : []
  return deny.includes('Edit') ? ['push', 'edit'] : deny.includes('Bash(git commit:*)') ? ['push', 'commit'] : ['push']
}

/** A Claude bot's own arguments with its deny list set to match the levels. */
function withDeny(extraArgs, levels) {
  const args = (Array.isArray(extraArgs) ? extraArgs : []).map(String)
  const at = args.indexOf('--disallowedTools')
  if (at >= 0) args.splice(at, 2)
  return [...args, '--disallowedTools', DENY[levels[levels.length - 1]].join(',')]
}

// ── a bot's settings, for the editor ────────────────────────────────────────────────

const botPath = (botId) => {
  if (!ID.test(botId || '')) throw new Refusal(400, 'That is not a bot id')
  return `/agents/${botId}`
}

const OPEN = 'status=in_progress,in_review,blocked,todo,backlog'

/** The jobs a bot still has open: what the page says before it is removed. */
async function openJobsOf(id, botId, options) {
  const jobs = await orElse(call(`/companies/${id}/issues?view=compact&assigneeAgentId=${botId}&${OPEN}&limit=200`, options), [])
  return jobs.filter((j) => !j.conversationAgentId).length
}

/** A variable by name only. `secret` says the engine keeps it out of every read. */
const variablesOf = (env) => Object.entries(env && typeof env === 'object' ? env : {})
  .map(([name, v]) => ({ name, secret: Boolean(v && typeof v === 'object' && v.type === 'secret'), set: !(v && typeof v === 'object' && v.set === false) }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** Every skill on this computer by name, and which of them this bot is given. */
function skillsOf(agent, options) {
  const all = pcSkills(options).map((s) => ({ name: s.name, about: String(s.description || '').slice(0, 160), given: Array.isArray(s.bots) && s.bots.includes(agent.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const choice = agent.adapterConfig?.skills
  const mode = choice === 'all' ? 'all' : Array.isArray(choice) ? 'list' : 'set'
  const picked = new Set(Array.isArray(choice) ? choice.map(String) : [])
  return { mode, all: all.map((s) => ({ name: s.name, about: s.about, on: mode === 'all' || (mode === 'list' ? picked.has(s.name) : s.given) })) }
}

/**
 * Everything the editor's form shows of one bot, and the choices each field offers. `connectors`
 * is the list the Connectors page gives; only this bot's level in each is kept.
 */
export async function botSettings(botId, { connectors = null, ...options } = {}) {
  const where = botPath(botId)
  const id = await companyId(options)
  const [agent, crew, openJobs] = await Promise.all([call(where, options), crewOf(id, options), openJobsOf(id, botId, options)])
  const config = agent.adapterConfig || {}
  const ai = AI_OF_TYPE[agent.adapterType] || ''
  const kind = AIS[ai]
  const model = typeof config.model === 'string' ? config.model : ''
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title || '',
    role: agent.role || 'general',
    does: agent.capabilities || '',
    reportsTo: agent.reportsTo || '',
    paused: agent.status === 'paused',
    ai,
    model,
    effort: kind?.effortKey ? String(config[kind.effortKey] || '') : '',
    minutes: Math.max(1, Math.round((Number(config.timeoutSec) || 3600) / 60)),
    turns: Number(config.maxTurnsPerRun) || null,
    atOnce: Number(agent.runtimeConfig?.heartbeat?.maxConcurrentRuns) || 1,
    mayNot: mayNotNow(config),
    mayNotKept: ai === 'claude',
    skills: skillsOf(agent, options),
    variables: variablesOf(config.env),
    openJobs,
    reports: crew.filter((a) => a.reportsTo === agent.id).map((a) => a.name),
    connectors: (connectors || []).map((c) => ({ id: c.id, name: c.name, level: c.bots?.find((b) => b.id === agent.id)?.level || 'off' })),
    choices: {
      bosses: crew.filter((a) => a.id !== agent.id).map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
      ...choices(ai, model),
    },
  }
}

/** The choices a bot's form offers, whoever the bot is: for the editor and for "Add a bot". A bot's own model is always among its AI's. */
export function choices(ai = '', model = '') {
  return {
    roles: ROLES.map(([id, name]) => ({ id, name })),
    efforts: EFFORTS.map(([id, name]) => ({ id, name })),
    mayNot: MAY_NOT.map(([id, name, about]) => ({ id, name, about })),
    ais: Object.entries(AIS).map(([id, kind]) => ({
      id, name: kind.name, about: kind.about, effort: Boolean(kind.effortKey), turns: kind.turns, setup: kind.setup,
      models: [...new Set([...(id === ai && model ? [model] : []), ...kind.models])].map((m) => ({ id: m, name: modelName(m) })),
    })),
  }
}

/** The bots a new one can answer to, with the same choices: what "Add a bot" opens on. */
export async function newBotChoices(options = {}) {
  const id = await companyId(options)
  const crew = await crewOf(id, options)
  return {
    choices: { bosses: crew.map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)), ...choices() },
    lead: crew.find((a) => a.role === 'ceo')?.id || '',
    templates: templates(options),
  }
}

// ── saving a bot ────────────────────────────────────────────────────────────────────

/** The fields a form sent, checked, as `{ top, config, atOnce }`: what goes on the bot, into its engine settings, and how many runs at once. */
function checked(input, { ai, crew, self = null }) {
  const top = {}
  const config = {}
  let atOnce
  if (input.name !== undefined) {
    const name = text(input.name, MAX_NAME + 1)
    if (!name) throw new Refusal(400, 'A bot needs a name')
    if (name.length > MAX_NAME) throw new Refusal(400, `Names are limited to ${MAX_NAME} characters`)
    if (crew.some((a) => a.id !== self && a.name.toLowerCase() === name.toLowerCase())) throw new Refusal(409, `Another bot is already called ${name}`)
    top.name = name
  }
  if (input.title !== undefined) top.title = text(input.title, MAX_TITLE)
  if (input.does !== undefined) top.capabilities = text(input.does, MAX_DOES)
  if (input.role !== undefined) {
    if (!ROLES.some(([id]) => id === input.role)) throw new Refusal(400, 'Choose what kind of work it does')
    top.role = input.role
  }
  if (input.reportsTo !== undefined) {
    const boss = input.reportsTo || null
    if (boss) {
      if (boss === self) throw new Refusal(400, 'A bot cannot answer to itself')
      if (!crew.some((a) => a.id === boss)) throw new Refusal(400, 'The bot it answers to is not in this studio')
      // No circles: the one it answers to must not answer, directly or through others, to it.
      const by = new Map(crew.map((a) => [a.id, a.reportsTo || null]))
      for (let up = by.get(boss), n = 0; up && n < crew.length; up = by.get(up), n++) {
        if (up === self) throw new Refusal(400, 'That would make a circle: the bot you picked answers to this one')
      }
    }
    top.reportsTo = boss
  }
  const kind = AIS[ai]
  if (input.model !== undefined) {
    const model = text(input.model, 121)
    if (!MODEL.test(model)) throw new Refusal(400, 'Choose a model')
    config.model = model
  }
  if (input.effort !== undefined && kind?.effortKey) {
    if (input.effort && !EFFORTS.some(([id]) => id === input.effort)) throw new Refusal(400, 'Choose low, medium, high or highest effort')
    if (input.effort) config[kind.effortKey] = input.effort
  }
  if (input.minutes !== undefined) config.timeoutSec = whole(input.minutes, 1, 600, 'A run may take 1 to 600 minutes') * 60
  if (input.turns !== undefined && kind?.turns && input.turns !== null && input.turns !== '') config.maxTurnsPerRun = whole(input.turns, 1, 2000, 'A run may take 1 to 2000 turns')
  if (input.atOnce !== undefined) atOnce = whole(input.atOnce, 1, 10, 'A bot runs 1 to 10 jobs at once')
  if (input.mayNot !== undefined) config.mayNot = mayNotOf(input.mayNot)
  if (input.skills !== undefined) {
    const s = input.skills
    if (s !== 'set' && s !== 'all' && !(Array.isArray(s) && s.length <= 300 && s.every((n) => typeof n === 'string' && n.length <= 120))) throw new Refusal(400, 'Choose which skills it is given')
    config.skills = s
  }
  return { top, config, atOnce }
}

/** A bot's engine settings for an AI it was not on before: what carries over, and nothing of the old tool's own. */
function movedConfig(before, ai) {
  const keep = {}
  for (const key of ['cwd', 'env', 'instructionsFilePath', 'timeoutSec', 'graceSec', 'mayNot', 'skills']) if (before[key] !== undefined) keep[key] = before[key]
  // Bots run with nobody at the keyboard: a tool that stops to ask for permission would never finish.
  if (ai === 'claude' || ai === 'free') keep.dangerouslySkipPermissions = true
  return keep
}

/**
 * Save what the editor's form changed. Only the fields sent are touched; a change of AI replaces
 * the bot's engine settings with clean ones for the new AI, keeping its folder, variables,
 * instructions, time limit and what it may not do.
 */
export async function saveBot(botId, input = {}, options) {
  const where = botPath(botId)
  const id = await companyId(options)
  const [agent, crew] = await Promise.all([call(where, options), crewOf(id, options)])
  const was = AI_OF_TYPE[agent.adapterType] || ''
  let ai = was
  if (input.ai !== undefined) {
    if (!Object.hasOwn(AIS, input.ai)) throw new Refusal(400, 'Choose which AI runs it')
    ai = input.ai
  }
  const moved = ai !== was
  if (moved && input.model === undefined) throw new Refusal(400, 'Choose a model for the new AI')
  const { top, config, atOnce } = checked(input, { ai, crew, self: agent.id })
  const before = agent.adapterConfig || {}
  const body = { ...top }
  if (moved) {
    body.adapterType = AIS[ai].type
    body.adapterConfig = { ...movedConfig(before, ai), ...config }
    body.replaceAdapterConfig = true
  } else if (Object.keys(config).length) {
    body.adapterConfig = config
  }
  // A Claude bot's deny list is the tool's own flag: kept in step with the levels whenever either changes.
  if (ai === 'claude' && (moved || config.mayNot)) {
    body.adapterConfig = { ...(body.adapterConfig || {}), extraArgs: withDeny(moved ? [] : before.extraArgs, config.mayNot || mayNotNow(before)) }
  }
  if (atOnce !== undefined) {
    const runtime = agent.runtimeConfig && typeof agent.runtimeConfig === 'object' ? agent.runtimeConfig : {}
    body.runtimeConfig = { ...runtime, heartbeat: { ...(runtime.heartbeat || {}), maxConcurrentRuns: atOnce } }
  }
  if (!Object.keys(body).length) throw new Refusal(400, 'Nothing to change')
  await call(where, { ...options, method: 'PATCH', body })
  forgetReads()
  // The crew's seeder puts that AI's launcher and no-push settings on a bot of the seeded set.
  const launcher = moved ? await reseed(top.name || agent.name, options).catch(() => null) : null
  if (launcher) forgetReads()
  return { ok: true, changed: Object.keys(input).filter((k) => input[k] !== undefined), moved, ...(launcher === null ? {} : { launcher }) }
}

/** Set one variable's value, or add it. The value goes to the engine and is never read back. */
export async function setVariable(botId, name, value, options) {
  const where = botPath(botId)
  const key = text(name, 65)
  if (!VARIABLE.test(key)) throw new Refusal(400, 'A variable\'s name is letters, digits and underscores, like API_TOKEN')
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE) throw new Refusal(400, 'Give the variable a value')
  const agent = await call(where, options)
  const env = { ...(agent.adapterConfig?.env && typeof agent.adapterConfig.env === 'object' ? agent.adapterConfig.env : {}) }
  env[key] = { type: 'secret', value }
  await call(where, { ...options, method: 'PATCH', body: { adapterConfig: { env } } })
  forgetReads()
  return { ok: true, variables: variablesOf(env) }
}

/** Take one variable away from a bot. */
export async function removeVariable(botId, name, options) {
  const where = botPath(botId)
  const agent = await call(where, options)
  const env = { ...(agent.adapterConfig?.env && typeof agent.adapterConfig.env === 'object' ? agent.adapterConfig.env : {}) }
  if (!Object.hasOwn(env, name)) throw new Refusal(404, 'This bot has no variable by that name')
  delete env[name]
  await call(where, { ...options, method: 'PATCH', body: { adapterConfig: { env } } })
  forgetReads()
  return { ok: true, variables: variablesOf(env) }
}

/**
 * Remove a bot. Its history stays; its runs stop and nothing new is given to it. The answer says how
 * many open jobs it leaves behind, which the page told the owner before asking.
 */
export async function removeBot(botId, options) {
  const where = botPath(botId)
  const id = await companyId(options)
  const [agent, openJobs] = await Promise.all([call(where, options), openJobsOf(id, botId, options)])
  await call(where, { ...options, method: 'DELETE' })
  forgetReads()
  return { ok: true, name: agent.name, openJobs }
}

// ── the crew's own seeder ───────────────────────────────────────────────────────────

const SEED_TIME_MS = 120_000
/**
 * `crew/setup-bots.py` is what gives a bot its launcher, its PATH and its no-push settings for the AI
 * it runs on, and what remembers which bots a studio was seeded with. Botyard runs it for the two
 * things only it can finish: the starter crew, and a bot moved to another AI. It writes into the
 * studio's own crew folder, so it is run only by the one service (which names the engine and the
 * folders together) or where `BOTYARD_SEEDER=on` says the folders are this engine's; a test with its
 * own engine never runs it. Everywhere else the bots are made through the engine alone.
 */
function seederFor(options = {}) {
  if (options.seed) return options.seed
  if (options.fetcher || options.crewRepo || process.env.BOTYARD_CREW_SETS) return null
  if (!process.env.BOTYARD_API_URL && process.env.BOTYARD_SEEDER !== 'on') return null
  const script = path.join(REPO, 'crew', 'setup-bots.py')
  if (!fs.existsSync(script)) return null
  return (args) => new Promise((resolve) => {
    execFile('python3', [script, ...args, '--api', engineBase()], { timeout: SEED_TIME_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '').trim().split('\n').pop() || '' })
    })
  })
}

/** After a bot moved to another AI: its launcher and safety settings for that AI, when it is one of the seeded set. */
async function reseed(name, options) {
  const seed = seederFor(options)
  if (!seed) return null
  const list = await seed(['--list'])
  let slug = ''
  try { slug = (JSON.parse(list.out).bots || []).find((b) => b.name === name)?.slug || '' } catch { /* not a list: leave the bot as the engine has it */ }
  if (!list.ok || !slug) return null
  return (await seed(['--only', slug])).ok
}

// ── templates, and a new bot ────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/
/**
 * The sets of bots the repository ships. The default crew is `crew/bots`: the worked-out crew a new
 * yard starts from. An older or packaged copy may still carry it as `crew/starter`, which then wins.
 */
const SETS = [['starter', 'Default crew'], ['bots', 'Default crew']]
/** Which shipped set is the default crew in this copy. */
const defaultSet = (options) => (fs.existsSync(path.join(setsRoot(options), 'starter', 'crew.json')) ? 'starter' : 'bots')
/** Where the shipped sets are: the repository's crew folder, unless a test or a packaged copy says otherwise. */
const setsRoot = (options) => options?.crewRepo || process.env.BOTYARD_CREW_SETS || path.join(REPO, 'crew')

const readJson = (file) => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null } catch { return null } }
const readText = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }

function templateOf(set, slug, options) {
  if (!SETS.some(([id]) => id === set) || !SLUG.test(slug || '')) return null
  const dir = path.join(setsRoot(options), set)
  const bot = readJson(path.join(dir, `${slug}.json`))
  if (!bot || typeof bot.name !== 'string') return null
  return { set, slug, dir, bot, crew: readJson(path.join(dir, 'crew.json')) || {} }
}

/** Every template by name and what it is for; nothing of its instructions. */
export function templates(options = {}) {
  const out = []
  const first = defaultSet(options)
  for (const [set, setName] of SETS) {
    const dir = path.join(setsRoot(options), set)
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    // In the order the set gives its bots (the lead first), then by name.
    const about = readJson(path.join(dir, 'crew.json'))
    const order = Array.isArray(about?.bots) ? about.bots : about?.order
    const at = (file) => { const n = Array.isArray(order) ? order.indexOf(file.slice(0, -5)) : -1; return n < 0 ? 1e6 : n }
    for (const file of files.sort((a, b) => at(a) - at(b) || a.localeCompare(b))) {
      if (!file.endsWith('.json') || file === 'crew.json' || file.startsWith('.')) continue
      const t = templateOf(set, file.slice(0, -5), options)
      if (!t) continue
      const ai = Object.hasOwn(AIS, t.bot.ai) ? t.bot.ai : 'free'
      out.push({ id: `${set}/${t.slug}`, set, setName, default: set === first, name: t.bot.name, title: text(t.bot.title, MAX_TITLE), does: text(t.bot.does, MAX_DOES), ai, aiName: AIS[ai].name, model: modelName(String(t.bot.model || 'auto')), needs: typeof t.bot.needs === 'string' ? t.bot.needs : '', fields: templateInput(t, null) })
    }
  }
  return out
}

/**
 * A template's instructions as the bot is given them: shared paragraphs put in, and the names the
 * text uses filled. A mark this does not know is left out rather than shown to the bot as braces.
 */
export function renderInstructions(t, { name, title, studio = 'My studio', ai = 'free', crewDir = '' } = {}) {
  const source = readText(path.join(t.dir, `${t.slug}.md`))
  const shared = (file) => readText(path.join(t.dir, 'shared', `${file}.md`)).replace(/\n$/, '')
  const places = t.crew.places && typeof t.crew.places === 'object' ? t.crew.places : {}
  const names = { name, title, studio, home: os.homedir(), crew: crewDir, ...Object.fromEntries(Object.entries(places).filter(([, v]) => typeof v === 'string')) }
  const fill = (s) => s.replace(/\{\{\s*([a-z][\w-]*)\s*\}\}/gi, (mark, key) => (Object.hasOwn(names, key) ? String(names[key]).replaceAll('{{home}}', os.homedir()) : ''))
  return fill(source
    .replace(/\{\{\s*shared:\s*([\w-]+)\s*\}\}/g, (m, file) => shared(file))
    .replace(/\{\{\s*note:\s*[\w-]+\s*\}\}/g, () => shared(`on-${ai === 'free' ? 'free' : ai}`)))
    .replace(/\n{3,}/g, '\n\n').trim()
}

const BLANK_INSTRUCTIONS = (name, does) => `You are ${name}, a bot in this studio.

WHAT YOU DO
${does || 'Write here what this bot is for, in a sentence or two.'}

HOW YOU WORK
- Read the job you are given, and its comments, before you start.
- Work in the job's own folder. Commit your work with a clear message.
- When you are done, say what you did and what you could not do, and close the job.
- If you need the owner's answer, ask on the job and wait.
`

/** A template's settings as the form's own fields. */
function templateInput(t, bossId) {
  const b = t.bot
  const ai = Object.hasOwn(AIS, b.ai) ? b.ai : 'free'
  return {
    name: b.name, title: b.title || '', does: b.does || '', role: b.role || 'general', reportsTo: bossId || null, ai,
    model: typeof b.model === 'string' && b.model ? b.model : AIS[ai].models[0],
    ...(b.effort ? { effort: b.effort } : {}),
    ...(Number(b.minutes) ? { minutes: Number(b.minutes) } : {}),
    ...(Number(b.turns) ? { turns: Number(b.turns) } : {}),
    ...(Number(b.atOnce) ? { atOnce: Number(b.atOnce) } : {}),
    mayNot: Array.isArray(b.mayNot) ? b.mayNot : ['push'],
    ...(b.skills === 'all' || Array.isArray(b.skills) ? { skills: b.skills } : {}),
  }
}

/**
 * Add a bot: from nothing, or from a template (`from` is "starter/builder"), with whatever the form
 * changed laid over the template. A bot whose template says it starts off, or needs an AI that is
 * not signed in yet, is made paused.
 */
export async function addBot(input = {}, options = {}) {
  const id = await companyId(options)
  const [crew, company] = await Promise.all([crewOf(id, options), orElse(call(`/companies/${id}`, options), {})])
  let t = null
  if (input.from) {
    const [set, slug] = String(input.from).split('/')
    t = templateOf(set, slug, options)
    if (!t) throw new Refusal(404, 'That template is not in this copy of Botyard')
  }
  const sent = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && v !== '' && !['from', 'instructions'].includes(k)))
  const fields = { role: 'general', mayNot: ['push'], minutes: 60, ...(t ? templateInput(t, input.reportsTo) : {}), ...sent }
  const ai = Object.hasOwn(AIS, fields.ai) ? fields.ai : null
  if (!ai) throw new Refusal(400, 'Choose which AI runs it')
  if (!fields.model) fields.model = AIS[ai].models[0]
  const { top, config, atOnce } = checked(fields, { ai, crew })
  if (!top.name) throw new Refusal(400, 'A bot needs a name')
  const instructions = typeof input.instructions === 'string' && input.instructions.trim() ? input.instructions
    : t ? renderInstructions(t, { name: top.name, title: top.title, studio: company?.name, ai, crewDir: options.crewDir || '' }) : ''
  if (instructions.length > MAX_INSTRUCTIONS) throw new Refusal(400, 'The instructions are too long')
  const adapterConfig = { ...movedConfig({}, ai), ...config }
  if (ai === 'claude') adapterConfig.extraArgs = withDeny([], config.mayNot || ['push'])
  const made = await call(`/companies/${id}/agents`, {
    ...options, method: 'POST',
    body: {
      ...top, adapterType: AIS[ai].type, adapterConfig,
      ...(atOnce ? { runtimeConfig: { heartbeat: { maxConcurrentRuns: atOnce } } } : {}),
      instructions: instructions || BLANK_INSTRUCTIONS(top.name, top.capabilities),
    },
  })
  const off = Boolean(t && (t.bot.on === false || t.bot.needs)) && input.on !== true
  if (off) await orElse(call(`/agents/${made.id}/pause`, { ...options, method: 'POST', body: {} }), null)
  forgetReads()
  return { id: made.id, name: made.name, paused: off, needs: t?.bot.needs || '' }
}

/**
 * The starter crew, whole: every bot of the repository's starter set that this studio does not have
 * yet, the lead first so the others can answer to it.
 */
export async function addStarterCrew(options = {}) {
  const id = await companyId(options)
  const set = defaultSet(options)
  const all = templates(options).filter((t) => t.set === set)
  if (!all.length) throw new Refusal(404, 'This copy of Botyard has no default crew: its crew/bots folder is empty. Add bots one at a time instead.')
  const crewFile = readJson(path.join(setsRoot(options), set, 'crew.json')) || {}
  const order = Array.isArray(crewFile.bots) ? crewFile.bots : Array.isArray(crewFile.order) ? crewFile.order : []
  const full = all.map((t) => templateOf(set, t.id.split('/')[1], options))
  const rank = (t) => { const at = order.indexOf(t.slug); return [t.bot.reportsTo ? 1 : 0, at < 0 ? order.length : at] }
  full.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || a.slug.localeCompare(b.slug))
  const before = await crewOf(id, options)
  const have = new Map(before.map((a) => [a.name.toLowerCase(), a.id]))
  // The seeder makes the same four bots and also links their launchers and remembers the set.
  const seed = seederFor(options)
  if (seed && (await seed(set === 'starter' ? ['--starter'] : [])).ok) {
    forgetReads()
    const made = (await crewOf(id, options)).filter((a) => !have.has(a.name.toLowerCase()))
    return { ok: true, added: made.map((a) => ({ id: a.id, name: a.name, paused: a.status === 'paused', needs: full.find((t) => t.bot.name === a.name)?.bot.needs || '' })), already: full.length - made.length }
  }
  const bySlug = new Map()
  const added = []
  for (const t of full) {
    const known = have.get(t.bot.name.toLowerCase())
    if (known) { bySlug.set(t.slug, known); continue }
    const made = await addBot({ from: `${set}/${t.slug}`, reportsTo: bySlug.get(t.bot.reportsTo) || null }, options)
    bySlug.set(t.slug, made.id)
    added.push({ id: made.id, name: made.name, paused: made.paused, needs: made.needs })
  }
  return { ok: true, added, already: full.length - added.length }
}

// ── projects ────────────────────────────────────────────────────────────────────────

const GIT_TIME_MS = 20_000
const CLONE_TIME_MS = 5 * 60_000
/** Run git with a list of arguments (never a shell line), asking nothing at a prompt. */
const runGit = (args, { cwd, timeout = GIT_TIME_MS } = {}) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim(), missing: err?.code === 'ENOENT' })
  })
})

/** A path as a person writes it: their home folder as ~. */
const tidy = (p) => (p === os.homedir() || p.startsWith(`${os.homedir()}${path.sep}`) ? `~${p.slice(os.homedir().length)}` : p)
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)
/** Where a copied repository is put: beside the others, in one folder the owner can find. */
export const projectsFolder = (env = process.env) => env.BOTYARD_PROJECTS || (homes.projectsDir ? homes.projectsDir(env) : path.join(homes.home(env), 'projects'))

/** A repository's address as git takes it: https, or the git@host:owner/name form. Nothing with spaces or options. */
const REPO_ADDRESS = /^(https:\/\/[\w.-]+(:\d+)?\/[\w.~/-]+?|git@[\w.-]+:[\w.~/-]+?)(\.git)?\/?$/
const repoName = (address) => address.replace(/\/$/, '').replace(/\.git$/, '').split(/[/:]/).pop().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'project'

/**
 * A folder the owner named, checked: it is on this computer, and it is a git repository (the crew
 * works in branches of it). `init` starts git in a folder that has none, when the owner said so.
 */
async function checkedFolder(folder, { init = false, git = runGit } = {}) {
  const typed = text(folder, 1000)
  if (!typed) throw new Refusal(400, 'Give the folder the project is in')
  const dir = path.resolve(expand(typed))
  if (!path.isAbsolute(expand(typed))) throw new Refusal(400, 'Give the whole path of the folder, like /home/you/projects/shop or ~/projects/shop')
  let stat = null
  try { stat = fs.statSync(dir) } catch { /* not there */ }
  if (!stat?.isDirectory()) throw new Refusal(400, `There is no folder at ${tidy(dir)} on this computer`)
  const inside = await git(['rev-parse', '--show-toplevel'], { cwd: dir })
  if (inside.missing) throw new Refusal(409, 'git is not installed on this computer. Setup shows how to add it')
  if (!inside.ok) {
    if (!init) throw Object.assign(new Refusal(409, `${tidy(dir)} is not a git repository yet. The crew works in branches, so a project needs one`), { canInit: true })
    const made = await git(['init'], { cwd: dir })
    if (!made.ok) throw new Refusal(409, `git could not be started in ${tidy(dir)}: ${made.err.slice(0, 200)}`)
    return dir
  }
  return dir
}

/** Copy a repository from its address into the projects folder, after asking the address whether it is one. */
async function cloned(address, name, { git = runGit, projects = projectsFolder() } = {}) {
  const url = text(address, 500)
  if (!REPO_ADDRESS.test(url) || url.includes('..')) throw new Refusal(400, 'Give the repository\'s address, like https://github.com/you/shop')
  const there = await git(['ls-remote', '--heads', url])
  if (there.missing) throw new Refusal(409, 'git is not installed on this computer. Setup shows how to add it')
  if (!there.ok) throw new Refusal(400, 'That address did not answer as a git repository. If it is private, sign in to GitHub in Setup first')
  fs.mkdirSync(projects, { recursive: true })
  const dir = path.join(projects, repoName(name || url))
  if (fs.existsSync(dir)) throw new Refusal(409, `There is already a folder at ${tidy(dir)}. Add that folder instead, or give the project another name`)
  const copy = await git(['clone', url, dir], { timeout: CLONE_TIME_MS })
  if (!copy.ok) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Refusal(502, `The repository could not be copied: ${copy.err.split('\n').pop().slice(0, 200)}`)
  }
  return { dir, url }
}

const projectName = (value) => {
  const name = text(value, MAX_NAME + 1)
  if (!name) throw new Refusal(400, 'A project needs a name')
  if (name.length > MAX_NAME) throw new Refusal(400, `Names are limited to ${MAX_NAME} characters`)
  return name
}

const projectPath = (projectId) => {
  if (!ID.test(projectId || '')) throw new Refusal(400, 'That is not a project id')
  return `/projects/${projectId}`
}

/** Add a project: a name, and its folder on this computer or a repository's address to copy here. */
export async function addProject({ name, folder, repo, init = false } = {}, options = {}) {
  // An address is judged before anything else is asked: a line that is not one never reaches git.
  if (text(repo, 500) && (!REPO_ADDRESS.test(text(repo, 500)) || text(repo, 500).includes('..'))) throw new Refusal(400, 'Give the repository\'s address, like https://github.com/you/shop')
  const title = projectName(name || (repo ? repoName(String(repo)) : folder ? path.basename(String(folder).replace(/\/+$/, '')) : ''))
  const id = await companyId(options)
  const projects = await call(`/companies/${id}/projects`, options)
  if (projects.some((p) => !p.archivedAt && String(p.name).toLowerCase() === title.toLowerCase())) throw new Refusal(409, `There is already a project called ${title}`)
  let workspace
  if (text(repo, 500)) {
    const copy = await cloned(repo, title, options)
    workspace = { cwd: copy.dir, repoUrl: copy.url }
  } else {
    const dir = await checkedFolder(folder, { init, git: options.git })
    const origin = await (options.git || runGit)(['remote', 'get-url', 'origin'], { cwd: dir })
    workspace = { cwd: dir, ...(origin.ok && /^https:\/\//.test(origin.out) ? { repoUrl: origin.out } : {}) }
  }
  const made = await call(`/companies/${id}/projects`, { ...options, method: 'POST', body: { name: title, workspace } })
  forgetReads()
  return { id: made.id, name: made.name, folder: workspace.cwd }
}

/** Change a project's name. Its jobs, folder and history stay as they are. */
export async function renameProject(projectId, name, options = {}) {
  const where = projectPath(projectId)
  const title = projectName(name)
  const id = await companyId(options)
  const projects = await call(`/companies/${id}/projects`, options)
  if (projects.some((p) => p.id !== projectId && !p.archivedAt && String(p.name).toLowerCase() === title.toLowerCase())) throw new Refusal(409, `There is already a project called ${title}`)
  await call(where, { ...options, method: 'PATCH', body: { name: title } })
  forgetReads()
  return { ok: true, name: title }
}

/** Point a project at another folder on this computer: its main folder, where new jobs branch from. */
export async function moveProject(projectId, folder, { init = false, ...options } = {}) {
  const where = projectPath(projectId)
  const dir = await checkedFolder(folder, { init, git: options.git })
  const project = await call(where, options)
  const main = (project.workspaces || []).find((w) => w.isPrimary) || (project.workspaces || [])[0] || project.primaryWorkspace
  if (main?.id) await call(`${where}/workspaces/${main.id}`, { ...options, method: 'PATCH', body: { cwd: dir } })
  else await call(`${where}/workspaces`, { ...options, method: 'POST', body: { cwd: dir, isPrimary: true } })
  forgetReads()
  return { ok: true, folder: dir }
}

/** Archive a project, or bring it back. Nothing is deleted: its jobs and folder stay. */
export async function archiveProject(projectId, archived = true, options = {}) {
  await call(projectPath(projectId), { ...options, method: 'PATCH', body: { archived: Boolean(archived) } })
  forgetReads()
  return { ok: true, archived: Boolean(archived) }
}

// ── first run ───────────────────────────────────────────────────────────────────────

export const FIRST_STEPS = ['name', 'setup', 'crew', 'chat', 'project', 'job', 'phone']
/** Steps that never hold the guide open on their own: a yard can do without a phone. */
const OPTIONAL_STEPS = new Set(['phone'])
const DEFAULT_NAME = 'My studio'

function readNotes(file) {
  const got = file ? readJson(file) : null
  return { named: Boolean(got?.named), seen: Array.isArray(got?.seen) ? got.seen.filter((s) => FIRST_STEPS.includes(s)) : [], skipped: Array.isArray(got?.skipped) ? got.skipped.filter((s) => FIRST_STEPS.includes(s)) : [], closed: Boolean(got?.closed) }
}

function writeNotes(file, notes) {
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * Where a studio stands on its way to a first job: each step done, skipped or still to do, and the
 * one to show now. A studio that already has a crew, a project and a job is past it, whatever the
 * notes say. `file` keeps what only the owner can say: that they named it, looked at setup, skipped
 * a step or closed the guide.
 */
/**
 * The first conversation a bot answered, or the one still waiting for an answer: the proof that a
 * bot's AI runs on this computer. Read from the newest chats; a yard with many is long past it.
 */
async function firstAnswer(id, crew, options) {
  const chats = (await orElse(call(`/companies/${id}/chats`, options), [])).slice(0, 6)
  const names = new Map(crew.map((a) => [a.id, a.name]))
  let waiting = null
  for (const chat of chats) {
    const comments = await orElse(call(`/issues/${chat.id}/comments?limit=20`, options), [])
    const answer = comments.find((c) => c.authorType === 'agent')
    const bot = { botId: chat.conversationAgentId || '', bot: names.get(chat.conversationAgentId) || 'A bot' }
    if (answer) return { ...bot, answered: true, text: String(answer.body || '').slice(0, 280) }
    if (!waiting && comments.some((c) => c.authorType === 'user')) waiting = { ...bot, answered: false, text: '' }
  }
  return waiting
}

/** The bot to say hello to first: the lead, else the first one switched on. */
const greeter = (crew) => {
  const on = crew.filter((a) => a.status !== 'paused')
  const lead = on.find((a) => a.role === 'ceo') || on.find((a) => !a.reportsTo) || on[0]
  return lead ? { id: lead.id, name: lead.name } : null
}

export async function firstRun({ file = '', devices = devicesFile(), ...options } = {}) {
  const id = await companyId(options)
  const [company, crew, projects, jobs] = await Promise.all([
    orElse(call(`/companies/${id}`, options), {}),
    crewOf(id, options),
    orElse(call(`/companies/${id}/projects`, options), []),
    orElse(call(`/companies/${id}/issues?view=compact&limit=20`, options), []),
  ])
  const chat = crew.length ? await firstAnswer(id, crew, options).catch(() => null) : null
  const notes = readNotes(file)
  const live = projects.filter((p) => !p.archivedAt)
  const work = jobs.filter((j) => !j.conversationAgentId)
  const phones = readDevices(devices).devices.length
  const has = {
    name: notes.named || (Boolean(company?.name) && company.name !== DEFAULT_NAME), setup: notes.seen.includes('setup'), crew: crew.length > 0,
    chat: Boolean(chat?.answered), project: live.length > 0, job: work.length > 0, phone: phones > 0,
  }
  // A yard whose bots already work (a crew that answered, on a job) is past it, whatever the notes say.
  const settled = has.crew && has.project && has.job && (has.chat || work.length > 1)
  const steps = FIRST_STEPS.map((step) => ({ id: step, state: has[step] || settled ? 'done' : notes.skipped.includes(step) ? 'skipped' : 'todo' }))
  const next = steps.find((s) => s.state === 'todo')?.id || ''
  const needed = steps.filter((s) => s.state === 'todo' && !OPTIONAL_STEPS.has(s.id))
  return {
    studio: { id, name: company?.name || DEFAULT_NAME },
    steps,
    step: next,
    // Shown by itself when the studio is empty; afterwards it waits in Setup until every step is done or skipped.
    show: !settled && !notes.closed && needed.length > 0,
    empty: !has.crew && !has.project,
    left: steps.filter((s) => s.state !== 'done').map((s) => s.id),
    chat: chat ? { ...chat } : null,
    greet: greeter(crew),
    phones,
    crew: crew.map((a) => ({ id: a.id, name: a.name, paused: a.status === 'paused' })),
    projects: live.map((p) => ({ id: p.id, name: p.name })),
    archived: projects.filter((p) => p.archivedAt).map((p) => ({ id: p.id, name: p.name })),
    firstJob: work[0] ? { id: work[0].id, ref: work[0].identifier || '', title: work[0].title || '' } : null,
  }
}

/** The owner's own word on a step: skipped, looked at, taken up again; or the guide closed or opened. */
export async function firstRunMark({ step, mark } = {}, { file = '', ...options } = {}) {
  const notes = readNotes(file)
  if (mark === 'close' || mark === 'open') notes.closed = mark === 'close'
  else {
    if (!FIRST_STEPS.includes(step)) throw new Refusal(400, 'That is not a step')
    const without = (list) => list.filter((s) => s !== step)
    if (mark === 'skip') notes.skipped = [...without(notes.skipped), step]
    else if (mark === 'seen') { notes.seen = [...without(notes.seen), step]; notes.skipped = without(notes.skipped) }
    else if (mark === 'again') { notes.skipped = without(notes.skipped); notes.closed = false }
    else throw new Refusal(400, 'Skip it, or take it up again')
  }
  writeNotes(file, notes)
  return firstRun({ file, ...options })
}

/** Give the studio its name. */
export async function nameStudio(name, { file = '', ...options } = {}) {
  const title = text(name, MAX_NAME + 1)
  if (!title) throw new Refusal(400, 'A studio needs a name')
  if (title.length > MAX_NAME) throw new Refusal(400, `Names are limited to ${MAX_NAME} characters`)
  const id = await companyId(options)
  await call(`/companies/${id}`, { ...options, method: 'PATCH', body: { name: title } })
  const notes = readNotes(file)
  writeNotes(file, { ...notes, named: true, skipped: notes.skipped.filter((s) => s !== 'name') })
  forgetReads()
  return { ok: true, name: title }
}

// ── setup and the helper timetable: the service's own modules, when this process has them ──

const parts = new Map()
/** One of the service's modules, loaded when first asked for; null where this copy does not have it yet. */
async function part(name) {
  if (!parts.has(name)) parts.set(name, import(`./${name}.mjs`).catch(() => null))
  return parts.get(name)
}
const NOT_YET = (what) => new Refusal(501, `${what} is not available in this copy of Botyard yet`)

/** Free models first: the path that works with no account. Then the other AIs, then what Botyard itself needs. */
const SETUP_ORDER = ['opencode', 'openrouter', 'nvidia', 'claude', 'codex', 'gemini', 'antigravity', 'git', 'github', 'node', 'python', 'map']
const SETUP_KIND = { opencode: 'free', openrouter: 'free', nvidia: 'free', claude: 'ai', codex: 'ai', gemini: 'ai', antigravity: 'ai' }
const STATE_WORDS = { ok: 'Ready', missing: 'Not installed', 'signed-out': 'Not signed in', unknown: 'Installed' }

/** One thing a studio needs, as its row: what it is for, how it stands, and the one thing to do about it. */
function setupRow(item, { remote = false } = {}) {
  const fix = item.fix && typeof item.fix === 'object' ? item.fix : null
  const kind = fix?.kind === 'key' ? 'key' : fix?.kind === 'link' && /^https:\/\//.test(fix.url || '') ? 'link' : fix?.kind === 'command' ? 'start' : ''
  return {
    id: String(item.id || ''),
    name: String(item.name || item.id || ''),
    kind: SETUP_KIND[item.id] || (item.group === 'ai' ? 'ai' : item.group === 'keys' ? 'free' : 'needs'),
    needed: Boolean(item.needed),
    state: Object.hasOwn(STATE_WORDS, item.state) ? item.state : 'unknown',
    stateWords: item.id && item.state === 'missing' && item.group === 'keys' ? 'No key yet' : STATE_WORDS[item.state] || 'Installed',
    what: String(item.what || ''),
    detail: String(item.detail || ''),
    action: !kind ? null : {
      kind,
      label: String(fix.label || (kind === 'key' ? 'Paste a key' : kind === 'link' ? 'Open the instructions' : 'Start')),
      ...(kind === 'link' ? { url: fix.url } : {}),
      // A sign-in opens on the computer Botyard runs on: from a phone the row says so and shows the line to run.
      ...(kind === 'start' ? { command: String(fix.command || ''), here: !remote } : {}),
      ...(kind === 'key' && /^https:\/\//.test(fix.url || fix.keysPage || '') ? { keysPage: fix.url || fix.keysPage } : {}),
    },
    // A key that is saved can be taken away again.
    // Only a key Botyard itself keeps can be forgotten here; one added in a tool's own settings is that tool's.
    forget: item.group === 'keys' && item.state === 'ok' && /^Saved in Botyard/.test(String(item.detail || '')),
  }
}

function setupView(state, opts) {
  const items = Array.isArray(state?.items) ? state.items : []
  const at = (row) => { const n = SETUP_ORDER.indexOf(row.id); return n < 0 ? SETUP_ORDER.length : n }
  const rows = items.map((i) => setupRow(i, opts)).filter((r) => r.id).sort((a, b) => at(a) - at(b))
  return { available: true, ready: Boolean(state?.ready), summary: String(state?.summary || ''), checkedAt: Number(state?.checkedAt) || null, rows }
}

/** What the studio needs and how each stands. `remote` is a caller that is not at this computer (the phone). */
export async function setupState({ fresh = false, remote = false } = {}) {
  const setup = await part('setup')
  if (!setup?.setupState) return { available: false, ready: false, summary: 'The setup checks are not available in this copy of Botyard yet.', checkedAt: null, rows: [] }
  return setupView(await setup.setupState(fresh ? { fresh: true } : undefined), { remote })
}

/**
 * Do one row's action: start the tool's own sign-in in a terminal on this computer, save a key,
 * forget one, or check everything again. A key goes straight on to the keys file and is in no answer.
 */
export async function setupAct({ action, id, key } = {}, { remote = false } = {}) {
  const setup = await part('setup')
  if (!setup?.setupAct) throw NOT_YET('Setup')
  if (!['check', 'start', 'key', 'forget'].includes(action)) throw new Refusal(400, 'Unknown action')
  if (action === 'start' && remote) throw new Refusal(403, 'A sign-in opens on the computer Botyard runs on. Start it there')
  if (action === 'key' && (typeof key !== 'string' || key.trim().length < 8 || key.length > 4000)) throw new Refusal(400, 'Paste the key first')
  const [status, body] = await setup.setupAct({ action, ...(id ? { id: String(id) } : {}), ...(action === 'key' ? { key: key.trim() } : {}) })
  if (status >= 400) throw new Refusal(status, body?.error || 'That did not work')
  if (action === 'check') return setupView(body, { remote })
  // Never the key, whatever the module answered with.
  const { key: dropped, ...safe } = body && typeof body === 'object' ? body : {}
  return { ok: true, opened: safe.opened, command: safe.command ? String(safe.command) : '', note: safe.note ? String(safe.note) : '', state: await setupState({ fresh: true, remote }) }
}

const helperRow = (j) => ({
  name: String(j.name || ''), kind: j.kind === 'keeper' ? 'keeper' : 'timer', what: String(j.what || ''), when: String(j.when || ''),
  on: Boolean(j.on), ready: j.ready !== false, notReady: String(j.notReady || ''), running: Boolean(j.running),
  lastAt: Number(j.lastEnd || j.lastStart) || null, lastOk: j.lastOk !== false, lastError: String(j.lastError || '').slice(0, 300), nextAt: Number(j.nextAt) || null,
})
const helperView = (state) => ({ available: true, state: state?.state === 'on' ? 'on' : 'off', why: String(state?.why || ''), jobs: (Array.isArray(state?.jobs) ? state.jobs : []).map(helperRow).filter((j) => j.name) })

/** The crew's helper scripts as the service runs them: each one's last run, its next, and whether it is on. */
export async function helperTimetable() {
  const timetable = await part('timetable')
  if (!timetable?.timetableState) return { available: false, state: 'off', why: 'The helper timetable is not available in this copy of Botyard yet.', jobs: [] }
  return helperView(await timetable.timetableState())
}

/** Switch the timetable or one helper on or off, or run one now. */
export async function helperAct({ action, name } = {}) {
  const timetable = await part('timetable')
  if (!timetable?.timetableAct) throw NOT_YET('The helper timetable')
  if (!['on', 'off', 'run'].includes(action) || (action === 'run' && !name)) throw new Refusal(400, 'Unknown action')
  if (name !== undefined && !/^[\w.-]{1,60}$/.test(String(name))) throw new Refusal(400, 'That is not a helper')
  const [status, body] = await timetable.timetableAct({ action, ...(name ? { name: String(name) } : {}) })
  if (status >= 400) throw new Refusal(status, body?.error || 'That did not work')
  return helperView(body)
}
