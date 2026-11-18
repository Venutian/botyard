/**
 * Jobs, projects, routines and the library in full, for the map's Work, Projects, Routines and
 * Library screens: the job list with filters, search and pages; a job's whole page (sub-jobs, what
 * blocks it, documents, files, runs, cost, the branch's changes and playable builds); a project's
 * folders, budget, routines and spend; a routine's schedule, runs and revisions; artifacts and skills.
 *
 * The engine is reached only through `engine.mjs`. Its records carry paths, adapter settings and
 * environment values, so every reader keeps only what a screen shows. Reads are kept a few seconds
 * on the real server (see `cached`), and every write names exactly what it changes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineError, SCHEDULES, call, companyId, crewOf, jobDetail, jobWorkspace, orElse, plainTitle, refOf, timetableOf, withRefs } from './engine.mjs'
import { planOf as timePlan, wordsOf } from './timeplan.mjs'
import { cached, cut, forgetReads, jobNames, runRow } from './crew.mjs'
import { changeCounts } from './changes.mjs'
import { goalInput, goalNote, planOf, readGoal, writeGoal } from './goal.mjs'
import { randomUUID } from 'node:crypto'
import { leadOf } from './looks.mjs'
import { PREVIEW_PORT, listPreviews, previewRoot } from './previews.mjs'
import { pcSkill, pcSkillFile, pcSkillRow, pcSkills } from './pc-skills.mjs'
import { crewFolder } from './models.mjs'
import { PILES as PILE_KINDS, PILE_ORDER, pilesOf, startOfToday } from './piles.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The engine's own job number, LH-580: what links in the crew's messages carry. */
const IDENTIFIER = /^[A-Z]{2,6}-\d{1,6}$/
const READ_TTL_MS = 8_000
const JOBS_PAGE = 40
const MAX_QUERY = 120
const SHOWN_CHILDREN = 30
const SHOWN_JOB_RUNS = 15
const SHOWN_ROUTINE_RUNS = 15
const SHOWN_REVISIONS = 12
const SHOWN_DONE = 5
const DOC_CHARS = 100_000
const MAX_DOC = 500_000
const MAX_DESCRIPTION = 100_000
const MAX_TITLE = 200
const SKILL_CHARS = 200_000
const ARTIFACTS_PAGE = 60
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const PRIORITIES = ['critical', 'high', 'medium', 'low']

/** The Work list's piles by the states they hold (see piles.mjs), and the words each state is shown in. */
export const PILES = Object.fromEntries(Object.entries(PILE_KINDS).map(([id, pile]) => [id, pile.statuses]))
export const STATE_WORDS = { in_progress: 'Working', in_review: 'To review', blocked: 'Blocked', todo: 'Waiting', backlog: 'Backlog', done: 'Done', cancelled: 'Cancelled' }

const home = os.homedir()
const tidyPath = (p) => (typeof p === 'string' && p ? (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p) : '')
const stamp = (v) => (v ? Date.parse(v) || 0 : 0)

/** The crew and the projects by id: every list here names them. */
async function names(id, options) {
  return cached(`work-names:${id}`, READ_TTL_MS, options, async () => {
    const [agents, projects, chats] = await Promise.all([
      crewOf(id, options),
      orElse(call(`/companies/${id}/projects`, options), []),
      orElse(call(`/companies/${id}/chats`, options), []),
    ])
    return {
      bots: new Map(agents.map((a) => [a.id, a.name])),
      projects: new Map(projects.map((p) => [p.id, p.name])),
      chats: new Set(chats.map((c) => c.id)),
      notInMain: notInMainOf(options),
    }
  })
}

/**
 * The codes of done jobs whose code is not in main, as crew/not-in-main.py last measured them. A test that brings its
 * own fetcher reads none of the PC's files unless it names one (`options.notInMainFile`).
 */
function notInMainOf(options = {}) {
  const file = options.notInMainFile ?? (options.fetcher ? '' : path.join(crewFolder(), 'not-in-main.json'))
  if (!file) return new Set()
  try { return new Set((JSON.parse(fs.readFileSync(file, 'utf8')).jobs || []).map((j) => j.job).filter(Boolean)) } catch { return new Set() }
}

