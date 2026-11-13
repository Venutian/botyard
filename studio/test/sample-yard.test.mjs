/**
 * The sample yard `npm run demo` shows: it fills an empty store through the engine, every state the
 * map can show is in it, and nothing in it is anybody's real name or work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { CREW, PROJECTS, SLOTS, STUDIO, crewFromTree, fillSampleYard } from '../tools/sample-yard.mjs'
import { connectorList } from '../server/lib/connectors.mjs'
import { createTimetable } from '../server/lib/timetable.mjs'
import { buildManager, readCrewFiles, verdictOf } from '../server/lib/manager.mjs'
import { crewLooks } from '../server/lib/looks.mjs'

const NOW = Date.parse('2026-11-13T12:00:00Z')

async function yard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-yard-'))
  const engine = await startEngine({ dataDir, port: null, runs: false, log: () => {} })
  const get = async (url) => (await engine.handle({ method: 'GET', url })).body
  return { dataDir, engine, get, stop: async () => { await engine.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) } }
}

test('the sample yard fills an empty store: a named studio, its projects, its crew, and work in every state', async (t) => {
  const y = await yard()
  t.after(y.stop)
  const made = await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW })
  const [studio] = await y.get('/companies')
  assert.deepEqual([studio.name, studio.issuePrefix], [STUDIO.name, STUDIO.prefix])

  const projects = (await y.get(`/companies/${studio.id}/projects`)).filter((p) => !p.archivedAt)
  assert.deepEqual(projects.map((p) => p.name).sort(), PROJECTS.map((p) => p.name).sort())
  assert.ok(projects.every((p) => fs.existsSync(p.workspaces[0].cwd)), 'each project has a folder of its own inside the home')

  const bots = await y.get(`/companies/${studio.id}/agents`)
  assert.equal(bots.length, CREW.length)
  assert.ok(new Set(bots.map((b) => b.adapterType)).size >= 2, 'the crew runs on more than one AI, free models among them')
  const looks = crewLooks(bots)
  assert.deepEqual(new Set([...looks.values()].map((l) => l.role)), new Set(['lead', 'ruler', 'reviewer', 'builder', 'checker', 'researcher']))
  assert.equal(new Set([...looks.values()].map((l) => l.look.colour)).size, CREW.length, 'every bot wears a colour of its own')
  assert.equal(new Set([...looks.values()].map((l) => l.look.hat)).size, CREW.length, 'and a hat of its own')
  assert.equal(bots.filter((b) => b.status === 'paused').length, 1)

  const jobs = await y.get(`/companies/${studio.id}/issues?limit=1000`)
  const work = jobs.filter((j) => !j.conversationAgentId)
  for (const status of ['in_progress', 'todo', 'backlog', 'blocked', 'done', 'cancelled']) assert.ok(work.some((j) => j.status === status), status)
  assert.ok(work.every((j) => j.identifier.startsWith('LH-')))
  assert.ok(work.some((j) => /^Check LH-\d+: /.test(j.title)) && work.some((j) => /^Check LH-\d+ \(Lead\): /.test(j.title)) && work.some((j) => /^Fix 1 of /.test(j.title)))
  // A day and a half of work, not a second of it.
  const done = work.find((j) => j.id === made.jobs.history.id)
  assert.ok(Date.parse(done.completedAt) < NOW - 24 * 3600 * 1000 && Date.parse(done.createdAt) < Date.parse(done.completedAt))

  const runs = await y.get(`/companies/${studio.id}/heartbeat-runs?limit=200`)
  assert.equal(runs.length, made.runs)
  for (const status of ['running', 'succeeded', 'failed']) assert.ok(runs.some((r) => r.status === status), status)
  const spend = await y.get(`/companies/${studio.id}/costs/by-agent?from=${encodeURIComponent(new Date(NOW - 7 * 24 * 3600 * 1000).toISOString())}`)
  assert.ok(spend.reduce((sum, row) => sum + Number(row.inputTokens) + Number(row.outputTokens), 0) > 1_000_000)

  const checkout = made.jobs.checkout.id
  assert.equal((await y.get(`/issues/${checkout}/documents/plan`)).latestRevisionNumber, 3)
  assert.equal((await y.get(`/issues/${checkout}/interactions`)).filter((c) => c.status === 'pending').length, 1)
  assert.equal((await y.get(`/companies/${studio.id}/routines`)).length, 2)
  assert.equal((await y.get(`/agents/${made.bots.marlow}/instructions-bundle/history`)).revisions.length, 3)
  assert.equal((await y.get(`/companies/${studio.id}/chats`)).length, 1)
})

test('the map reads the sample as a crew at work: every stage of the pipeline has a job in it', async (t) => {
  const y = await yard()
  t.after(y.stop)
  await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW })
  const [studio] = await y.get('/companies')
  const [agents, issues, projects, live] = await Promise.all([
    y.get(`/companies/${studio.id}/agents`), y.get(`/companies/${studio.id}/issues?limit=1000`), y.get(`/companies/${studio.id}/projects`), y.get(`/companies/${studio.id}/live-runs`),
  ])
  const comments = new Map()
  for (const issue of issues.filter((i) => /^Check /.test(i.title) && i.status === 'done')) comments.set(issue.id, await y.get(`/issues/${issue.id}/comments?limit=8`))
  const manager = buildManager({
    agents, issues: issues.filter((i) => !i.conversationAgentId), projects: projects.filter((p) => !p.archivedAt), live,
    files: readCrewFiles(path.join(y.dataDir, 'crew')), verdicts: new Map([...comments].map(([id, list]) => [id, verdictOf(list)])), now: NOW,
  })
  const stages = new Set(manager.lines.map((l) => l.stage))
  for (const stage of ['build', 'check', 'ruling', 'blocked', 'queued']) assert.ok(stages.has(stage), `${stage}: ${[...stages].join(', ')}`)
  assert.ok(manager.bots.filter((b) => b.status === 'running').length >= 4, 'several bots are at work at once')
  assert.deepEqual([...new Set(manager.bots.map((b) => b.tier))], ['Lead', 'Judges', 'Builders', 'Checkers', 'Research'])
  assert.equal(manager.projects.length, 4)
})

test('the sample goes only into an empty yard, and names nobody real', async (t) => {
  const y = await yard()
  t.after(y.stop)
  await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW })
  await assert.rejects(fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW }), /only put into an empty yard/)
  // Every word of the sample is in its one file: no address of a person, no home folder, no key.
  const text = fs.readFileSync(new URL('../tools/sample-yard.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'no email address')
  assert.doesNotMatch(text, /\/home\/\w+|\/Users\/\w+|C:\\Users/, 'no home folder of a person')
  assert.doesNotMatch(text, /\b(sk-[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})/, 'nothing shaped like a key')
})

test('the sample yard has two connectors to show, and nothing about them is ever called', async (t) => {
  const y = await yard()
  t.after(y.stop)
  const made = await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW, crew: CREW })
  const [studio] = await y.get('/companies')
  const crew = await y.get(`/companies/${studio.id}/agents`)
  const list = connectorList({ crew, folder: path.join(y.dataDir, 'keys'), now: NOW, engines: () => [] })
  assert.equal(made.connectors, 2)
  assert.deepEqual(list.connectors.map((c) => [c.name, c.state]), [['Harbour tracker', 'ready'], ['Tide office', 'signed-out']])
  for (const c of list.connectors) {
    assert.match(c.address, /^https:\/\/[a-z]+\.lighthouse\.invalid\//, 'an address that can never answer')
    assert.ok(c.tools.length >= 1 && c.about.length > 20)
  }
  const tracker = list.connectors[0]
  assert.deepEqual([tracker.reads, tracker.changes], [2, 1])
  assert.deepEqual(tracker.bots.filter((b) => b.level !== 'off').map((b) => b.name).sort(), ['Atlas', 'Rook', 'Sable'])
  assert.equal(fs.statSync(path.join(y.dataDir, 'keys', 'connectors.json')).mode & 0o777, 0o600)
  assert.doesNotMatch(fs.readFileSync(path.join(y.dataDir, 'keys', 'connectors.json'), 'utf8'), /"(value|accessToken|refreshToken)"/, 'no key or token is in the sample, made up or not')
})

test('the sample yard remembers a last run for every helper of the tree, and a locked timetable lists them without starting one', async (t) => {
  const y = await yard()
  t.after(y.stop)
  const made = await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW, crew: CREW })
  const tree = path.resolve(import.meta.dirname, '..', '..', 'crew', 'timetable.json')
  const started = []
  const table = createTimetable({ file: tree, stateFile: path.join(y.dataDir, 'timetable-state.json'), logDir: path.join(y.dataDir, 'run-logs', 'timetable'), locked: 'This is the sample yard.',
    vars: { python: 'python3', node: process.execPath, scripts: path.dirname(tree), repo: path.dirname(path.dirname(tree)) }, now: () => NOW, spawn: (...args) => { started.push(args); throw new Error('nothing may start') }, log: () => {} })
  table.start()
  const state = table.state()
  assert.deepEqual([state.state, state.why], ['off', 'This is the sample yard.'])
  const timers = state.jobs.filter((job) => job.kind === 'timer')
  assert.equal(timers.length, made.helpers)
  assert.ok(timers.length >= 3)
  for (const job of timers) {
    assert.ok(job.lastOk === true && job.lastStart < NOW && job.lastEnd > job.lastStart && NOW - job.lastStart < 24 * 3_600_000, `${job.name} last ran within the day`)
    if (job.on) assert.ok(job.nextAt > NOW, `${job.name} says when it would next run`)
  }
  table.tick()
  assert.deepEqual(table.act({ action: 'run', name: timers[0].name }), [409, { error: 'This is the sample yard.' }])
  assert.equal(table.act({ action: 'on' })[0], 409)
  assert.deepEqual(started, [], 'no helper was started')
  await table.stop()
})

test('the tree\'s default crew plays the sample\'s parts when all eight of its files are there, and only then', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-crew-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'shared'))
  fs.writeFileSync(path.join(dir, 'shared', 'report-end.md'), 'End every report with OUTCOME.\n')
  const files = {
    lead: { name: 'Lead', role: 'lead', ai: 'free', model: 'auto', reportsTo: null, look: { colour: '#1d1e22', hat: 'crown' } },
    ruler: { name: 'Ruler', role: 'ruler', ai: 'claude', model: 'claude-opus-5-5', reportsTo: 'lead', on: false, needs: 'claude' },
    reviewer: { name: 'Reviewer', role: 'reviewer', ai: 'claude', model: 'claude-opus-5-5', reportsTo: 'lead' },
    'senior-builder': { name: 'Senior Builder', role: 'builder', tier: 'strong', ai: 'claude', model: 'claude-opus-5-5', reportsTo: 'lead', atOnce: 2 },
    'claude-builder': { name: 'Claude Builder', role: 'builder', tier: 'light', ai: 'claude', model: 'claude-sonnet-5-5', reportsTo: 'lead' },
    builder: { name: 'Builder', role: 'builder', ai: 'free', model: 'auto', reportsTo: 'lead', mayNot: ['push'] },
    checker: { name: 'Checker', role: 'checker', ai: 'free', model: 'auto', reportsTo: 'lead', mayNot: ['push', 'commit'], look: { colour: '#f06fae', hat: 'feelers' } },
    researcher: { name: 'Researcher', role: 'researcher', ai: 'free', model: 'auto', reportsTo: 'lead' },
  }
  for (const [slug, file] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ title: `The ${slug}`, does: `What the ${slug} is for.`, ...file }))
    fs.writeFileSync(path.join(dir, `${slug}.md`), `You are {{name}} of {{studio}}.\n\n{{shared: report-end}}\n{{crew-ids}}\n`)
  }
  const crew = crewFromTree(dir)
  assert.deepEqual(Object.fromEntries(crew.map((b) => [b.key, b.slug])), SLOTS)
  assert.deepEqual(crew.map((b) => b.name), ['Lead', 'Ruler', 'Reviewer', 'Senior Builder', 'Claude Builder', 'Builder', 'Checker', 'Researcher'])
  assert.equal(crew.find((b) => b.key === 'atlas').boss, 'marlow', 'everyone answers to the lead')
  assert.equal(crew.find((b) => b.key === 'marlow').rules, 'You are Lead of Lighthouse Labs.\n\nEnd every report with OUTCOME.\n\n', 'shared paragraphs and plain marks are filled in; a mark only the seeder knows is left out')
  assert.deepEqual(crew.find((b) => b.key === 'sable').ai, ['opencode_local', { model: 'auto', variant: 'high', timeoutSec: 3600, mayNot: ['push', 'commit'] }])

  // The whole story is told with that crew: its names in every list, comment and chat, nobody else's.
  const y = await yard()
  t.after(y.stop)
  await fillSampleYard(y.engine, { dataDir: y.dataDir, now: NOW, crew })
  const [studio] = await y.get('/companies')
  const bots = await y.get(`/companies/${studio.id}/agents`)
  assert.deepEqual(bots.map((b) => b.name).sort(), Object.values(files).map((f) => f.name).sort())
  assert.equal(bots.find((b) => b.name === 'Lead').reportsTo, null)
  assert.deepEqual(crewLooks(bots).get(bots.find((b) => b.name === 'Ruler').id).role, 'ruler')
  const everything = JSON.stringify(y.engine.store.objects('SELECT raw FROM comments')) + JSON.stringify(y.engine.store.objects('SELECT raw FROM jobs'))
  assert.doesNotMatch(everything, /\b(Marlow|Juno|Piper|Atlas|Rook|Wren|Sable|Finch)\b/, 'the story speaks of the bots by their own names')
  assert.match(everything, /Senior Builder/)

  fs.rmSync(path.join(dir, 'ruler.json'))
  assert.equal(crewFromTree(dir), null, 'seven of eight is not a crew to tell the story with')
})
