// The Improvements page: one plain file the crew's audit writes, one read-only view, the same list on the PC and the phone.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { improvementsView } from '../server/lib/crew.mjs'
import http from 'node:http'
import { decidedLine, historyLine, improvementsScreen, recordClick, toggleRecord } from '../src/ui/studio-crew.js'
import { decideImprovement } from '../server/lib/improvement-actions.mjs'
import * as phoneText from '../../src/improvementText.ts'

const folderWith = (content) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'improvements-'))
  if (content !== undefined) fs.writeFileSync(path.join(folder, 'improvements.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return folder
}
const ITEMS = [
  { id: 'IMP-1', title: 'Old briefs stay', path: 'briefs', evidence: '212 files', fix: 'Move them', who: 'Checker', status: 'done', job: 'LH-955', added: 100 },
  { id: 'IMP-2', title: 'Reports <b>name</b> no commit', path: 'crew/review-guard.py', evidence: 'LH-931', fix: 'Refuse it', who: 'Lead', status: 'new', job: '', added: 200 },
  { id: 'IMP-3', title: 'Second new one', path: 'x', evidence: '', fix: '', who: 'Checker', status: 'new', job: '', added: 300 },
  { id: 'IMP-4', title: 'Not worth it', path: 'y', status: 'rejected', added: 50 },
  { id: 'IMP-5', title: 'Odd state', path: 'z', status: 'sideways', added: 10 },
  { title: '' },
  'junk',
]

test('the view lists findings by state then newest, counts each state, and unknown states read as new', () => {
  const view = improvementsView({ folder: folderWith(ITEMS) })
  assert.deepEqual(view.items.map((i) => i.id), ['IMP-3', 'IMP-2', 'IMP-5', 'IMP-1', 'IMP-4'])
  assert.deepEqual(view.counts, { new: 3, ask: 0, accepted: 0, done: 1, rejected: 1, stale: 0 })
  assert.deepEqual(Object.keys(view.items[0]).sort(), ['added', 'decidedAt', 'decidedBy', 'evidence', 'fix', 'history', 'id', 'job', 'path', 'reason', 'status', 'title', 'who'])
})

test('a decision by any bot name is the lead\'s, so the page can name the yard\'s own lead', () => {
  const view = improvementsView({ folder: folderWith([{ id: 'IMP-1', title: 't', status: 'accepted', decidedBy: 'Foreman', decidedAt: 1, history: [{ by: 'someone', status: 'ask', at: 1 }, { by: 'owner', status: 'new', at: 2 }] }]), lead: 'Foreman' })
  assert.equal(view.items[0].decidedBy, 'lead')
  assert.deepEqual(view.items[0].history.map((h) => h.by), ['lead', 'owner'])
  assert.equal(view.lead, 'Foreman')
})

test('a missing, empty or broken file is an empty list, never an error', () => {
  for (const folder of [folderWith(), folderWith('{not json'), folderWith({ not: 'a list' })]) {
    assert.deepEqual(improvementsView({ folder }), { items: [], counts: { new: 0, ask: 0, accepted: 0, done: 0, rejected: 0, stale: 0 }, lead: '' })
  }
})

const T16 = Date.UTC(2026, 10, 16, 12) / 1000
const T17 = Date.UTC(2026, 10, 17, 12) / 1000
const FINDINGS = [
  { id: 'IMP-1', title: 'Old briefs stay', path: 'briefs', evidence: '212 files', fix: 'Move them', who: 'Checker', status: 'rejected', job: '', added: 1, decidedBy: 'lead', decidedAt: T16, reason: 'We already do this in a long reason that must never be cut short, however many words it takes to say it in full.' },
  { id: 'IMP-2', title: 'Reports name no commit', path: 'crew/review-guard.py', evidence: 'LH-931', fix: 'Refuse it', who: 'Lead', status: 'new', job: '', added: 2, project: 'Workshop' },
  { id: 'IMP-3', title: 'Asked one', path: 'a', evidence: 'e', fix: 'f', who: 'Lead', status: 'ask', job: 'WRK-1190', added: 3, decidedBy: 'lead', decidedAt: T16, reason: 'Needs you.' },
]

test('the PC page shows status chip, who decided and when, the full reason, the job link, evidence, and the four buttons', () => {
  const data = improvementsView({ folder: folderWith(FINDINGS), lead: 'Foreman' })
  const all = improvementsScreen(data, '')
  assert.ok(all.includes('chip imp-rejected">Rejected') && all.includes('chip imp-new">New') && all.includes('chip imp-ask">Ask me'))
  assert.ok(all.includes('Decided by Foreman, 16 Nov.') && all.includes('>Send to Foreman<') && all.includes('<dt>Why</dt><dd>We already do this in a long reason that must never be cut short, however many words it takes to say it in full.</dd>'))
  assert.ok(all.includes('data-act="open-job" data-id="WRK-1190"') && all.includes('<dt>Evidence</dt><dd>212 files</dd>') && all.includes('No job yet'))
  for (const act of ['improve-accept', 'improve-reject-open', 'improve-ask', 'improve-send', 'improve-reject-go']) assert.ok(all.includes(`data-act="${act}"`), act)
  assert.ok(all.includes('aria-label="Accept finding IMP-2: Reports name no commit"') && all.includes('<label for="why-IMP-2">'))
  assert.ok(!all.includes('…'), 'the reason is never truncated')
})

test('a finding leads with its state and title, labels its facts, and keeps its notes behind Details', () => {
  const data = improvementsView({ folder: folderWith(FINDINGS), lead: 'Foreman' })
  const all = improvementsScreen(data, '')
  assert.match(all, /<b>2 waiting for you\.<\/b>/)
  assert.match(all, /<dt>Found by<\/dt><dd>Checker<\/dd>/)
  assert.match(all, /<dt>Decision<\/dt><dd><span class="rec-wait">Waiting for you<\/span>/, 'a new finding says it waits for the owner')
  assert.match(all, /<dt>Job<\/dt><dd><button type="button" class="link" data-act="open-job" data-id="WRK-1190">WRK-1190<\/button>/)
  assert.match(all, /<button type="button" class="rec-toggle" data-act="rec-toggle" aria-expanded="false" aria-controls="imp-more-IMP-1">Details/)
  assert.match(all, /<div class="rec-detail" id="imp-more-IMP-1" hidden>/)
  // A finding that waits for the owner carries its four buttons on its face; a decided one keeps them behind Details.
  const face = (id) => all.slice(all.indexOf(`data-finding="${id}"`), all.indexOf(`id="imp-more-${id}"`))
  assert.match(face('IMP-2'), /data-act="improve-accept"/)
  assert.doesNotMatch(face('IMP-1'), /data-act="improve-accept"/)
  assert.match(all.slice(all.indexOf('id="imp-more-IMP-1"')), /Change your decision/)
  assert.match(all, /<div class="imp-reject" hidden>/)
  assert.doesNotMatch(all, /<table/, 'no table, so nothing scrolls sideways')
  assert.match(improvementsScreen({ items: [{ id: 'IMP-1', title: 'x', status: 'done' }], counts: { done: 1 }, lead: 'Foreman' }, ''), /<b>Nothing waits for you\.<\/b>/)
})

test('the page opens on what waits for a decision (New and Ask me), and every filter works', () => {
  const data = improvementsView({ folder: folderWith(FINDINGS) })
  const open = improvementsScreen(data)
  assert.ok(open.includes('Reports name no commit') && open.includes('Asked one') && !open.includes('Old briefs stay'))
  for (const name of ['To decide <span>2', 'All <span>3', 'New <span>1', 'Ask me <span>1', 'Accepted <span>0', 'Done <span>0', 'Rejected <span>1', 'Stale <span>0']) assert.ok(open.includes(name), name)
  assert.ok(improvementsScreen(data, 'rejected').includes('Old briefs stay'))
  assert.ok(improvementsScreen(data, 'done').includes('Nothing in this state.'))
  assert.ok(improvementsScreen({ items: [], counts: {} }, '').includes('No improvements listed yet.'))
  assert.ok(improvementsScreen({ items: [{ id: 'IMP-9', title: '<i>x</i>', status: 'new' }], counts: { new: 1 } }, 'open').includes('&lt;i&gt;x&lt;/i&gt;'))
})

test('the change history reads in one line, on the PC page and in the phone screen words', () => {
  const item = { status: 'accepted', decidedBy: 'owner', decidedAt: T17, history: [{ by: 'lead', status: 'rejected', at: T16 }] }
  assert.equal(historyLine(item, 'Foreman'), 'Foreman rejected 16 Nov; you accepted 17 Nov')
  assert.equal(phoneText.historyLine(item, 'Foreman'), 'Foreman rejected 16 Nov; you accepted 17 Nov')
  assert.equal(historyLine(item), 'The lead rejected 16 Nov; you accepted 17 Nov', 'a yard whose lead is unknown says "the lead"')
  assert.equal(decidedLine(item), 'Decided by you, 17 Nov')
  assert.equal(phoneText.decidedLine(item), 'Decided by you, 17 Nov')
  assert.equal(historyLine({ status: 'new' }), '')
  assert.equal(phoneText.historyLine({ status: 'rejected', decidedBy: 'lead', decidedAt: T16 }), '')
  assert.equal(phoneText.STATUS_NAMES.ask, 'Ask me')
})

// ── the buttons ────────────────────────────────────────────────────────────────────────

/** A fake engine that records what it was asked: two projects, a lead and a builder. */
function fakeEngine() {
  const calls = []
  const fetcher = async (url, init) => {
    const where = String(url).replace(/^.*\/api/, '').replace(/^\/companies\/[^/]+/, '/companies/c1')
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ where, method: init?.method, body })
    const answer = (value, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(value) })
    if (where === '/companies') return answer([{ id: 'c1', status: 'active' }])
    if (where === '/companies/c1/projects') return answer([{ id: 'p-yard', name: 'Yard' }, { id: 'p-studio', name: 'Workshop' }])
    if (where === '/companies/c1/agents') return answer([{ id: 'a-lead', name: 'Foreman', role: 'ceo' }, { id: 'a-build', name: 'Builder', reportsTo: 'a-lead' }])
    if (where === '/companies/c1/issues' && init.method === 'POST') return answer({ id: 'i1', identifier: 'YRD-77', displayIdentifier: 'WRK-77' })
    return answer({ error: `unexpected ${init?.method} ${where}` }, false)
  }
  return { calls, engine: { fetcher } }
}
const read = (folder, name) => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
const yardOf = () => { const folder = folderWith(JSON.parse(JSON.stringify(FINDINGS))); return folder }