const jobRow = (issue, n, snippet = '') => ({
  id: issue.id,
  ref: refOf(issue, n.projects),
  title: cut(plainTitle(withRefs(issue.title || '')), 140),
  status: issue.status,
  state: issue.status === 'done' && n.notInMain?.has(issue.identifier) ? 'Done, not in main' : STATE_WORDS[issue.status] || issue.status,
  ...(issue.status === 'done' && n.notInMain?.has(issue.identifier) ? { notInMain: true } : {}),
  priority: issue.priority || 'medium',
  bot: n.bots.get(issue.assigneeAgentId) || '',
  project: n.projects.get(issue.projectId) || '',
  at: stamp(issue.lastActivityAt || issue.updatedAt || issue.createdAt) || null,
  ...(snippet ? { snippet: cut(withRefs(snippet), 200) } : {}),
})

// ── the Work list ──────────────────────────────────────────────────────────────────

/**
 * One page of jobs, newest first: a pile (active, backlog, done or all), optionally one project and
 * one bot, and a search through the engine's own search when there are words. Conversations with a
 * bot are jobs to the engine and are left out; they live in Chats.
 */
export async function jobList({ pile = 'active', project = '', bot = '', q = '', page = 0, now = Date.now(), ...options } = {}) {
  if (pile && !Object.hasOwn(PILES, pile)) throw new EngineError(400, `Choose a pile: ${PILE_ORDER.join(', ')}`)
  if (project && !ID.test(project)) throw new EngineError(400, 'That is not a project id')
  if (bot && !ID.test(bot)) throw new EngineError(400, 'That is not a bot id')
  const words = String(q || '').trim().slice(0, MAX_QUERY)
  const at = Math.max(0, Math.floor(Number(page) || 0))
  const id = await companyId(options)
  const n = await names(id, options)
  const filters = new URLSearchParams({ limit: String(JOBS_PAGE + 1), offset: String(at * JOBS_PAGE) })
  if (pile) filters.set('status', PILES[pile].join(','))
  if (project) filters.set('projectId', project)
  if (bot) filters.set('assigneeAgentId', bot)
  const today = startOfToday(now)
  if (PILE_KINDS[pile]?.today) filters.set('settledSince', today)
  // How many each pile holds, for the same project and bot: the tabs say it.
  const counted = new URLSearchParams({ since: today })
  if (project) counted.set('projectId', project)
  if (bot) counted.set('assigneeAgentId', bot)
  const counts = cached(`counts:${id}:${counted}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/job-counts?${counted}`, options), null))
  let rows
  if (words) {
    filters.set('q', words)
    filters.set('scope', 'issues')
    const found = await cached(`search:${id}:${filters}`, READ_TTL_MS, options, () => call(`/companies/${id}/search?${filters}`, options))
    rows = (found?.results || []).filter((r) => r.type === 'issue' && r.issue && (!PILE_KINDS[pile]?.today || (r.issue.completedAt || r.issue.updatedAt || '') >= today)).map((r) => jobRow(r.issue, n, r.snippet && r.snippet !== r.issue.title ? r.snippet : ''))
  } else {
    filters.set('view', 'compact')
    const issues = await cached(`list:${id}:${filters}`, READ_TTL_MS, options, () => call(`/companies/${id}/issues?${filters}`, options))
    rows = issues.map((i) => jobRow(i, n))
  }
  rows = rows.filter((r) => !n.chats.has(r.id))
  return {
    jobs: rows.slice(0, JOBS_PAGE),
    page: at,
    more: rows.length > JOBS_PAGE,
    piles: pilesOf(await counts),
    bots: [...n.bots].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    projects: [...n.projects].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

// ── a job's whole page ─────────────────────────────────────────────────────────────

/** A job id from what the page holds: its id, or the engine's number from a link in a message. */
export async function jobIdOf(key, options) {
  if (ID.test(key || '')) return key
  if (!IDENTIFIER.test(key || '')) throw new EngineError(400, 'That is not a job')
  const issue = await call(`/issues/${key}`, options)
  return issue.id
}

const kindOf = (type = '') => (type.startsWith('image/') ? 'image' : /markdown|text\/plain|json|csv/.test(type) ? 'text' : 'file')
const attachmentOf = (path = '') => /\/attachments\/([0-9a-f-]{36})\/content/i.exec(path || '')?.[1] || ''

/**
 * Everything about one job a person reads or changes on its page. `previews` and `host` say where
 * the playable builds of a finished job are kept and served.
 */
export async function jobPage(key, { previews = previewRoot(), previewHost = '127.0.0.1', previewPort = PREVIEW_PORT, ...options } = {}) {
  const jobId = await jobIdOf(key, options)
  const id = await companyId(options)
  const [detail, issue, children, documents, attachments, runs, cost, workspace, builds, n, all] = await Promise.all([
    jobDetail(jobId, options),
    call(`/issues/${jobId}`, options),
    orElse(call(`/companies/${id}/issues?view=compact&parentId=${jobId}&limit=${SHOWN_CHILDREN}`, options), []),
    orElse(call(`/issues/${jobId}/documents`, options), []),
    orElse(call(`/issues/${jobId}/attachments`, options), []),
    orElse(call(`/issues/${jobId}/runs`, options), []),
    orElse(call(`/issues/${jobId}/cost-summary`, options), null),
    orElse(jobWorkspace(jobId, options), null),
    listPreviews(jobId, { root: previews, host: previewHost, port: previewPort }).catch(() => []),
    names(id, options),
    jobNames(id, options),
  ])
  const linked = (i) => i && { id: i.id, ref: refOf(i, n.projects), title: cut(plainTitle(withRefs(i.title || '')), 120), status: i.status, state: STATE_WORDS[i.status] || i.status }
  const parent = (issue.ancestors || [])[0]
  // A file a bot attached is also listed as a work product; it is shown once, as a file.
  const files = attachments.map((a) => ({ id: a.id, name: a.originalFilename || 'File', type: a.contentType || '', kind: kindOf(a.contentType), size: Number(a.byteSize) || 0, at: a.createdAt || null }))
  const fileIds = new Set(files.map((f) => f.id))
  const products = (issue.workProducts || [])
    .filter((w) => !fileIds.has(w.externalId) && !fileIds.has(w.metadata?.attachmentId))
    .map((w) => ({ id: w.id, title: w.title || w.type, type: w.type, url: /^https?:\/\//.test(w.url || '') ? w.url : '', status: w.status, summary: cut(w.summary || '', 200) }))
  const runNames = new Map([...n.bots])
  const changes = workspace ? await changeCounts(workspace) : null
  return {
    ...detail,
    projectId: issue.projectId || '',
    botId: issue.assigneeAgentId || '',
    parent: parent ? linked({ ...parent, projectId: issue.projectId }) : null,
    children: children.filter((c) => !n.chats.has(c.id)).map(linked),
    blockedBy: (issue.blockedBy || []).map(linked).filter(Boolean),
    blocks: (issue.blocks || []).map(linked).filter(Boolean),
    documents: documents.map((d) => ({
      key: d.key,
      title: d.title || d.key,
      body: String(d.body || '').slice(0, DOC_CHARS),
      trimmed: String(d.body || '').length > DOC_CHARS,
      revision: d.latestRevisionNumber || 1,
      revisionId: d.latestRevisionId || null,
      by: d.updatedByAgentId ? n.bots.get(d.updatedByAgentId) || 'A bot' : 'You',
      at: d.updatedAt || null,
      locked: Boolean(d.lockedAt),
    })),
    files,
    products,
    // Newest first, whichever way the engine lists them.
    runs: [...runs].sort((x, y) => String(y.startedAt || y.createdAt || '').localeCompare(String(x.startedAt || x.createdAt || ''))).slice(0, SHOWN_JOB_RUNS).map((r) => {
      const usage = r.usageJson && typeof r.usageJson === 'object' ? r.usageJson : {}
      return runRow({ ...r, id: r.runId || r.id, issueId: jobId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, costUsd: usage.costUsd }, runNames, all.jobs)
    }),
    cost: cost ? { tokens: (Number(cost.inputTokens) || 0) + (Number(cost.outputTokens) || 0), cached: Number(cost.cachedInputTokens) || 0, cents: Number(cost.costCents) || 0, runs: Number(cost.runCount) || 0, seconds: Math.round((Number(cost.runtimeMs) || 0) / 1000), withSubJobs: Boolean(cost.includeDescendants) } : null,
    branch: workspace ? { name: workspace.branch, folder: tidyPath(workspace.cwd), changes } : null,
    previews: builds,
  }
}

const editable = (jobId) => {
  if (!ID.test(jobId || '')) throw new EngineError(400, 'That is not a job id')
  return `/issues/${jobId}`
}

/**
 * Change what a job is: its title, details, priority, project or bot. Only the fields the page sent
 * are changed; a project or bot must be one of this studio's.
 */
export async function editJob(jobId, changes = {}, options) {
  const where = editable(jobId)
  const body = {}
  if (changes.title !== undefined) {
    const title = typeof changes.title === 'string' ? changes.title.trim() : ''
    if (!title) throw new EngineError(400, 'A job needs a title')
    if (title.length > MAX_TITLE) throw new EngineError(400, `Job titles are limited to ${MAX_TITLE} characters`)
    body.title = title
  }
  if (changes.description !== undefined) {
    if (typeof changes.description !== 'string' || changes.description.length > MAX_DESCRIPTION) throw new EngineError(400, 'The details are too long')
    body.description = changes.description
  }
  if (changes.priority !== undefined) {
    if (!PRIORITIES.includes(changes.priority)) throw new EngineError(400, 'Priority must be critical, high, medium or low')
    body.priority = changes.priority
  }
  const id = (changes.projectId !== undefined || changes.botId !== undefined) ? await companyId(options) : null
  if (changes.projectId !== undefined) {
    if (changes.projectId) {
      const projects = await call(`/companies/${id}/projects`, options)
      if (!projects.some((p) => p.id === changes.projectId)) throw new EngineError(400, 'That project is not in this studio')
    }
    body.projectId = changes.projectId || null
  }
  if (changes.botId !== undefined) {
    const crew = await crewOf(id, options)
    if (!crew.some((a) => a.id === changes.botId)) throw new EngineError(400, 'That bot is not in this studio')
    body.assigneeAgentId = changes.botId
  }
  if (!Object.keys(body).length) throw new EngineError(400, 'Nothing to change')
  await call(where, { ...options, method: 'PATCH', body })
  forgetReads()
  return { ok: true, changed: Object.keys(body) }
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,80}$/i
const docPath = (jobId, key) => {
  if (!KEY.test(key || '')) throw new EngineError(400, 'That is not a document')
  return `${editable(jobId)}/documents/${encodeURIComponent(key)}`
}

/** A document's earlier versions, newest first, without their text. */
export async function documentRevisions(jobId, key, options) {
  const revisions = await call(`${docPath(jobId, key)}/revisions`, options)
  const n = await names(await companyId(options), options)
  // Newest first, whichever way the engine lists them: the page calls the first one current.
  return [...revisions].sort((x, y) => (Number(y.revisionNumber) || 0) - (Number(x.revisionNumber) || 0)).slice(0, SHOWN_REVISIONS).map((r) => ({
    id: r.id, number: r.revisionNumber, at: r.createdAt, note: cut(r.changeSummary || '', 160),
    by: r.createdByAgentId ? n.bots.get(r.createdByAgentId) || 'A bot' : 'You',
  }))
}

/** Saves a document as a new version on top of the one the page read; the old one stays. */
export async function saveDocument(jobId, key, { body, title, baseRevisionId } = {}, options) {
  if (typeof body !== 'string' || !body.trim()) throw new EngineError(400, 'The document is empty')
  if (body.length > MAX_DOC) throw new EngineError(400, 'The document is too long')
  if (baseRevisionId != null && !ID.test(baseRevisionId)) throw new EngineError(400, 'That is not a version')
  await call(docPath(jobId, key), { ...options, method: 'PUT', body: { format: 'markdown', body, ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 200) } : {}), changeSummary: 'Edited on the map', baseRevisionId: baseRevisionId ?? null } })
  return { ok: true }
}

/** Makes an older version the current one, as a new version. */
export async function restoreDocument(jobId, key, revisionId, options) {
  if (!ID.test(revisionId || '')) throw new EngineError(400, 'That is not a version')
  await call(`${docPath(jobId, key)}/revisions/${revisionId}/restore`, { ...options, method: 'POST', body: {} })
  return { ok: true }
}

// ── a project's page ───────────────────────────────────────────────────────────────

/** A timetable in words; the same words everywhere (timeplan.mjs). */
export const scheduleWords = (cron) => wordsOf(cron)
const scheduleOf = (routine) => (routine.triggers || []).find((t) => t.kind === 'schedule' && !t.archived) || null

/** What the left panel's project page adds to the map's own counts. */
export async function projectPage(projectId, { now = Date.now(), ...options } = {}) {
  if (!ID.test(projectId || '')) throw new EngineError(400, 'That is not a project id')
  const id = await companyId(options)
  const from = encodeURIComponent(new Date(now - WEEK_MS).toISOString())
  const [project, budgets, routines, spend, done, n, plans] = await Promise.all([
    call(`/projects/${projectId}`, options),
    cached(`budgets:${id}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/budgets/overview`, options), { policies: [] })),
    cached(`routines:${id}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/routines`, options), [])),
    cached(`project-spend:${id}:${Math.floor(now / 60_000)}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/costs/by-project?from=${from}`, options), [])),
    orElse(call(`/companies/${id}/issues?view=compact&projectId=${projectId}&status=done&limit=${SHOWN_DONE}`, options), []),
    names(id, options),
    orElse(call(`/companies/${id}/issues?projectId=${projectId}&q=${encodeURIComponent('Plan:')}&limit=40`, options), []),
  ])
  if (project.companyId && project.companyId !== id) throw new EngineError(404, 'That project is not in this studio')
  // The lead's newest plan for it, with his report of the steps: the background of what is going on.
  const newest = plans.filter((i) => /^Plan:/.test(i.title || '') && i.projectId === projectId)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0]
  const plan = newest ? planOf(newest, await orElse(call(`/issues/${newest.id}/comments`, options), [])) : null
  const budget = (budgets?.policies || []).find((p) => p.scopeType === 'project' && p.scopeId === projectId && p.isActive !== false)
  const mine = spend.filter((r) => r.projectId === projectId)
  return {
    id: project.id,
    name: project.name,
    folders: (project.workspaces || []).map((w) => ({ name: w.name || '', folder: tidyPath(w.cwd), repo: /^https?:\/\//.test(w.repoUrl || '') ? w.repoUrl : '', primary: Boolean(w.isPrimary) })),
    // Shown only when one is set: the studio runs on subscriptions and has none today.
    budget: budget ? { metric: budget.metric || '', amount: Number(budget.amount) || 0, used: Number(budget.observedAmount) || 0, share: Number(budget.utilizationPercent) || 0, window: budget.windowKind || '' } : null,
    paused: project.pausedAt ? project.pauseReason || 'Paused' : '',
    archived: Boolean(project.archivedAt),
    routines: routines.filter((r) => r.projectId === projectId && r.status !== 'archived').map((r) => ({ id: r.id, title: r.title, paused: r.status !== 'active', bot: n.bots.get(r.assigneeAgentId) || '', when: scheduleWords(scheduleOf(r)?.cronExpression) })),
    spend: { tokens: mine.reduce((s, r) => s + (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0), 0), runs: mine.reduce((s, r) => s + (Number(r.eventCount) || 0), 0), cents: mine.reduce((s, r) => s + (Number(r.costCents) || 0), 0) },
    done: done.filter((i) => !n.chats.has(i.id)).map((i) => jobRow(i, n)),
    goal: readGoal(project.description),
    plan: plan ? { ...plan, ref: refOf(newest) } : null,
  }
}

/**
 * The owner's edit of a project's goal: written into its description the way the lead's rules keep it (the lead's
 * own OPEN NOW line stays), then said to the lead in his chat so he works toward it from his next wake.
 */
export async function saveGoal(projectId, body, { now = new Date(), tell = true, ...options } = {}) {
  if (!ID.test(projectId || '')) throw new EngineError(400, 'That is not a project id')
  let parts
  try { parts = goalInput(body) } catch (err) { throw new EngineError(400, err.message) }
  const id = await companyId(options)
  const project = await call(`/projects/${projectId}`, options)
  if (project.companyId && project.companyId !== id) throw new EngineError(404, 'That project is not in this studio')
  const was = readGoal(project.description)
  const description = writeGoal({ ...parts, open: was.open }, { now })
  if (description === tidyDescription(project.description)) return { ok: true, changed: false, goal: readGoal(description) }
  await call(`/projects/${projectId}`, { ...options, method: 'PATCH', body: { description } })
  forgetReads()
  let told = false
  if (tell) {
    const lead = leadOf(await crewOf(id, options))
    if (lead) {
      const chat = await call(`/companies/${id}/chats/${lead.id}`, { ...options, method: 'POST', body: {} })
      await call(`/issues/${chat.id}/comments`, { ...options, method: 'POST', body: { body: goalNote(project.name, parts), clientRequestId: randomUUID() } })
      told = true
    }
  }
  return { ok: true, changed: true, told, goal: readGoal(description) }
}

const tidyDescription = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

// ── routines ───────────────────────────────────────────────────────────────────────

const RUN_WORDS = { completed: 'Done', issue_created: 'Job made', coalesced: 'Joined the one running', skipped: 'Skipped', failed: 'Failed', received: 'Starting', enqueued: 'Waiting' }

/** One routine: what it does, when it runs, who does it, its last runs and its versions. */
export async function routinePage(routineId, options = {}) {
  if (!ID.test(routineId || '')) throw new EngineError(400, 'That is not a routine id')
  const id = await companyId(options)
  const [routine, runs, revisions, n, all] = await Promise.all([
    call(`/routines/${routineId}`, options),
    orElse(call(`/routines/${routineId}/runs`, options), []),
    orElse(call(`/routines/${routineId}/revisions`, options), []),
    names(id, options),
    jobNames(id, options),
  ])
  const schedule = scheduleOf(routine)
  return {
    id: routine.id,
    title: routine.title,
    description: cut(routine.description || '', 4000),
    paused: routine.status !== 'active',
    bot: n.bots.get(routine.assigneeAgentId) || '',
    botId: routine.assigneeAgentId || '',
    project: n.projects.get(routine.projectId) || '',
    projectId: routine.projectId || '',
    plan: timePlan(schedule?.cronExpression),
    cron: schedule?.cronExpression || '',
    timezone: schedule?.timezone || '',
    when: scheduleWords(schedule?.cronExpression),
    schedule: Object.entries(SCHEDULES).find(([, cron]) => cron === schedule?.cronExpression)?.[0] || '',
    nextAt: schedule?.nextRunAt || null,
    runs: runs.slice(0, SHOWN_ROUTINE_RUNS).map((r) => {
      const job = all.jobs.get(r.linkedIssueId)
      return { id: r.id, at: r.triggeredAt || r.createdAt, state: RUN_WORDS[r.status] || r.status, failed: r.status === 'failed', why: cut(r.failureReason || '', 200), by: r.source === 'schedule' ? 'On time' : 'By hand', job: job ? { id: job.id, ref: job.ref, title: job.title } : null }
    }),
    revisions: (Array.isArray(revisions) ? revisions : []).slice(0, SHOWN_REVISIONS).map((r) => ({ id: r.id, number: r.revisionNumber, at: r.createdAt, by: r.createdByAgentId ? n.bots.get(r.createdByAgentId) || 'A bot' : 'You or a crew script', title: r.title || '' })),
  }
}

/** Changes when a routine runs: a plan (see timeplan.mjs) or one of the four old choices by name. A routine with no timetable gets one. */
export async function setRoutineSchedule(routineId, schedule, timezone, options) {
  if (!ID.test(routineId || '')) throw new EngineError(400, 'That is not a routine id')
  const cronExpression = timetableOf(schedule && typeof schedule === 'object' ? { plan: schedule } : { schedule })
  if (timezone != null && (typeof timezone !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone))) throw new EngineError(400, 'That is not a time zone')
  const routine = await call(`/routines/${routineId}`, options)
  const current = scheduleOf(routine)
  if (current) await call(`/routine-triggers/${current.id}`, { ...options, method: 'PATCH', body: { cronExpression, ...(timezone ? { timezone } : {}) } })
  else await call(`/routines/${routineId}/triggers`, { ...options, method: 'POST', body: { kind: 'schedule', cronExpression, timezone: timezone || 'UTC' } })
  forgetReads()
  return { ok: true, when: wordsOf(cronExpression) }
}

// ── the library ────────────────────────────────────────────────────────────────────

const CURSOR = /^[A-Za-z0-9_=-]{1,400}$/

/** What the crew made, newest first: pictures, files and documents, each with its job. */
export async function artifactList({ cursor = '', kind = 'all', ...options } = {}) {
  if (cursor && !CURSOR.test(cursor)) throw new EngineError(400, 'That is not a page')
  if (!['all', 'image', 'document', 'file', 'text', 'video'].includes(kind)) throw new EngineError(400, 'That is not a kind of file')
  const id = await companyId(options)
  const q = new URLSearchParams({ limit: String(ARTIFACTS_PAGE), kind, ...(cursor ? { cursor } : {}) })
  const [page, n] = await Promise.all([
    cached(`artifacts:${id}:${q}`, READ_TTL_MS, options, () => call(`/companies/${id}/artifacts?${q}`, options)),
    names(id, options),
  ])
  return {
    items: (page?.artifacts || []).map((a) => ({
      id: a.id,
      kind: a.mediaKind || 'file',
      title: cut(a.title || 'Untitled', 120),
      file: attachmentOf(a.contentPath || a.openPath),
      document: a.source === 'document' ? String(a.id).replace(/^document:/, '') : '',
      preview: cut(a.previewText || '', 200),
      job: a.issue ? { id: a.issue.id, ref: refOf({ ...a.issue, projectId: a.project?.id }, n.projects), title: cut(plainTitle(withRefs(a.issue.title || '')), 100) } : null,
      project: a.project?.name || '',
      bot: a.createdByAgent?.name || '',
      at: a.updatedAt || null,
    })),
    next: typeof page?.nextCursor === 'string' && CURSOR.test(page.nextCursor) ? page.nextCursor : '',
  }
}

/** Why a skill cannot be changed here, in plain words. */
const lockedWhy = (s) => (s.editable ? '' : /bundled/i.test(s.editableReason || '') ? 'Comes with Botyard: read only' : cut(s.editableReason || 'Read only', 120))

/** The skills the crew can be given: the engine's and every one on this PC (pc-skills.mjs), what each is
 * for, its files, and whether it can be changed or which bots have it. The PC's copy of a name wins. */
export async function skillList(options = {}) {
  const id = await companyId(options)
  const skills = await cached(`skills-all:${id}`, 30_000, options, () => call(`/companies/${id}/skills`, options))
  const pc = pcSkills(options)
  const onPc = new Set(pc.map((s) => s.name))
  return [...skills.filter((s) => !onPc.has(s.name || s.slug)).map((s) => ({
    id: s.id,
    name: s.name || s.slug,
    description: cut(s.description || '', 300),
    editable: Boolean(s.editable),
    locked: lockedWhy(s),
    bots: Number(s.attachedAgentCount) || 0,
    files: (s.fileInventory || []).map((f) => f.path).filter((p) => typeof p === 'string').slice(0, 100),
  })), ...pc.map((s) => pcSkillRow(s, cut))].sort((a, b) => Number(b.editable) - Number(a.editable) || a.name.localeCompare(b.name))
}

const skillFilePath = (p) => {
  const file = String(p || '')
  if (!file || file.length > 300 || file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '' || part.startsWith('.')) || /[\\\0]/.test(file)) throw new EngineError(400, 'That is not a file of the skill')
  return file
}

