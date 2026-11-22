/** Tracks on the page and the phone: the server's views of tracks and trips, the owner's hand at a gate, and the drawn screens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { answer } from '../server/engine/api.mjs'
import { BUILD_TRACK, saveTrack, startRequest, tickTracks } from '../server/engine/tracks.mjs'
import { dollars, tracksPage, tripAct, tripPage } from '../server/lib/tracks.mjs'
import { trackDiagram, tracksScreen, tripScreen } from '../src/ui/studio-tracks.js'

const OWNER = { user: 'local-board' }

/** The page's own calls answered by a real engine store in this process. */
function yard() {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0, status: 'active' })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-page-'))
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    const out = answer(store, { method: init.method || 'GET', url: u.pathname + u.search, headers: {}, body: init.body ? JSON.parse(init.body) : {} }, { dataDir, actor: OWNER })
    return new Response(JSON.stringify(out.body), { status: out.status })
  }
  const io = { startKeeper(specFile) { const spec = JSON.parse(fs.readFileSync(specFile, 'utf8')); fs.writeFileSync(spec.env.BOTYARD_STEP_OUT, JSON.stringify({ leaves: { text: `draft ${spec.env.BOTYARD_IN_NOTE || ''}`.trim() } })); fs.writeFileSync(spec.logFile, ''); fs.writeFileSync(spec.resultFile, JSON.stringify({ exitCode: 0 })); return 1 }, alive: () => false, inMain: async () => true }
  return { store, dataDir, fetcher, tick: () => tickTracks(store, { dataDir, io }) }
}

test('money reads as dollars to the cent', () => {
  assert.equal(dollars(0), '$0')
  assert.equal(dollars(0.004), '<$0.01')
  assert.equal(dollars(1.239), '$1.24')
})

test('the owner sees a trip waiting at a gate, sends it back with a note, adds context, and approves it, through the page\'s own calls', async () => {
  const { store, fetcher, tick } = yard()
  saveTrack(store, 'co', {
    key: 'write', delivers: 'nothing',
    steps: [{ id: 'draft', kind: 'script', title: 'Draft', command: 'draft', leaves: ['text'] }, { id: 'look', kind: 'gate', title: 'You look', needs: ['text'] }],
    lines: [{ from: 'draft', to: 'look', on: 'always' }],
  }, { actor: OWNER })
  startRequest(store, 'co', { track: 'write', title: 'A page' }, { actor: OWNER })
  await tick()
  const page = await tracksPage({ fetcher })
  assert.deepEqual(page.tracks.map((t) => t.key).sort(), ['build-check-land', 'release-app', 'sample-check', 'write'])
  const row = page.requests[0]
  assert.equal(row.waitsForOwner, true)
  assert.equal(row.cost, '$0')
  let trip = await tripPage(row.tripId, { fetcher })
  assert.equal(trip.gate.step, 'look')
  assert.deepEqual(trip.gate.backTo.map((s) => s.id), ['draft'])
  assert.equal(trip.steps[0].left.text, 'draft')
  await assert.rejects(tripAct(row.tripId, { action: 'back', to: 'draft' }, { fetcher }), /a note goes with the work/)
  await assert.rejects(tripAct(row.tripId, { action: 'jump' }, { fetcher }), /A trip can be/)
  trip = await tripAct(row.tripId, { action: 'back', to: 'draft', note: 'shorter' }, { fetcher })
  assert.equal(trip.current, 'draft')
  await tick()
  trip = await tripPage(row.tripId, { fetcher })
  assert.equal(trip.steps[0].left.text, 'draft shorter')
  assert.equal(trip.steps[0].tries, 2)
  trip = await tripAct(row.tripId, { action: 'context', note: 'warmer' }, { fetcher })
  await tick()
  assert.equal((await tripPage(row.tripId, { fetcher })).steps[0].left.text, 'draft warmer')
  trip = await tripAct(row.tripId, { action: 'approve' }, { fetcher })
  await tick()
  trip = await tripPage(row.tripId, { fetcher })
  assert.equal(trip.status, 'done')
  assert.equal(trip.gate, null)
  // Run again from the first step with a note: the trip opens again.
  trip = await tripAct(row.tripId, { action: 'rerun', step: 'draft', note: 'once more' }, { fetcher })
  assert.equal(trip.status, 'running')
})