test('Accept makes a backlog job in the finding\'s project with the fix as the outline, and records the owner\'s decision', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'accept' }, { folder, engine, now: T17 })
  assert.equal(done.jobRef, 'WRK-77')
  const issue = calls.find((c) => c.where === '/companies/c1/issues').body
  assert.equal(issue.projectId, 'p-studio')
  assert.ok(issue.description.includes('Smallest fix: Refuse it') && issue.description.includes('Brief outline: Refuse it'))
  const item = read(folder, 'improvements.json').find((i) => i.id === 'IMP-2')
  assert.deepEqual([item.status, item.decidedBy, item.decidedAt, item.job], ['accepted', 'owner', T17, 'WRK-77'])
})

test('a finding that names no project makes a job with no project', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  await decideImprovement('IMP-3', { action: 'accept' }, { folder, engine, now: T17 })
  assert.equal(calls.find((c) => c.where === '/companies/c1/issues').body.projectId, undefined)
})

test('Reject needs a reason, remembers the title, and creates no job', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'reject', reason: '  ' }, { folder, engine }), /why you reject/)
  assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
  const done = await decideImprovement('IMP-2', { action: 'reject', reason: 'Not worth\nthe work' }, { folder, engine, now: T17 })
  assert.equal(done.item.reason, 'Not worth the work')
  assert.deepEqual(read(folder, 'improvements-rejected.json').titles, ['reports name no commit'])
  assert.equal(calls.length, 0)
})

