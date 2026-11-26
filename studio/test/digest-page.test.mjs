/** The decision digest on the page and the phone: the server's view, its two endpoints, and the list drawn at the top of Needs you. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { answer } from '../server/engine/api.mjs'
import { DAY_MS } from '../server/engine/card-kind.mjs'
import { applyDefaults } from '../server/engine/digest.mjs'
import { openStore } from '../server/engine/store.mjs'
import { createCard, createJob } from '../server/engine/write.mjs'
import { cardLine, digestView, shapeDigest, takeBackDefault, untilWords } from '../server/lib/digest.mjs'
import { phoneHandler } from '../server/phone.mjs'
import { digestHtml } from '../src/ui/digest-view.js'

const OWNER = { user: 'local-board' }
const TOKEN = 'a-test-token-that-is-long-enough-0123456789'
const choice = (prompt, options = ['Blue (recommended)', 'Red']) => ({ kind: 'ask_user_questions', title: prompt, payload: { questions: [{ id: 'q', prompt, options: options.map((label, n) => ({ id: `o${n + 1}`, label })) }] } })

/** The page's own calls answered by a real engine store in this process. */
function yard() {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0, status: 'active' })
  store.put('agents', { id: 'b1', companyId: 'co', name: 'Builder', status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-page-'))
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    const out = answer(store, { method: init.method || 'GET', url: u.pathname + u.search, headers: {}, body: init.body ? JSON.parse(init.body) : {} }, { dataDir, actor: OWNER })
    return new Response(JSON.stringify(out.body), { status: out.status })
  }
  const ask = (title, body, now = Date.now()) => createCard(store, createJob(store, 'co', { title, assigneeAgentId: 'b1' }, { now, actor: OWNER }).id, body, { now, actor: { agent: 'b1' } })
  return { store, fetcher, ask, dataDir }
}

test('the words a screen prints: when a default applies, and one line per card', () => {
  const now = Date.parse('2026-11-25T09:00:00Z')
  assert.equal(untilWords('2026-11-25T09:00:30Z', now), 'now')
  assert.equal(untilWords('2026-11-25T09:20:00Z', now), 'in 20 min')
  assert.equal(untilWords('2026-11-25T14:00:00Z', now), 'in 5 h')
  assert.equal(untilWords('2026-11-28T09:00:00Z', now), 'in 3 d')
  assert.equal(cardLine({ kind: 'must', why: 'It spends money' }, now), 'It spends money')
  assert.equal(cardLine({ kind: 'default', default: 'Blue', appliesAt: '2026-11-25T14:00:00Z' }, now), 'Default: Blue. Applies in 5 h.')
  const shaped = shapeDigest({ cards: [], applied: [{ id: 'c', answer: 'Blue', canReverse: true, reverseUntil: '2026-11-28T09:00:00Z' }, { id: 'd', answer: 'Red', canReverse: false, whyNot: 'Its job is finished: the engine cannot undo that' }], folded: 2, more: 1 }, now)
  assert.equal(shaped.notes, '2 repeats folded in, 1 more below')
  assert.deepEqual(shaped.applied.map((a) => a.line), ['Applied by default: Blue. Take back within 3 d.', 'Applied by default: Red. Its job is finished: the engine cannot undo that.'])
})

test('the page reads the digest through the engine and takes a default back through it', async () => {
  const { store, fetcher, ask } = yard()
  ask('Font', choice('Buy the font licence for 49 EUR?'))
  const lamp = ask('Lamp', choice('Which colour for the lamp?'))
  let view = await digestView({ fetcher })
  assert.deepEqual(view.cards.map((c) => [c.kind, c.line]), [['must', 'It spends money'], ['default', 'Default: Blue (recommended). Applies in 24 h.']])
  await assert.rejects(takeBackDefault({ jobId: 'x', cardId: lamp.id }, { fetcher }), /Say which card/)
  await assert.rejects(takeBackDefault({ jobId: lamp.issueId, cardId: lamp.id }, { fetcher }), /not applied by default/)
  applyDefaults(store, { now: Date.now() + DAY_MS + 1000 })
  // Applied a day from now, so the page (reading now) still has the seven days to take it back.
  view = await digestView({ fetcher })
  assert.deepEqual([view.cards.length, view.applied.length, view.applied[0].canReverse], [1, 1, true])
  view = await takeBackDefault({ jobId: lamp.issueId, cardId: lamp.id }, { fetcher })
  assert.deepEqual([view.cards.map((c) => c.kind), view.applied.length], [['must', 'must'], 0])
})

