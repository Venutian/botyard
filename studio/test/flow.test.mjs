/**
 * The crew flow (`GET /api/studio/flow`) and the crew map that draws it: the answer's shape on the sample
 * yard, line kinds that come from roles and fields and never from names, one Needs-you number everywhere,
 * and a kept answer that is dropped as soon as anything it is made of changes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { fillSampleYard } from '../tools/sample-yard.mjs'
import { EDGE_KINDS, WINDOWS, authorOf, buildFlow, changeStamp, crewFlow, dropFlow, keptAnswer, needsList, outcomeOf, weekStartOf, withWeek } from '../server/lib/flow.mjs'
import { waitingCount as serverCount } from '../server/lib/cards.mjs'
import { studioSummary } from '../server/lib/engine.mjs'
import { waitingCount as pageCount } from '../src/ui/needs-count.js'
import { edgeSentence, flowHtml, flowList, layoutFlow, legendHtml, nodeSentence, shapeOf } from '../src/ui/crew-map.js'

const KINDS = new Set(EDGE_KINDS.map((k) => k.kind))

async function yard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'))
  const engine = await startEngine({ dataDir, port: null, runs: false, log: () => {} })
  await fillSampleYard(engine, { dataDir, now: Date.now() })
  let calls = 0
  const fetcher = async (url, init = {}) => {
    calls += 1
    const out = await engine.handle({ method: init.method || 'GET', url: new URL(url).pathname + new URL(url).search, body: init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify(out.body), { status: out.status })
  }
  const get = async (url) => (await engine.handle({ method: 'GET', url })).body
  const [company] = await get('/api/companies')
  return {
    dataDir, engine, fetcher, get, company, calls: () => calls,
    stop: async () => { await engine.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) },
  }
}
const read = (y) => async () => (await studioSummary({ fetcher: y.fetcher })).needsYou
const flowOf = (y, window = '24h') => crewFlow({ window, fetcher: y.fetcher, folder: path.join(y.dataDir, 'crew'), guard: { ranked: ['Tide Tables'], shelved: ['Lighthouse Site'] }, rested: {}, needs: read(y) })

test('the flow of the sample yard: the owner, every bot, the scripts, typed lines between them, and the lanes in work order', async (t) => {
  const y = await yard()
  t.after(y.stop)
  dropFlow()
  const agents = await y.get(`/api/companies/${y.company.id}/agents`)
  for (const window of Object.keys(WINDOWS)) {
    const flow = await flowOf(y, window)
    assert.equal(flow.window, window)
    const owner = flow.nodes.find((n) => n.id === 'owner')
    assert.equal(owner.kind, 'owner')
    const bots = flow.nodes.filter((n) => n.kind === 'bot')
    assert.deepEqual(bots.map((b) => b.id).sort(), agents.map((a) => a.id).sort(), 'every bot of the crew is a node')
    for (const b of bots) {
      for (const key of ['name', 'role', 'roleName', 'under', 'model', 'engine', 'status', 'runsToday', 'met', 'notMet']) assert.ok(key in b, `${b.name} has ${key}`)
      assert.ok(['working', 'waiting', 'free', 'resting', 'paused', 'error'].includes(b.status))
      assert.ok(b.week && 'share' in b.week && typeof b.week.tokens === 'number')
      assert.ok(b.under === 'owner' || bots.some((x) => x.id === b.under), 'each bot hangs under the owner or another bot')
      if (b.job) for (const key of ['id', 'ref', 'title', 'stage', 'project']) assert.ok(key in b.job)
    }
    const ids = new Set(flow.nodes.map((n) => n.id))
    for (const e of flow.edges) {
      assert.ok(KINDS.has(e.kind), e.kind)
      assert.ok(ids.has(e.from) && ids.has(e.to), `${e.id} joins two nodes`)
      assert.notEqual(e.from, e.to)
      assert.ok(e.count >= 1 && e.messages.length >= 1 && e.messages.length <= 5)
    }
    // Lanes: the owner's order first, shelved projects left out.
    assert.equal(flow.lanes[0].name, 'Tide Tables')
    assert.ok(!flow.lanes.some((l) => l.name === 'Lighthouse Site'))
    assert.deepEqual(flow.lanes.map((l) => l.rank), flow.lanes.map((_, i) => i + 1))
  }
  const week = await flowOf(y, '7d')
  const kinds = new Set(week.edges.map((e) => e.kind))
  for (const kind of ['order', 'brief', 'report', 'check', 'verdict', 'ask', 'ruling', 'idea', 'approval', 'start', 'card', 'notice', 'wait']) assert.ok(kinds.has(kind), `the sample shows a ${kind} line`)
  assert.ok(week.edges.some((e) => e.failed > 0), 'a line that ended in a failure is marked')
  const scripts = week.nodes.filter((n) => n.kind === 'script').map((n) => n.name).sort()
  assert.deepEqual(scripts, ['Health check', 'Review guard', 'Wait watch'], 'signed notes come from a machine-room node each')
  // The share of the Claude week counts cached reads and adds up over the Claude bots.
  const shares = week.nodes.filter((n) => n.kind === 'bot' && typeof n.week.share === 'number').map((n) => n.week.share)
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.ok(week.nodes.some((n) => n.met > 0) && week.nodes.some((n) => n.notMet > 0), 'MET and NOT MET are counted')
  // "Now" holds less than the week, never more.
  const now = await flowOf(y, 'now')
  assert.ok(now.edges.reduce((s, e) => s + e.count, 0) <= week.edges.reduce((s, e) => s + e.count, 0))
})

test('a line\'s kind comes from roles and fields, never from a bot\'s name', () => {
  const at = (mins) => new Date(Date.parse('2026-11-18T12:00:00Z') - mins * 60_000).toISOString()
  const bot = (id, name, role) => ({ id, name, metadata: { role }, adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5' }, status: 'idle', createdAt: at(1000 - id.length) })
  // Every name says another role than the bot plays.
  const agents = [bot('a', 'Checker', 'lead'), bot('bb', 'Lead', 'builder'), bot('ccc', 'Builder', 'checker'), bot('dddd', 'Researcher', 'ruler'), bot('eeeee', 'Ruler', 'researcher')]
  const job = (id, title, by, to, extra = {}) => ({ id, identifier: `T-${id}`, title, createdByAgentId: by, assigneeAgentId: to, status: 'done', createdAt: at(30), updatedAt: at(10), ...extra })
  const issues = [
    job('1', 'Build the thing', 'a', 'bb'),
    job('2', 'Check T-1: Build the thing', 'a', 'ccc'),
    job('3', 'Ruling: may it skip the check?', 'a', 'dddd'),
    job('4', 'An idea worth a look', 'eeeee', 'dddd'),
    job('5', 'Start on the idea', 'a', 'bb', { parentId: '4' }),
  ]
  const said = (author, body, mins = 5) => ({ authorType: 'agent', authorAgentId: author, body, createdAt: at(mins) })
  const comments = new Map([
    ['1', [said('bb', 'Built it. OUTCOME: MET')]],
    ['2', [said('ccc', '## VERDICT: FAIL\nIt breaks the page.')]],
    ['3', [said('dddd', 'RULING: no.')]],
    ['4', [said('dddd', 'RULING: APPROVED. One small step.')]],
  ])
  const flow = buildFlow({ agents, issues, comments, window: '24h', now: Date.parse('2026-11-18T12:00:00Z') })
  const line = (kind) => flow.edges.filter((e) => e.kind === kind).map((e) => `${e.from}>${e.to}`).sort()
  assert.deepEqual(line('brief'), ['a>bb'])
  assert.deepEqual(line('check'), ['bb>ccc'], 'a check runs from the work\'s builder to its checker')
  assert.deepEqual(line('verdict'), ['ccc>bb'])
  assert.equal(flow.edges.find((e) => e.kind === 'verdict').lastFailed, true, 'a FAIL is drawn red')
  assert.deepEqual(line('ask'), ['a>dddd'])
  assert.deepEqual(line('ruling'), ['dddd>a'])
  assert.deepEqual(line('idea'), ['eeeee>dddd'])
  assert.deepEqual(line('approval'), ['dddd>eeeee'])
  assert.deepEqual(line('start'), ['a>bb'])
  assert.deepEqual(line('report'), ['bb>a'])
  // The same yard with every name swapped round draws the same lines.
  const renamed = agents.map((a, i) => ({ ...a, name: agents[(i + 2) % agents.length].name }))
  const again = buildFlow({ agents: renamed, issues, comments, window: '24h', now: Date.parse('2026-11-18T12:00:00Z') })
  assert.deepEqual(again.edges.map((e) => e.id), flow.edges.map((e) => e.id))
  // The lead's node hangs under the owner; the rest under the lead, whatever they are called.
  assert.equal(flow.nodes.find((n) => n.id === 'a').under, 'owner')
  assert.ok(flow.nodes.filter((n) => n.kind === 'bot' && n.id !== 'a').every((n) => n.under === 'a'))
})

test('a script is known by its author or its signature, and a result by its OUTCOME or VERDICT line', () => {
  assert.deepEqual(authorOf({ authorType: 'user', authorUserId: 'script:review-guard', body: 'x' }), { script: 'review-guard' })
  assert.deepEqual(authorOf({ authorType: 'user', authorUserId: 'local-board', body: 'Stuck.\n\n<!-- yard-script: Wait watch -->' }), { script: 'Wait watch' })
  assert.deepEqual(authorOf({ authorType: 'user', authorUserId: 'local-board', body: 'Please do it.' }), { owner: true })
  assert.deepEqual(authorOf({ authorType: 'agent', authorAgentId: 'x', body: '' }), { agent: 'x' })
  assert.equal(outcomeOf('## OUTCOME: NOT MET'), 'not met')
  assert.equal(outcomeOf('VERDICT: PASS'), 'met')
  assert.equal(outcomeOf('It mostly works.'), null)
})

test('one Needs-you number: the server, the flow\'s owner node, the page and the phone count the same cards', async (t) => {
  const y = await yard()
  t.after(y.stop)
  dropFlow()
  const needs = await read(y)()
  // Archived, blocked and failed cards are not in it: only approvals and questions waiting for the owner.
  const mixed = [...needs, { kind: 'failed', id: '', title: 'A run failed' }, { kind: 'blocked', id: 'x', title: 'Blocked' }, { kind: 'question', id: 'q', title: 'Old', archived: true }]
  assert.equal(serverCount(mixed), pageCount(mixed))
  assert.equal(serverCount(mixed), needs.filter((n) => n.kind === 'approval' || n.kind === 'question').length)
  const flow = await flowOf(y)
  assert.equal(flow.needs, serverCount(needs))
  assert.equal(flow.nodes.find((n) => n.id === 'owner').needs, flow.needs)
  assert.equal(flow.needs, 2, 'the sample has two cards waiting: a merge yes-or-no and a payment question')
  assert.equal(flow.edges.filter((e) => e.kind === 'card').reduce((s, e) => s + e.count, 0), flow.needs, 'one card line per waiting card')
  // The phone counts with the same rule.
  const phone = fs.readFileSync(new URL('../../src/crew.ts', import.meta.url), 'utf8')
  assert.match(phone, /isDecision[^\n]*'approval'[^\n]*'question'/)
  assert.match(phone, /waitingCount/)
})

test('the flow and the cards are kept ten seconds, and dropped when a job, a comment or a card changes', async (t) => {
  const y = await yard()
  t.after(y.stop)
  dropFlow()
  const first = await flowOf(y)
  const before = y.calls()
  const second = await flowOf(y)
  assert.equal(second, first, 'the same answer while nothing changed')
  assert.ok(y.calls() - before <= 5, `only the cheap reads that tell whether anything changed (${y.calls() - before})`)
  // A comment moves its job: the stamp changes and the flow is worked out again.
  const job = (await y.get(`/api/companies/${y.company.id}/issues?limit=1000`)).find((i) => i.status === 'in_progress' && !i.title.startsWith('Check'))
  await y.engine.handle({ method: 'POST', url: `/api/issues/${job.id}/comments`, body: { body: 'Still on it.' } })
  const third = await flowOf(y)
  assert.notEqual(third, first)
  // A write from the page drops both kept answers at once.
  const kept = await needsList({ read: read(y), fetcher: y.fetcher })
  assert.equal(await needsList({ read: read(y), fetcher: y.fetcher }), kept)
  dropFlow()
  assert.notEqual(await needsList({ read: read(y), fetcher: y.fetcher }), kept)
  assert.notEqual(await flowOf(y), third)
})

test('a kept answer: served within its time for the same stamp, made again for a new stamp or after a drop', async () => {
  const keep = keptAnswer(10_000)
  let made = 0
  const make = async () => ({ n: ++made })
  const a = await keep.get('k', 's1', make)
  assert.equal(await keep.get('k', 's1', make), a)
  assert.notEqual(await keep.get('k', 's2', make), a)
  keep.drop()
  await keep.get('k', 's2', make)
  assert.equal(made, 3)
  const quick = keptAnswer(0)
  await quick.get('k', 's', make)
  await quick.get('k', 's', make)
  assert.equal(made, 5, 'past its time it is made again')
  assert.notEqual(changeStamp({ issues: [{ id: 'a', updatedAt: '2026-11-18T10:00:00Z' }] }), changeStamp({ issues: [{ id: 'a', updatedAt: '2026-11-18T10:00:01Z' }] }))
  assert.equal(weekStartOf({ resets: Date.parse('2026-11-20T18:00:00Z') / 1000 }, Date.parse('2026-11-18T12:00:00Z')), Date.parse('2026-11-13T18:00:00Z'))
})

test('the Crew sheet takes each bot\'s week from the flow', () => {
  const list = { bots: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }
  const flow = { nodes: [{ id: 'a', kind: 'bot', week: { share: 0.75, tokens: 9 }, met: 2, notMet: 1 }] }
  const out = withWeek(list, flow)
  assert.deepEqual(out.bots[0], { id: 'a', name: 'A', claudeShare: 0.75, weekTokensAll: 9, met: 2, notMet: 1 })
  assert.deepEqual(out.bots[1], { id: 'b', name: 'B' })
})

test('the crew map draws every node and line as a button with words, in its box, with a list that says the same', async (t) => {
  const y = await yard()
  t.after(y.stop)
  dropFlow()
  const flow = await flowOf(y, '7d')
  for (const size of [{ width: 1336, height: 730 }, { width: 1100, height: 640 }]) {
    const layout = layoutFlow(flow, size)
    const boxes = [...layout.box.entries()]
    for (const [id, b] of boxes) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= size.width && b.y + b.h <= size.height, `${id} inside the box`)
      for (const [other, c] of boxes) if (other !== id) assert.ok(b.x + b.w <= c.x || c.x + c.w <= b.x || b.y + b.h <= c.y || c.y + c.h <= b.y, `${id} and ${other} do not overlap`)
    }
    for (const lane of layout.lanes) assert.ok(lane.x >= layout.chartW, 'the lanes are right of the chart')
    const html = flowHtml(flow, layout, { window: '7d' })
    assert.equal((html.match(/class="cm-chip /g) || []).length, flow.edges.length, 'a count on every line')
    assert.equal((html.match(/class="cm-node /g) || []).length, flow.nodes.length, 'a plate for every node')
    for (const button of html.match(/<button[^>]*>/g)) assert.match(button, /aria-label="[^"]{12,}"/, 'every button says what it is')
  }
  const list = flowList(flow, { window: '7d' })
  for (const n of flow.nodes) assert.ok(list.includes(nodeSentence(n, flow.nodes).replace(/'/g, '&#39;')), `${n.name} in the list`)
  for (const e of flow.edges.filter((x) => x.from === 'owner' || x.to === 'owner')) assert.ok(list.includes(edgeSentence(e, flow.nodes, '7d').replace(/'/g, '&#39;')))
  assert.match(legendHtml(flow), /Last one failed/)
  // A change that keeps the shape is patched, not redrawn.
  const bumped = structuredClone(flow)
  bumped.edges[0].count += 3
  assert.equal(shapeOf(bumped, '1x1'), shapeOf(flow, '1x1'))
})