test('Ask me changes the status and creates nothing', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'ask' }, { folder, engine, now: T17 })
  assert.deepEqual([done.item.status, done.item.decidedBy], ['ask', 'owner'])
  assert.equal(calls.length, 0)
})

test('Send to the lead makes a job assigned to the crew\'s lead in the finding\'s project, with evidence, fix and the instruction to plan and start', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'send' }, { folder, engine, now: T17 })
  const issue = calls.find((c) => c.where === '/companies/c1/issues').body
  assert.equal(issue.assigneeAgentId, 'a-lead')
  assert.equal(issue.projectId, 'p-studio')
  assert.ok(issue.description.includes('Evidence: LH-931') && issue.description.includes('Plan this and start it.'))
  assert.equal(done.item.job, 'WRK-77')
})

test('the owner overrides the lead\'s decision, and the history keeps both, in one line', async () => {
  const folder = yardOf(); const { engine } = fakeEngine()
  await decideImprovement('IMP-1', { action: 'accept' }, { folder, engine, now: T17 })
  const view = improvementsView({ folder }).items.find((i) => i.id === 'IMP-1')
  assert.deepEqual([view.status, view.decidedBy], ['accepted', 'owner'])
  assert.equal(historyLine(view, 'Foreman'), 'Foreman rejected 16 Nov; you accepted 17 Nov')
  // A second click changes it again, and nothing is lost.
  await decideImprovement('IMP-1', { action: 'ask' }, { folder, engine, now: T17 + 60 })
  const again = improvementsView({ folder }).items.find((i) => i.id === 'IMP-1')
  assert.equal(again.status, 'ask')
  assert.equal(again.history.length, 2)
  assert.equal(read(folder, 'improvements.json').length, 3)
})