test('the screens draw a track, list what waits for the owner, and give the gate its three answers', () => {
  const svg = trackDiagram(BUILD_TRACK.steps, BUILD_TRACK.lines, { states: { build: 'failed', check: 'working' }, current: 'check' })
  assert.match(svg, /<svg class="track-diagram"/)
  assert.equal((svg.match(/<g class="step/g) || []).length, BUILD_TRACK.steps.length)
  assert.match(svg, /×2/, 'a back-line shows its rounds')
  assert.match(svg, /class="step k-bot s-working now"/)
  assert.match(svg, /aria-label="Track: Brief check, then Write the brief/)
  const list = tracksScreen({ tracks: [{ key: 'crew', title: 'Crew', version: 2, steps: BUILD_TRACK.steps, lines: BUILD_TRACK.lines, delivers: 'change' }], requests: [{ id: 'r', tripId: 't1', job: 'LH-4', title: 'Add a lamp', track: 'crew', status: 'working', state: 'Moving', at: 'You look', waitsForOwner: true, cost: '$1.20', tripStatus: 'running' }] })
  assert.match(list, /1 waits for you/)
  assert.match(list, /data-act="open-trip" data-id="t1"/)
  assert.match(list, /\$1\.20/)
  const trip = tripScreen({
    status: 'running', state: 'Moving', current: 'look', reason: '', commit: '', track: { key: 'write', version: 1, title: 'Write', main: 'main' }, lines: [{ from: 'draft', to: 'look', on: 'always' }],
    request: { job: 'LH-4', cost: '$0.50', title: 'A page' }, cost: '$0.50',
    steps: [
      { id: 'draft', kind: 'script', title: 'Draft', state: 'passed', tries: 2, current: false, leftNames: ['text'], left: { text: 'x' }, numbers: {}, note: 'shorter', summary: 'ok', findings: '', handedFindings: '', costUsd: 0, cost: '$0' },
      { id: 'look', kind: 'gate', title: 'You look', state: 'working', tries: 1, current: true, leftNames: [], left: {}, numbers: {}, note: '', summary: '', findings: '', handedFindings: '', costUsd: 0, cost: '$0' },
    ],
    gate: { step: 'look', title: 'You look', backTo: [{ id: 'draft', title: 'Draft' }] }, can: { pause: true, resume: false, stop: true, rerun: ['draft', 'look'] },
  })
  for (const act of ['approve', 'context', 'back']) assert.match(trip, new RegExp(`data-act="trip-gate" data-do="${act}"`))
  assert.match(trip, /Send back to <select name="to"><option value="draft" selected>Draft/)
  assert.match(trip, /round 2/)
  assert.match(trip, /Your note:<\/b> shorter/)
  assert.match(trip, /\$0\.50 for the request/)
})

test('a request waiting at its gate says so on its job page, names who has it and opens its trip; never "Working, nobody yet"', async () => {
  const { jobScreen } = await import('../src/ui/studio-work.js')
  const job = { id: 'j', ref: 'WEB-1', status: 'in_progress', priority: 'medium', bot: '', children: [], documents: [], files: [], products: [], runs: [], comments: [], said: [] }
  const line = { track: { tripId: 't1' }, pill: 'waits', stage: 'queued', bot: '', note: 'Waiting for you: the owner decides, $12.72 so far', steps: ['done', 'wait', 'wait', 'wait', 'wait'] }
  const page = jobScreen(job, { line, steps: ['Build', 'Check', 'Final check', 'Merge', 'Push'] })
  assert.match(page, /Waits for you/)
  assert.match(page, /data-act="open-trip" data-id="t1"/)
  assert.doesNotMatch(page, /Nobody yet|>Working</)
  const building = jobScreen(job, { line: { ...line, pill: 'build', stage: 'build', bot: 'Atlas', note: 'Atlas is building it, on its track' }, steps: ['Build', 'Check', 'Final check', 'Merge', 'Push'] })
  assert.match(building, /On its track/)
  assert.match(building, /Atlas/)
})