/** One file of a skill, as text. */
export async function skillFile(skillId, file, options = {}) {
  if (!ID.test(skillId || '')) throw new EngineError(400, 'That is not a skill id')
  const p = skillFilePath(file)
  const onPc = pcSkill(skillId, options)
  if (onPc) return pcSkillFile(onPc, p, SKILL_CHARS)
  const id = await companyId(options)
  const got = await call(`/companies/${id}/skills/${skillId}/files?path=${encodeURIComponent(p)}`, options)
  const content = typeof got?.content === 'string' ? got.content : ''
  return { path: p, content: content.slice(0, SKILL_CHARS), trimmed: content.length > SKILL_CHARS, markdown: Boolean(got?.markdown), editable: Boolean(got?.editable) }
}

/** Saves one file of a skill the crew may change. A read-only skill is refused before the engine is asked to write. */
export async function saveSkillFile(skillId, { path: file, content } = {}, options = {}) {
  if (!ID.test(skillId || '')) throw new EngineError(400, 'That is not a skill id')
  const p = skillFilePath(file)
  if (typeof content !== 'string' || content.length > SKILL_CHARS) throw new EngineError(400, 'That file is empty or too long')
  if (pcSkill(skillId, options)) throw new EngineError(409, 'This skill lives on the PC: change it in its own folder')
  const id = await companyId(options)
  const skill = await call(`/companies/${id}/skills/${skillId}`, options)
  if (!skill?.editable) throw new EngineError(409, lockedWhy(skill || {}) || 'This skill is read only')
  await call(`/companies/${id}/skills/${skillId}/files`, { ...options, method: 'PATCH', body: { path: p, content } })
  forgetReads()
  return { ok: true }
}
