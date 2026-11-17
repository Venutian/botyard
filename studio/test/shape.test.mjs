/**
 * Shaping a studio (the crew editor, projects, the first run, setup), against a small engine that
 * keeps what it is sent. Most of what matters is what never comes back: a variable's value, a key,
 * a command, a path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  addBot, addProject, addStarterCrew, archiveProject, botSettings, firstRun, firstRunMark, moveProject, nameStudio,
  newBotChoices, removeBot, removeVariable, renameProject, renderInstructions, saveBot, setVariable, templates,
} from '../server/lib/shape.mjs'
import { addRoutine, editRoutine } from '../server/lib/engine.mjs'
import { phoneHandler } from '../server/phone.mjs'

const LEAD = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const FRED = '33333333-3333-4333-8333-333333333333'
const PROJECT = '44444444-4444-4444-8444-444444444444'
const SPACE = '55555555-5555-4555-8555-555555555555'
const ROUTINE = '66666666-6666-4666-8666-666666666666'
const KEPT = '***REDACTED***'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))

/** An engine that holds bots, projects and jobs in memory and answers the paths the shaping code calls. */
function engine({ bots, projects, jobs = [], chats = [], comments = {}, name = 'My studio' } = {}) {
  const state = {
    calls: [],
    company: { id: 'co', name, status: 'active' },
    bots: bots || [
      { id: LEAD, name: 'Lead', role: 'ceo', title: 'Leads', status: 'idle', reportsTo: null, adapterType: 'claude_local', runtimeConfig: { heartbeat: { intervalSec: 0 } },
        adapterConfig: { command: '/secret/claude-bot.sh', cwd: '/secret/home', model: 'claude-sonnet-5-5', effort: 'high', maxTurnsPerRun: 80, timeoutSec: 2700, instructionsFilePath: '/secret/lead.md',
          extraArgs: ['--foo', '--disallowedTools', 'Bash(git push:*),Edit,Write'], env: { PATH: { type: 'plain', value: '/secret/bin' }, API_TOKEN: { type: 'secret', value: KEPT } } } },
      { id: BOB, name: 'Builder', role: 'engineer', status: 'idle', reportsTo: LEAD, adapterType: 'claude_local', adapterConfig: { model: 'claude-haiku-5-5', timeoutSec: 3600 } },
      { id: FRED, name: 'Freelancer', role: 'engineer', status: 'paused', reportsTo: BOB, adapterType: 'opencode_local', adapterConfig: { model: 'auto', variant: 'high', timeoutSec: 1800 } },
    ],
    projects: projects || [{ id: PROJECT, name: 'Shop', archivedAt: null, workspaces: [{ id: SPACE, cwd: '/old', isPrimary: true }] }],
    jobs,
  }
  let made = 0
  const newId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++made).padStart(12, '0')}`
  const fetcher = async (url, init) => {
    const u = new URL(url)
    const p = u.pathname.replace('/api', '')
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ path: p + u.search, method: init.method, body })
    const bot = /^\/agents\/([^/]+)$/.exec(p)
    if (p === '/companies') return json([state.company])
    if (p === '/companies/co' && init.method === 'PATCH') { Object.assign(state.company, body); return json(state.company) }
    if (p === '/companies/co') return json(state.company)
    if (p === '/companies/co/agents' && init.method === 'POST') {
      const agent = { id: newId(), status: 'idle', reportsTo: null, ...body }
      state.bots.push(agent)
      return json(agent, 201)
    }
    if (p === '/companies/co/agents') return json(state.bots.filter((b) => b.status !== 'terminated'))
    if (bot && init.method === 'PATCH') {
      const agent = state.bots.find((b) => b.id === bot[1])
      const { adapterConfig, replaceAdapterConfig, ...rest } = body
      Object.assign(agent, rest)
      if (adapterConfig) agent.adapterConfig = replaceAdapterConfig ? adapterConfig : { ...agent.adapterConfig, ...adapterConfig }
      return json(agent)
    }
    if (bot && init.method === 'DELETE') { state.bots.find((b) => b.id === bot[1]).status = 'terminated'; return json({}) }
    if (bot) { const agent = state.bots.find((b) => b.id === bot[1]); return agent ? json(agent) : json({ error: 'Agent not found' }, 404) }
    if (/^\/agents\/[^/]+\/pause$/.test(p)) { state.bots.find((b) => p.includes(b.id)).status = 'paused'; return json({}) }
    if (p === '/companies/co/issues') return json(state.jobs.filter((j) => !u.searchParams.get('assigneeAgentId') || j.assigneeAgentId === u.searchParams.get('assigneeAgentId')))
    if (p === '/companies/co/chats') return json(chats)
    if (/^\/issues\/[^/]+\/comments$/.test(p) && init.method !== 'POST') return json(comments[p.split('/')[2]] || [])
    if (p === '/companies/co/projects' && init.method === 'POST') { const project = { id: newId(), archivedAt: null, ...body }; state.projects.push(project); return json(project, 201) }
    if (p === '/companies/co/projects') return json(state.projects)
    if (p === `/projects/${PROJECT}` && init.method === 'PATCH') { const project = state.projects[0]; if (body.name) project.name = body.name; if ('archived' in body) project.archivedAt = body.archived ? 'now' : null; return json(project) }
    if (p === `/projects/${PROJECT}`) return json(state.projects[0])
    if (p.startsWith(`/projects/${PROJECT}/workspaces`)) return json({})
    if (p === '/companies/co/routines' && init.method === 'POST') return json({ id: ROUTINE }, 201)
    if (p.startsWith('/routines/')) return json({}, init.method === 'POST' ? 201 : 200)
    return json({ error: `no ${init.method} ${p}` }, 404)
  }
  const writes = () => state.calls.filter((c) => c.method !== 'GET')
  return { fetcher, state, writes, retired: [] }
}

/** A repository's shipped crew sets, as the crew session lays them out. */
function crewRepo() {
  const root = tmp('crew-repo')
  const starter = path.join(root, 'starter')
  fs.mkdirSync(path.join(starter, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(starter, 'crew.json'), JSON.stringify({ studio: 'My studio', lead: 'lead', bots: ['lead', 'builder', 'checker', 'claude-builder'] }))
  fs.writeFileSync(path.join(starter, 'shared', 'long-jobs.md'), 'Long jobs: say where you are every hour.\n')
  const bot = (slug, fields, rules) => {
    fs.writeFileSync(path.join(starter, `${slug}.json`), JSON.stringify({ role: 'engineer', ai: 'free', model: 'auto', effort: 'high', minutes: 45, turns: null, mayNot: ['push'], on: true, ...fields }))
    fs.writeFileSync(path.join(starter, `${slug}.md`), rules)
  }
  bot('lead', { name: 'Lea The Lead', role: 'ceo', title: 'Hands out the work', does: 'Plans and hands out work.', reportsTo: null }, 'You are {{name}}, the lead of {{studio}}.\n{{shared: long-jobs}}\n{{crew-ids}}\n{{note: thinking}}\nHome is {{home}}.\n')
  bot('builder', { name: 'Bo The Builder', title: 'Builds', does: 'Builds what the lead briefs.', reportsTo: 'lead', atOnce: 2 }, 'You are {{name}}. {{title}}.\n')
  bot('checker', { name: 'Chi The Checker', role: 'qa', title: 'Checks', does: 'Checks every build.', reportsTo: 'lead', mayNot: ['push', 'edit'] }, 'You check.\n')
  bot('claude-builder', { name: 'Cleo', title: 'Builds on Claude', does: 'Harder builds.', reportsTo: 'lead', ai: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', minutes: 90, turns: 150, on: false, needs: 'claude' }, 'You build.\n')
  fs.writeFileSync(path.join(starter, '.seeded.json'), '{}')
  return root
}

// ── the editor reads ────────────────────────────────────────────────────────────────

test("a bot's settings give the form its fields and choices, and nothing of its commands, paths or variable values", async () => {
  const e = engine({ jobs: [{ id: 'j1', assigneeAgentId: LEAD, status: 'todo' }, { id: 'j2', assigneeAgentId: LEAD, status: 'todo', conversationAgentId: LEAD }] })
  const s = await botSettings(LEAD, { ...e, connectors: [{ id: 'github', name: 'GitHub', bots: [{ id: LEAD, level: 'read' }, { id: BOB, level: 'off' }] }] })
  assert.deepEqual([s.name, s.role, s.ai, s.model, s.effort, s.minutes, s.turns, s.atOnce], ['Lead', 'ceo', 'claude', 'claude-sonnet-5-5', 'high', 45, 80, 1])
  // Read off the Claude bot's own deny list: it may not change files.
  assert.deepEqual(s.mayNot, ['push', 'edit'])
  assert.deepEqual(s.variables, [{ name: 'API_TOKEN', secret: true, set: true }, { name: 'PATH', secret: false, set: true }])
  assert.equal(s.openJobs, 1, 'a conversation is not a job it leaves behind')
  assert.deepEqual(s.reports, ['Builder'])
  assert.deepEqual(s.connectors, [{ id: 'github', name: 'GitHub', level: 'read' }])
  assert.deepEqual(s.choices.bosses.map((b) => b.name), ['Builder', 'Freelancer'])
  assert.deepEqual(s.choices.ais.map((a) => a.id), ['free', 'claude', 'codex', 'gemini'], 'free models come first')
  const all = JSON.stringify(s)
  for (const hidden of ['/secret', KEPT, 'claude-bot.sh', '--foo']) assert.equal(all.includes(hidden), false, hidden)
  await assert.rejects(botSettings('nope', e), /not a bot id/)
})

// ── saving ──────────────────────────────────────────────────────────────────────────

test('saving changes only what the form sent, and keeps a Claude bot\'s deny list in step with what it may not do', async () => {
  const e = engine()
  await saveBot(LEAD, { title: 'Studio lead', minutes: 30, turns: 120, mayNot: ['commit'], atOnce: 3 }, e)
  const [write] = e.writes()
  assert.equal(write.path, `/agents/${LEAD}`)
  assert.equal(write.body.title, 'Studio lead')
  assert.equal(write.body.replaceAdapterConfig, undefined)
  assert.equal(write.body.adapterConfig.timeoutSec, 1800)
  assert.equal(write.body.adapterConfig.maxTurnsPerRun, 120)
  assert.deepEqual(write.body.adapterConfig.mayNot, ['push', 'commit'])
  // Its other arguments stay; the old deny list is replaced, not added to.
  const args = write.body.adapterConfig.extraArgs
  assert.equal(args[0], '--foo')
  assert.equal(args.filter((a) => a === '--disallowedTools').length, 1)
  assert.ok(args.at(-1).includes('Bash(git commit:*)') && !args.at(-1).split(',').includes('Edit'))
  assert.deepEqual(write.body.runtimeConfig.heartbeat, { intervalSec: 0, maxConcurrentRuns: 3 }, 'its other run settings are kept')
  assert.equal('env' in write.body.adapterConfig, false, 'variables are not touched by a settings save')
})

test('moving a bot to another AI gives it clean settings for that AI and keeps its folder, variables, instructions and limits', async () => {
  const e = engine()
  await assert.rejects(saveBot(LEAD, { ai: 'free' }, e), /Choose a model/)
  const done = await saveBot(LEAD, { ai: 'free', model: 'auto', effort: 'medium' }, e)
  assert.equal(done.moved, true)
  const { body } = e.writes()[0]
  assert.equal(body.adapterType, 'opencode_local')
  assert.equal(body.replaceAdapterConfig, true)
  assert.deepEqual(Object.keys(body.adapterConfig).sort(), ['cwd', 'dangerouslySkipPermissions', 'env', 'instructionsFilePath', 'model', 'timeoutSec', 'variant'], 'nothing of the old tool: no command, no arguments, no turns')
  assert.equal(body.adapterConfig.variant, 'medium')
  assert.equal(body.adapterConfig.env.API_TOKEN.value, KEPT, 'the engine\'s own mark goes back, so the stored value stays')
  // And onto Claude: the tool's deny list is written for it.
  const back = engine()
  await saveBot(FRED, { ai: 'claude', model: 'claude-haiku-5-5', mayNot: ['edit'] }, back)
  assert.deepEqual(back.writes()[0].body.adapterConfig.extraArgs.slice(0, 1), ['--disallowedTools'])
  assert.ok(back.writes()[0].body.adapterConfig.extraArgs[1].split(',').includes('Edit'))
})

test('a save is refused in plain words: a name in use, a circle of who answers to whom, limits out of range', async () => {
  const e = engine()
  await assert.rejects(saveBot(BOB, { name: 'lead' }, e), /already called lead/)
  await assert.rejects(saveBot(BOB, { name: '  ' }, e), /needs a name/)
  await assert.rejects(saveBot(LEAD, { reportsTo: LEAD }, e), /cannot answer to itself/)
  await assert.rejects(saveBot(LEAD, { reportsTo: FRED }, e), /circle/)
  await assert.rejects(saveBot(BOB, { reportsTo: PROJECT }, e), /not in this studio/)
  await assert.rejects(saveBot(BOB, { minutes: 0 }, e), /1 to 600 minutes/)
  await assert.rejects(saveBot(BOB, { model: 'a b; rm' }, e), /Choose a model/)
  await assert.rejects(saveBot(BOB, { ai: 'skynet', model: 'x' }, e), /which AI/)
  await assert.rejects(saveBot(BOB, {}, e), /Nothing to change/)
  assert.equal(e.writes().length, 0)
  // Answering to nobody is allowed: that is the lead.
  await saveBot(BOB, { reportsTo: '' }, e)
  assert.equal(e.writes()[0].body.reportsTo, null)
})

test('a variable is set by name with its value sent on once and never read back; the others keep what they hold', async () => {
  const e = engine()
  const out = await setVariable(LEAD, 'SHOP_KEY', 'sk-live-very-secret', e)
  assert.equal(JSON.stringify(out).includes('sk-live'), false)
  assert.deepEqual(out.variables.map((v) => v.name), ['API_TOKEN', 'PATH', 'SHOP_KEY'])
  const env = e.writes()[0].body.adapterConfig.env
  assert.deepEqual(env.SHOP_KEY, { type: 'secret', value: 'sk-live-very-secret' })
  assert.equal(env.API_TOKEN.value, KEPT)
  assert.equal(env.PATH.value, '/secret/bin')
  await assert.rejects(setVariable(LEAD, 'bad name', 'x', e), /letters, digits and underscores/)
  await assert.rejects(setVariable(LEAD, 'OK', '', e), /Give the variable a value/)
  const gone = await removeVariable(LEAD, 'SHOP_KEY', e)
  assert.deepEqual(gone.variables.map((v) => v.name), ['API_TOKEN', 'PATH'])
  await assert.rejects(removeVariable(LEAD, 'NOT_THERE', e), /no variable by that name/)
})

test('removing a bot says how many open jobs it leaves behind', async () => {
  const e = engine({ jobs: [{ id: 'j1', assigneeAgentId: BOB, status: 'todo' }, { id: 'j2', assigneeAgentId: BOB, status: 'blocked' }, { id: 'j3', assigneeAgentId: LEAD, status: 'todo' }] })
  const out = await removeBot(BOB, e)
  assert.deepEqual(out, { ok: true, name: 'Builder', openJobs: 2 })
  assert.deepEqual(e.writes().map((c) => [c.method, c.path]), [['DELETE', `/agents/${BOB}`]])
})

// ── templates and a new bot ─────────────────────────────────────────────────────────

test('templates are listed by name and what they are for; their instructions fill in the shared paragraphs and names', () => {
  const crewRepoDir = crewRepo()
  const list = templates({ crewRepo: crewRepoDir })
  assert.deepEqual(list.map((t) => [t.id, t.name, t.aiName, t.needs]), [
    ['starter/lead', 'Lea The Lead', 'Free models', ''], ['starter/builder', 'Bo The Builder', 'Free models', ''],
    ['starter/checker', 'Chi The Checker', 'Free models', ''], ['starter/claude-builder', 'Cleo', 'Claude', 'claude'],
  ], 'in the order the set gives its bots')
  const t = { set: 'starter', slug: 'lead', dir: path.join(crewRepoDir, 'starter'), bot: {}, crew: {} }
  const rules = renderInstructions(t, { name: 'Lea', title: 'Lead', studio: 'Acme', ai: 'free' })
  assert.match(rules, /^You are Lea, the lead of Acme\.\nLong jobs: say where you are every hour\./)
  assert.match(rules, new RegExp(`Home is ${os.homedir()}`))
  assert.equal(rules.includes('{{'), false, 'no mark is left for the bot to read')
  assert.deepEqual(templates({ crewRepo: tmp('none') }), [])
})

test('a new bot is made from the form or a template, with instructions, and a template that needs a sign-in starts paused', async () => {
  const e = { ...engine(), crewRepo: crewRepo() }
  const blank = await addBot({ name: 'Pat', ai: 'free', does: 'Tidies up.' }, e)
  const made = e.writes()[0].body
  assert.equal(blank.paused, false)
  assert.deepEqual([made.name, made.adapterType, made.adapterConfig.model, made.adapterConfig.timeoutSec], ['Pat', 'opencode_local', 'auto', 3600])
  assert.match(made.instructions, /You are Pat[\s\S]*Tidies up\./)
  // From a template: its settings, with what the form changed laid over it.
  const cleo = await addBot({ from: 'starter/claude-builder', name: 'Cleo Two', reportsTo: LEAD }, e)
  const body = e.writes().find((c) => c.body?.name === 'Cleo Two').body
  assert.deepEqual([body.adapterType, body.adapterConfig.model, body.adapterConfig.effort, body.adapterConfig.maxTurnsPerRun, body.reportsTo], ['claude_local', 'claude-sonnet-5-5', 'medium', 150, LEAD])
  assert.ok(body.adapterConfig.extraArgs.includes('--disallowedTools'))
  assert.equal(body.instructions, 'You build.')
  assert.deepEqual([cleo.paused, cleo.needs], [true, 'claude'])
  assert.ok(e.writes().some((c) => c.path === `/agents/${cleo.id}/pause`))
  await assert.rejects(addBot({ name: 'Lead', ai: 'free' }, e), /already called Lead/)
  await assert.rejects(addBot({ name: 'X' }, e), /which AI/)
  await assert.rejects(addBot({ from: 'starter/../../etc', name: 'X' }, e), /template is not in this copy/)
  await assert.rejects(addBot({ from: 'elsewhere/lead' }, e), /template is not in this copy/)
})

test('the starter crew is made lead first so the others answer to it, and a second time adds nothing', async () => {
  const e = { ...engine({ bots: [] }), crewRepo: crewRepo() }
  const out = await addStarterCrew(e)
  assert.deepEqual(out.added.map((b) => b.name), ['Lea The Lead', 'Bo The Builder', 'Chi The Checker', 'Cleo'])
  const lead = e.state.bots.find((b) => b.name === 'Lea The Lead')
  assert.equal(lead.reportsTo, null)
  assert.ok(e.state.bots.filter((b) => b !== lead).every((b) => b.reportsTo === lead.id))
  assert.equal(e.state.bots.find((b) => b.name === 'Cleo').status, 'paused')
  assert.equal(e.state.bots.find((b) => b.name === 'Bo The Builder').runtimeConfig.heartbeat.maxConcurrentRuns, 2)
  const again = await addStarterCrew(e)
  assert.deepEqual([again.added.length, again.already], [0, 4])
  await assert.rejects(addStarterCrew({ ...engine(), crewRepo: tmp('none') }), /no default crew/)
  const offer = await newBotChoices(e)
  assert.equal(offer.templates.length, 4)
  assert.equal(offer.lead, lead.id)
})

test('where the crew\'s own seeder may run, it makes the starter crew and puts back a moved bot\'s launcher; a test engine never runs it', async () => {
  const ran = []
  const e = { ...engine({ bots: [] }), crewRepo: crewRepo() }
  // The seeder is stood in for: it "makes" one bot through the engine and says it went well.
  const seed = async (args) => {
    ran.push(args.join(' '))
    if (args[0] === '--starter') e.state.bots.push({ id: LEAD, name: 'Lea The Lead', status: 'idle', role: 'ceo', adapterType: 'opencode_local', adapterConfig: { model: 'auto' } })
    if (args[0] === '--list') return { ok: true, out: JSON.stringify({ bots: [{ slug: 'lead', name: 'Lea The Lead' }] }), err: '' }
    return { ok: true, out: '', err: '' }
  }
  const out = await addStarterCrew({ ...e, seed })
  assert.deepEqual(out.added.map((b) => b.name), ['Lea The Lead'])
  assert.equal(e.writes().length, 0, 'the seeder made the bots, not the page')
  const moved = await saveBot(LEAD, { ai: 'claude', model: 'claude-haiku-5-5' }, { ...e, seed })
  assert.equal(moved.launcher, true)
  assert.deepEqual(ran, ['--starter', '--list', '--only lead'])
  // A seeder that fails is not the end: the page makes the bots itself.
  const fallback = { ...engine({ bots: [] }), crewRepo: crewRepo() }
  const made = await addStarterCrew({ ...fallback, seed: async () => ({ ok: false, out: '', err: 'no python' }) })
  assert.equal(made.added.length, 4)
})

// ── projects ────────────────────────────────────────────────────────────────────────

/** A git that says what it is told to: which folders are repositories, which addresses answer. */
const fakeGit = ({ repos = [], remotes = [] } = {}) => {
  const ran = []
  const git = async (args, { cwd } = {}) => {
    ran.push(args.join(' '))
    if (args[0] === 'rev-parse') return { ok: repos.includes(cwd), out: cwd, err: '' }
    if (args[0] === 'init') { repos.push(cwd); return { ok: true, out: '', err: '' } }
    if (args[0] === 'remote') return { ok: false, out: '', err: '' }
    if (args[0] === 'ls-remote') return { ok: remotes.includes(args[2]), out: '', err: '' }
    if (args[0] === 'clone') { fs.mkdirSync(args[2], { recursive: true }); return { ok: true, out: '', err: '' } }
    return { ok: false, out: '', err: 'unknown' }
  }
  git.ran = ran
  return git
}

test('a project is added from a folder only when the folder is there and is a git repository, or the owner says to start git in it', async () => {
  const dir = tmp('project')
  const e = engine()
  await assert.rejects(addProject({ name: 'New', folder: 'relative/path' }, { ...e, git: fakeGit() }), /whole path/)
  await assert.rejects(addProject({ name: 'New', folder: '/no/such/folder/here' }, { ...e, git: fakeGit() }), /no folder at/)
  await assert.rejects(addProject({ name: 'Shop', folder: dir }, { ...e, git: fakeGit({ repos: [dir] }) }), /already a project called Shop/)
  const notRepo = await addProject({ name: 'New', folder: dir }, { ...e, git: fakeGit() }).catch((err) => err)
  assert.match(notRepo.message, /not a git repository yet/)
  assert.equal(notRepo.canInit, true)
  assert.equal(e.writes().length, 0)
  const git = fakeGit()
  const made = await addProject({ name: 'New', folder: dir, init: true }, { ...e, git })
  assert.ok(git.ran.includes('init'))
  assert.equal(made.folder, dir)
  assert.deepEqual(e.writes()[0].body, { name: 'New', workspace: { cwd: dir } })
  await assert.rejects(addProject({ folder: dir, name: 'x'.repeat(90) }, { ...e, git }), /limited to 80/)
})

test('a project is added from a repository address only when it answers as one, and is copied into the projects folder', async () => {
  const projects = tmp('projects')
  const e = engine()
  const address = 'https://github.com/you/tea-shop.git'
  for (const bad of ['github.com/you/shop', 'https://github.com/you/shop --upload-pack=x', 'file:///etc', 'https://github.com/you/../x']) {
    await assert.rejects(addProject({ repo: bad }, { ...e, git: fakeGit(), projects }), /repository's address/, bad)
  }
  await assert.rejects(addProject({ repo: address }, { ...e, git: fakeGit(), projects }), /did not answer as a git repository/)
  const git = fakeGit({ remotes: [address] })
  const made = await addProject({ repo: address }, { ...e, git, projects })
  assert.equal(made.name, 'tea-shop')
  assert.equal(made.folder, path.join(projects, 'tea-shop'))
  assert.deepEqual(e.writes()[0].body.workspace, { cwd: path.join(projects, 'tea-shop'), repoUrl: address })
  await assert.rejects(addProject({ repo: address, name: 'Tea shop' }, { ...e, git, projects }), /already a folder at/)
})

test('a project is renamed, moved to another folder and archived without anything being deleted', async () => {
  const dir = tmp('moved')
  const e = engine()
  await renameProject(PROJECT, 'Tea shop', e)
  await assert.rejects(renameProject(PROJECT, '', e), /needs a name/)
  await moveProject(PROJECT, dir, { ...e, git: fakeGit({ repos: [dir] }) })
  await archiveProject(PROJECT, true, e)
  await archiveProject(PROJECT, false, e)
  assert.deepEqual(e.writes().map((c) => [c.method, c.path, c.body]), [
    ['PATCH', `/projects/${PROJECT}`, { name: 'Tea shop' }],
    ['PATCH', `/projects/${PROJECT}/workspaces/${SPACE}`, { cwd: dir }],
    ['PATCH', `/projects/${PROJECT}`, { archived: true }],
    ['PATCH', `/projects/${PROJECT}`, { archived: false }],
  ])
  await assert.rejects(moveProject(PROJECT, dir, { ...e, git: fakeGit() }), /not a git repository/)
})

// ── routines ────────────────────────────────────────────────────────────────────────

test('a routine is added on a plain choice of when, and changed without touching what was not sent', async () => {
  const e = engine()
  await addRoutine({ title: 'Check the shop', plan: { kind: 'hours', n: 4 }, timezone: 'Europe/Berlin' }, e)
  assert.deepEqual(e.writes().map((c) => c.body), [{ title: 'Check the shop', description: '', assigneeAgentId: LEAD }, { kind: 'schedule', cronExpression: '0 */4 * * *', timezone: 'Europe/Berlin' }])
  await assert.rejects(addRoutine({ title: 'x', plan: { kind: 'cron', cron: 'every day' } }, e), /five parts/)
  await assert.rejects(addRoutine({ title: 'x', plan: { kind: 'daily', at: '07:00' } }, engine({ bots: [] })), /Add a bot first/)
  const edit = engine()
  await editRoutine(ROUTINE, { title: ' Nightly check ', botId: BOB }, edit)
  assert.deepEqual(edit.writes()[0].body, { title: 'Nightly check', assigneeAgentId: BOB })
  await assert.rejects(editRoutine(ROUTINE, { botId: PROJECT }, edit), /not in this studio/)
  await assert.rejects(editRoutine(ROUTINE, {}, edit), /Nothing to change/)
})

// ── the first run ───────────────────────────────────────────────────────────────────

test('an empty studio is led step by step; each step can be skipped, and what exists counts as done', async () => {
  const file = path.join(tmp('first'), 'first-run.json')
  const e = { ...engine({ bots: [], projects: [] }), devices: path.join(tmp('first'), 'devices.json') }
  let at = await firstRun({ file, ...e })
  assert.deepEqual([at.show, at.empty, at.step], [true, true, 'name'])
  await nameStudio('Tea Studio', { file, ...e })
  assert.equal(e.state.company.name, 'Tea Studio')
  at = await firstRunMark({ step: 'setup', mark: 'seen' }, { file, ...e })
  assert.equal(at.step, 'crew')
  at = await firstRunMark({ step: 'crew', mark: 'skip' }, { file, ...e })
  assert.deepEqual([at.step, at.steps.find((s) => s.id === 'crew').state], ['chat', 'skipped'])
  assert.deepEqual(at.left, ['crew', 'chat', 'project', 'job', 'phone'], 'a skipped step is still to be found in Setup')
  at = await firstRunMark({ step: 'crew', mark: 'again' }, { file, ...e })
  assert.equal(at.step, 'crew')
  // Closing the guide hides it; it is not lost.
  at = await firstRunMark({ mark: 'close' }, { file, ...e })
  assert.deepEqual([at.show, at.step], [false, 'crew'])
  await assert.rejects(firstRunMark({ step: 'nonsense', mark: 'skip' }, { file, ...e }), /not a step/)
  await assert.rejects(nameStudio('', { file, ...e }), /needs a name/)
})

test('a studio that already has a crew, a project and a job is past the first run, whatever was noted', async () => {
  const devices = path.join(tmp('first'), 'devices.json')
  const at = await firstRun({ file: path.join(tmp('first'), 'none.json'), devices, ...engine({ jobs: [{ id: 'j1', identifier: 'LH-1', title: 'First', assigneeAgentId: LEAD }, { id: 'j2', identifier: 'LH-2', title: 'Second', assigneeAgentId: LEAD }] }) })
  assert.deepEqual([at.show, at.step, at.left], [false, '', []])
  assert.deepEqual(at.firstJob, { id: 'j1', ref: 'LH-1', title: 'First' })
})

test('the chat step is done when a bot has answered, and the phone step when a phone is paired; a yard waits on neither for good', async () => {
  const folder = tmp('first')
  const file = path.join(folder, 'first-run.json')
  const devices = path.join(folder, 'devices.json')
  const said = { id: 'c1', authorType: 'user', body: 'Hello' }
  // A hello with no answer yet: the step is still to do, and says who was asked.
  let e = engine({ chats: [{ id: 'chat1', conversationAgentId: LEAD }], comments: { chat1: [said] } })
  let at = await firstRun({ file, devices, ...e })
  assert.deepEqual(at.greet, { id: LEAD, name: 'Lead' }, 'the lead is the one to greet')
  assert.deepEqual([at.steps.find((s) => s.id === 'chat').state, at.chat.answered, at.chat.bot], ['todo', false, 'Lead'])
  e = engine({ chats: [{ id: 'chat1', conversationAgentId: LEAD }], comments: { chat1: [{ id: 'c2', authorType: 'agent', body: 'Hello, I am the lead.' }, said] } })
  at = await firstRun({ file, devices, ...e })
  assert.deepEqual([at.steps.find((s) => s.id === 'chat').state, at.chat.text], ['done', 'Hello, I am the lead.'])
  assert.equal(at.steps.find((s) => s.id === 'phone').state, 'todo')
  fs.writeFileSync(devices, JSON.stringify({ sharedRetired: true, devices: [{ id: 'd1', name: 'Phone', hash: 'ab' }] }))
  at = await firstRun({ file, devices, ...e })
  assert.deepEqual([at.steps.find((s) => s.id === 'phone').state, at.phones], ['done', 1])
  // With every needed step done, a phone not paired does not keep the guide open by itself.
  const done = engine({ jobs: [{ id: 'j1', identifier: 'LH-1', title: 'First', assigneeAgentId: LEAD }], chats: [{ id: 'chat1', conversationAgentId: LEAD }], comments: { chat1: [{ id: 'c2', authorType: 'agent', body: 'Hi' }] } })
  await nameStudio('Tea Studio', { file, ...done })
  await firstRunMark({ step: 'setup', mark: 'seen' }, { file, ...done })
  at = await firstRun({ file, devices: path.join(folder, 'none.json'), ...done })
  assert.equal(at.show, false)
})

// ── the phone's door ────────────────────────────────────────────────────────────────

async function withDoor(e, run) {
  const folder = tmp('door')
  const handler = phoneHandler({
    token: 'a'.repeat(40), engine: { fetcher: e.fetcher }, sessions: async () => [], devices: path.join(folder, 'devices.json'), guard: folder,
    away: path.join(folder, 'away.json'), edge: path.join(folder, 'edge.json'), crew: folder, plans: async () => null, timers: async () => [], research: folder,
    firstRunFile: path.join(folder, 'first-run.json'), shape: { retired: [], crewRepo: crewRepo() },
    connectors: { crew: [{ id: LEAD, name: 'Lead' }], options: { folder: path.join(folder, 'keys'), out: path.join(folder, 'out'), engines: () => [] } },
  })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await handler.warmed
  const ask = async (where, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${where}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${'a'.repeat(40)}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  try { await run(ask) } finally { server.close() }
}

test('the phone has the same crew editor: settings, a save, a variable by name, a new bot, and removing one', async () => {
  const e = engine()
  await withDoor(e, async (ask) => {
    const settings = await ask(`/v1/bots/${LEAD}/settings`)
    assert.equal(settings.status, 200)
    assert.equal(settings.body.name, 'Lead')
    assert.equal(JSON.stringify(settings.body).includes('/secret'), false)
    assert.equal((await ask(`/v1/bots/${LEAD}/settings`, { title: 'From the phone' })).status, 200)
    assert.equal(e.state.bots[0].title, 'From the phone')
    const set = await ask(`/v1/bots/${LEAD}/variables`, { name: 'PHONE_KEY', value: 'phone-secret-value' })
    assert.equal(JSON.stringify(set.body).includes('phone-secret-value'), false)
    assert.equal((await ask('/v1/bots/new')).body.templates.length, 4)
    const made = await ask('/v1/bots', { name: 'Pip', ai: 'free' })
    assert.equal(made.status, 201)
    assert.equal((await ask(`/v1/bots/${BOB}/remove`, {})).body.name, 'Builder')
    assert.equal((await ask('/v1/first-run')).body.studio.name, 'My studio')
    assert.equal((await ask('/v1/first-run', { action: 'name', name: 'Phone Studio' })).body.studio.name, 'Phone Studio')
  })
})

test('from the phone a key can be pasted but a sign-in is started only at the computer; setup that is not there says so', async () => {
  await withDoor(engine(), async (ask) => {
    const start = await ask('/v1/setup', { action: 'start', id: 'claude' })
    // Refused as not at the computer where the service has its setup checks, or as not available where it has none.
    assert.ok([403, 501].includes(start.status), String(start.status))
    const state = await ask('/v1/setup')
    assert.equal(state.status, 200)
    assert.equal(typeof state.body.available, 'boolean')
    assert.ok(Array.isArray(state.body.rows))
    for (const row of state.body.rows) if (row.action?.kind === 'start') assert.equal(row.action.here, false)
    const helpers = await ask('/v1/helpers')
    assert.equal(helpers.status, 200)
    assert.ok(Array.isArray(helpers.body.jobs))
  })
})
