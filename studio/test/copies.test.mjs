/**
 * A bot with copies on other AIs is one card: in the manager view (crew bar, Home), the crew map, the Crew
 * list and the page that draws them. The copies stay separate agents in the engine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyGroups } from '../server/lib/copies.mjs'
import { buildManager } from '../server/lib/manager.mjs'
import { buildFlow } from '../server/lib/flow.mjs'
import { botList } from '../server/lib/crew.mjs'
import { flowHtml, layoutFlow, nodeSentence } from '../src/ui/crew-map.js'
import { busyWords, copyTag } from '../src/ui/copies-view.js'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const ago = (m) => new Date(NOW - m * 60_000).toISOString()
const HOME = { id: 'checker', name: 'Checker', title: 'Checks the work', status: 'idle', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/glm-5.3-flash-free' }, metadata: { role: 'checker', look: { colour: '#2fbf5a' } }, createdAt: ago(900) }
const CODEX = { id: 'checker-codex', name: 'Checker on Codex', status: 'idle', adapterType: 'codex_local', adapterConfig: { model: 'gpt-5.5' }, metadata: { role: 'checker', lane: 'codex', laneOf: 'Checker' }, createdAt: ago(800) }
// A copy made before the crew's seed wrote the field is known by its name.
const CLAUDE = { id: 'checker-claude', name: 'Checker on Claude', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5' }, createdAt: ago(700) }
const LEAD = { id: 'lead', name: 'Lead', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5' }, metadata: { role: 'lead' }, createdAt: ago(1000) }
const AGENTS = [LEAD, HOME, CODEX, CLAUDE]
const PROJECTS = [{ id: 'p1', name: 'Harbour' }]
let n = 0
const check = (bot, status = 'in_progress') => {
  n += 1
  return { id: `c${n}`, identifier: `HB-${n}`, issueNumber: n, title: `Check HB-${100 + n}: Quay wall`, status, assigneeAgentId: bot, projectId: 'p1', createdAt: ago(100), startedAt: ago(30), lastActivityAt: ago(5) }
}
const files = { merges: [], stopped: [], switches: [], pace: {}, thinker: {}, freeOut: {}, freeOk: {}, notInMain: {}, ownerNotes: [], rested: {} }

test('a copy is known by what its settings say, else by its name', () => {
  const fold = copyGroups(AGENTS)
  assert.equal(fold.parentOf.get('checker-codex').id, 'checker')
  assert.equal(fold.parentOf.get('checker-claude').id, 'checker')
  assert.deepEqual(fold.top.map((a) => a.id), ['lead', 'checker'])
  assert.equal(fold.idOf('checker-claude'), 'checker')
  // A bot whose own name has "on" in it, and no parent of that name, stays a bot.
  assert.equal(copyGroups([{ id: 'a', name: 'Sitting on Claude' }]).top.length, 1)
  // A name alone does not make a copy when the settings name another parent.
  assert.equal(copyGroups([HOME, { id: 'x', name: 'Other on Codex', metadata: { laneOf: 'Nobody' } }]).top.length, 2)
})

test('the manager view has one card for a bot and its copies, with the jobs of all of them', () => {
  const issues = [check('checker'), check('checker-codex'), check('checker-codex')]
  const view = buildManager({ agents: AGENTS, issues, projects: PROJECTS, live: [{ agentId: 'checker-codex', issueId: issues[1].id }], files, now: NOW })
  assert.deepEqual(view.bots.map((b) => b.name), ['Lead', 'Checker'])
  const card = view.bots.find((b) => b.name === 'Checker')
  assert.equal(card.status, 'running')
  assert.equal(card.jobs.length, 3)
  assert.equal(card.where, 'Codex', 'the tag is the copy that runs')
  assert.equal(card.on, 'Codex')
  assert.deepEqual(card.copies.map((c) => [c.name, c.running]), [['Checker', false], ['Checker on Codex', true], ['Checker on Claude', false]])
  assert.ok(view.now.every((w) => w.bot === 'Checker' && w.botId === 'checker'), 'a copy working shows as the bot working')
  assert.doesNotMatch(JSON.stringify(view.lines), /on Codex/)
  assert.equal(view.projects[0].bots.includes('Checker'), true)
})

test('a bot with no copies has no copies field', () => {
  const view = buildManager({ agents: [LEAD, HOME], issues: [], projects: PROJECTS, files, now: NOW })
  assert.equal(view.bots.every((b) => !('copies' in b) && b.jobs.length === 0), true)
})

test('the crew map has one node for a bot and its copies, with its lines and jobs counted together', () => {
  const issues = [check('checker-claude'), check('checker-claude'), check('checker')]
  const flow = buildFlow({ agents: AGENTS, issues, live: [{ agentId: 'checker-claude', issueId: issues[0].id }], window: '24h', now: NOW })
  const bots = flow.nodes.filter((x) => x.kind === 'bot')
  assert.deepEqual(bots.map((b) => b.name), ['Lead', 'Checker'])
  const node = bots.find((b) => b.id === 'checker')
  assert.equal(node.status, 'working')
  assert.equal(node.jobs.length, 3)
  assert.equal(node.engine, 'Claude')
  assert.equal(node.on, 'Claude')
  assert.equal(node.copies.length, 3)
  assert.ok(flow.edges.every((e) => ![e.from, e.to].includes('checker-claude') && ![e.from, e.to].includes('checker-codex')))
  assert.match(nodeSentence(node, flow.nodes), /On Claude, one of 3 copies\./)
  assert.match(nodeSentence(node, flow.nodes), /Checking 3: /)
})

test('the page draws one plate with the tag and the count', () => {
  const issues = [check('checker-codex'), check('checker-codex'), check('checker')]
  const flow = buildFlow({ agents: AGENTS, issues, live: [{ agentId: 'checker-codex', issueId: issues[0].id }], window: '24h', now: NOW })
  const html = flowHtml(flow, layoutFlow(flow, { width: 1400, height: 800 }))
  const plates = html.match(/class="cm-node cm-bot/g) || []
  assert.equal(plates.length, 2)
  assert.match(html, /<em class="copy-tag"[^>]*>Codex<\/em>/)
  assert.match(html, /checking 3/)
  assert.doesNotMatch(html, /Checker on Codex<\/span>/)
})

test('the crew bar words: the tag names the AI that runs, the count says what it is doing', () => {
  assert.equal(busyWords([{ stage: 'Checking HB-1' }, { stage: 'Checking HB-2' }, { stage: 'Checking HB-3' }]), 'checking 3')
  assert.equal(busyWords([{ stage: 'Checking HB-1' }, { stage: 'Building' }]), 'on 2 jobs')
  assert.equal(busyWords([{ stage: 'Checking HB-1' }]), '')
  assert.equal(copyTag({ name: 'Solo' }), '')
  assert.match(copyTag({ on: 'Codex', copies: [{ name: 'A', running: false }, { name: 'A on Codex', model: 'gpt', running: true }] }), /^<em class="copy-tag" title="Running on Codex \(gpt\)[^"]*">Codex<\/em>$/)
})

test('the Crew list has one row for a bot and its copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copies-'))
  for (const f of ['thinker', 'free-out']) fs.writeFileSync(path.join(dir, `${f}.json`), '{}')
  const json = (body) => new Response(JSON.stringify(body), { status: 200 })
  const fetcher = async (url) => {
    const p = new URL(url).pathname.replace('/api', '')
    if (p === '/companies') return json([{ id: 'co', status: 'active' }])
    if (p === '/companies/co/agents') return json(AGENTS)
    if (p === '/companies/co/live-runs') return json([{ agentId: 'checker-codex', issueId: 'j1' }, { agentId: 'checker-codex', issueId: 'j2' }])
    if (p === '/companies/co/costs/by-agent') return json([{ agentId: 'checker', inputTokens: 10 }, { agentId: 'checker-codex', inputTokens: 5, outputTokens: 1 }])
    return json([])
  }
  const list = await botList({ fetcher, folder: dir, now: NOW })
  assert.deepEqual(list.bots.map((b) => b.name).sort(), ['Checker', 'Lead'])
  const row = list.bots.find((b) => b.name === 'Checker')
  assert.equal(row.status, 'running')
  assert.equal(row.running, 2)
  assert.deepEqual(row.jobIds.sort(), ['j1', 'j2'])
  assert.equal(row.engine, 'Codex')
  assert.equal(row.on, 'Codex')
  assert.equal(row.tokensToday, 16)
  assert.equal(row.copies.length, 3)
  assert.deepEqual(list.org, [])
})

test('the phone says the same words as the page', async () => {
  const phone = await import('../../src/ui/copies.ts')
  for (const jobs of [[], [{ stage: 'Checking HB-1' }], [{ stage: 'Checking HB-1' }, { stage: 'Checking HB-2' }], [{ stage: 'Fixing' }, { stage: 'Building' }, { stage: 'Fix 2' }], [{ stage: 'Fix 2' }, { stage: 'Fixing' }]]) {
    assert.equal(phone.busyWords(jobs), busyWords(jobs), JSON.stringify(jobs))
  }
  const copies = [{ id: 'a', name: 'A', model: '', running: false }, { id: 'b', name: 'A on Codex', model: '', running: true }]
  assert.equal(phone.copyTag({ copies, on: 'Codex' }), 'Codex')
  assert.equal(phone.copyTag({ copies: copies.slice(0, 1), on: 'Codex' }), '')
  assert.equal(phone.copySentence({ copies, on: 'Codex' }), 'On Codex, one of 2 copies.')
})