test('a bad action, an unknown finding or a missing engine changes nothing', async () => {
  const folder = yardOf()
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'delete' }, { folder }), /accept, reject, ask or send/)
  await assert.rejects(() => decideImprovement('IMP-99', { action: 'ask' }, { folder }), /No such finding/)
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'accept' }, { folder, engine: { fetcher: async () => { throw new Error('down') } } }), /not running/)
  assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
})

test('through the map\'s API: the page decides, any other caller is refused', async () => {
  const folder = yardOf()
  const saved = process.env.BOTYARD_CREW_FOLDER
  process.env.BOTYARD_CREW_FOLDER = folder
  try {
    const { apiMiddleware } = await import(`../server/api.mjs?improve-${Date.now()}`)
    const server = http.createServer((req, res) => apiMiddleware(req, res, null))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/api/studio/improvements/IMP-2`
    const post = (headers, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    try {
      const mine = { Origin: `http://localhost:${port}` }
      assert.equal((await post({ Origin: 'https://elsewhere.example' }, { action: 'ask' })).status, 403)
      assert.equal((await post({}, { action: 'ask' })).status, 403)
      assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
      const noReason = await post(mine, { action: 'reject' })
      assert.equal(noReason.status, 400)
      const rejected = await post(mine, { action: 'reject', reason: 'No' })
      assert.equal(rejected.status, 200)
      const list = await (await fetch(`http://127.0.0.1:${port}/api/studio/improvements`)).json()
      const item = list.items.find((i) => i.id === 'IMP-2')
      assert.deepEqual([item.status, item.decidedBy, item.reason], ['rejected', 'owner', 'No'])
      assert.equal((await post(mine, { action: 'nope' })).status, 400)
    } finally { server.close() }
  } finally { if (saved === undefined) delete process.env.BOTYARD_CREW_FOLDER; else process.env.BOTYARD_CREW_FOLDER = saved }
})

/** Just enough of a record's elements to open and close it without a browser. */
function fakeRecord() {
  const classes = new Set(['rec'])
  const panel = { hidden: true }
  const chev = { innerHTML: '' }
  const attrs = { 'aria-expanded': 'false' }
  const button = { firstChild: { textContent: 'Details' }, setAttribute: (k, v) => { attrs[k] = v }, querySelector: () => chev }
  const row = { classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }, querySelector: (sel) => (sel === '.rec-detail' ? panel : sel === '.rec-toggle' ? button : null) }
  button.closest = () => row
  const plain = { closest: (sel) => (sel === '.rec' ? row : null) }
  return { row, panel, button, attrs, classes, plain }
}

test('Details opens a record in place and says so; a click on its face opens it, a click on a button does not', () => {
  const r = fakeRecord()
  toggleRecord(r.button)
  assert.equal(r.panel.hidden, false)
  assert.equal(r.attrs['aria-expanded'], 'true')
  assert.equal(r.button.firstChild.textContent, 'Hide details')
  assert.ok(r.classes.has('open'))
  toggleRecord(r.button)
  assert.deepEqual([r.panel.hidden, r.attrs['aria-expanded'], r.button.firstChild.textContent, r.classes.has('open')], [true, 'false', 'Details', false])
  const s = fakeRecord()
  assert.equal(recordClick(s.plain), true)
  assert.equal(s.panel.hidden, false)
  assert.equal(recordClick(s.plain), false, 'an open record is not closed by a click on its text')
  const t = fakeRecord()
  assert.equal(recordClick({ closest: (sel) => (sel === '.rec' ? t.row : { tag: 'button' }) }), false)
  assert.equal(t.panel.hidden, true)
})