test('the list at the top of Needs you: the owner\'s own cards first, each default with its line, and Take back on what was applied', () => {
  assert.equal(digestHtml(null), '')
  assert.equal(digestHtml({ cards: [], applied: [] }), '')
  const html = digestHtml({
    cards: [
      { id: 'c1', jobId: 'j1', job: 'LH-1', kind: 'must', title: 'Buy the <font> licence?', line: 'It spends money', count: 1 },
      { id: 'c2', jobId: 'j2', job: 'LH-2', kind: 'default', title: 'Which colour?', line: 'Default: Blue. Applies in 5 h.', count: 3 },
      { id: 'c3', jobId: 'j3', job: '', chat: true, botId: 'b9', kind: 'default', title: 'Which tone?', line: 'Default: Plain. Applies in 6 h.', count: 1 },
    ],
    applied: [{ id: 'c4', jobId: 'j4', job: 'LH-4', title: 'Which size?', line: 'Applied by default: Small. Take back within 6 d.', canReverse: true }, { id: 'c5', jobId: 'j5', job: 'LH-5', title: 'Which font?', line: 'Applied by default: Serif. Its job is finished: the engine cannot undo that.', canReverse: false }],
    notes: '2 repeats folded in',
  })
  assert.ok(html.indexOf('Only you') < html.indexOf('Has a default'))
  assert.match(html, /Buy the &lt;font&gt; licence\?/)
  assert.match(html, /data-line="j1"/)
  assert.match(html, /asked 3 times · LH-2/)
  assert.match(html, /data-bot="b9"/, 'a card asked in a chat opens the chat')
  assert.match(html, /2 repeats folded in/)
  assert.equal(html.match(/data-act="digest-take-back"/g).length, 1, 'only what can still be undone has Take back')
  assert.match(html, /data-job="j4" data-card-id="c4"/)
})

test('the phone door answers /v1/digest, and the PC page has the same on /api/studio/digest', async () => {
  const { fetcher, ask, dataDir } = yard()
  ask('Lamp', choice('Which colour for the lamp?'))
  const handler = phoneHandler({ token: TOKEN, engine: { fetcher }, sessions: async () => [], devices: path.join(dataDir, 'devices.json'), guard: dataDir, away: path.join(dataDir, 'away.json'), edge: path.join(dataDir, 'edge.json'), crew: path.join(dataDir, 'crew'), plans: async () => ({}), timers: async () => [], previews: path.join(dataDir, 'previews'), firstRunFile: path.join(dataDir, 'first-run.json') })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const got = await fetch(`${base}/v1/digest`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(got.status, 200)
    const view = await got.json()
    assert.deepEqual(view.cards.map((c) => [c.kind, c.default]), [['default', 'Blue (recommended)']])
    assert.equal((await fetch(`${base}/v1/digest`)).status, 401)
    const bad = await fetch(`${base}/v1/digest`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'take-back', jobId: 'nope', cardId: 'nope' }) })
    assert.equal(bad.status, 400)
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })
  }
  const page = fs.readFileSync(new URL('../server/api.mjs', import.meta.url), 'utf8')
  assert.match(page, /url\.pathname === '\/api\/studio\/digest' && read\) return send\(res, 200, await digestView\(\)\)/)
  assert.match(page, /'\/api\/studio\/digest' && req\.method === 'POST'/)
})
