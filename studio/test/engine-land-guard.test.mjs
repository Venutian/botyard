/**
 * Nothing lands without its passes (docs/tracks.md): the land step refuses work whose check did not pass, public
 * work with no scored review, and work a ruling said no to. A refusal is a state of the trip with its reason,
 * never a card for the owner. The one way past is a ruling's own "WAIVER:" line, which is kept.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { putDocument } from '../server/engine/write.mjs'
import { BUILD_TRACK, coversReview, landGuard, rerunTrip, saveTrack, startRequest, tickTracks, tripView, waiverIn } from '../server/engine/tracks.mjs'

const OWNER = { user: 'local-board' }
const T0 = Date.parse('2026-11-25T09:00:00Z')
const LAND = 'node "$BOTYARD_TRACK_TOOLS/land.mjs"'

/** Build, check, ruling, scored review (public work only), land. The ruling's pass goes straight to land. */
const GUARDED = {
  key: 'guarded', inputs: ['brief'], optional: ['public_paths'], defaults: { public_paths: 'site/' },
  steps: [
    { id: 'build', kind: 'bot', bot: 'Builder', needs: ['brief'], leaves: ['commit'] },
    { id: 'check', kind: 'bot', bot: 'Checker', needs: ['commit'], leaves: ['verdict'] },
    { id: 'rule', kind: 'bot', bot: 'Judge', ruling: true, leaves: ['verdict'] },
    { id: 'review', kind: 'bot', bot: 'Scorer', onlyFor: 'public', needs: ['commit'], leaves: ['verdict'] },
    { id: 'land', kind: 'script', command: LAND, needs: ['commit'], leaves: ['commit'] },
  ],
  lines: [
    { from: 'build', to: 'check', on: 'pass' }, { from: 'build', to: 'rule', on: 'fail' },
    { from: 'check', to: 'review', on: 'pass' }, { from: 'check', to: 'rule', on: 'fail' },
    { from: 'rule', to: 'land', on: 'pass' }, { from: 'rule', to: 'build', on: 'fail', rounds: 1, then: 'rule' },
    { from: 'review', to: 'land', on: 'pass' }, { from: 'review', to: 'rule', on: 'fail' },
    { from: 'land', to: 'rule', on: 'fail' },
  ],
}

function yard(files) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-land-guard-'))
  const repo = path.join(dataDir, 'repo')
  fs.mkdirSync(repo)
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  for (const [id, name] of [['b1', 'Builder'], ['c1', 'Checker'], ['j1', 'Judge'], ['s1', 'Scorer']]) store.put('agents', { id, companyId: 'co', name, status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Harbour', status: 'in_progress' }, { position: 0 })
  store.put('project_workspaces', { id: 'w1', projectId: 'p1', name: 'main', cwd: repo, isPrimary: true })
  saveTrack(store, 'co', GUARDED, { now: T0, actor: OWNER })
  const landed = []
  const io = {
    startKeeper(specFile) {
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
      landed.push(spec.env.BOTYARD_IN_COMMIT)
      fs.writeFileSync(spec.env.BOTYARD_STEP_OUT, JSON.stringify({ verdict: 'pass', leaves: { commit: spec.env.BOTYARD_IN_COMMIT } }))
      fs.writeFileSync(spec.logFile, '')
      fs.writeFileSync(spec.resultFile, JSON.stringify({ exitCode: 0, timedOut: false }))
      return 1
    },
    alive: () => false, inMain: async () => true, changedFiles: async () => files,
  }
  startRequest(store, 'co', { track: 'guarded', title: 'Harbour lamp', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  let n = 0
  const tick = () => tickTracks(store, { dataDir, io, now: T0 + (n += 1) * 1000 })
  const says = async (stepId, docs) => {
    const tripId = store.row('SELECT id FROM trips').id
    const jobId = store.objects("SELECT raw FROM trip_steps WHERE trip_id = ? AND step_id = ? AND status = 'working'", tripId, stepId)[0]?.jobId
    assert.ok(jobId, `a job is working on "${stepId}"`)
    for (const [key, body] of Object.entries(docs)) putDocument(store, jobId, key, { body }, { now: T0 + n * 1000, actor: { agent: 'x' } })
    store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', jobId), status: 'done' })
    await tick()
  }
  return { store, landed, tick, says, trip: () => tripView(store, store.row('SELECT id FROM trips').id) }
}

test('a trip whose check failed cannot land on a ruling\'s plain PASS: it is refused with the reason, as a state of the trip, and no card is made', async () => {
  const y = yard(['src/lamp.mjs'])
  await y.tick()
  await y.says('build', { commit: 'aaa1111' })
  await y.says('check', { verdict: 'VERDICT: FAIL. The lamp does not light.' })
  await y.says('rule', { verdict: 'VERDICT: PASS. Good enough.' })
  assert.deepEqual(y.landed, [], 'nothing was merged')
  const trip = y.trip()
  assert.equal(trip.refusal.step, 'land')
  assert.equal(trip.refusal.why, 'check')
  assert.match(trip.refusal.reason, /^Not landed: the check failed\. Only a ruling that says "WAIVER: what and why"/)
  assert.match(trip.refusal.reason, /The lamp does not light/)
  const refused = trip.steps.find((s) => s.id === 'land').tries[0]
  assert.equal(refused.snapshot.verdict, 'fail', 'never a silent success')
  assert.equal(refused.snapshot.refused.why, 'check')
  assert.equal(y.store.count('cards'), 0, 'the owner is not asked')
  assert.equal(y.store.rows("SELECT id FROM activity WHERE action = 'trip.land_refused'").length, 1)
  // It goes to the ruling with the reason, not to the owner.
  assert.equal(trip.current, 'rule')
  assert.equal(trip.status, 'running')
  const again = y.store.object('SELECT raw FROM jobs WHERE id = ?', trip.steps.find((s) => s.id === 'rule').latest.jobId)
  assert.match(again.description, /Not landed: the check failed/)
})

test('a waived one can land: the ruling says WAIVER in a line of its own, and the waiver is kept with the trip', async () => {
  const y = yard(['src/lamp.mjs'])
  await y.tick()
  await y.says('build', { commit: 'aaa1111' })
  await y.says('check', { verdict: 'VERDICT: FAIL. The lamp flickers once on start.' })
  await y.says('rule', { verdict: 'VERDICT: PASS\n\nWAIVER: the check; the flicker is in the test rig, not the lamp.' })
  assert.deepEqual(y.landed, ['aaa1111'])
  const trip = y.trip()
  assert.equal(trip.status, 'done')
  assert.equal(trip.refusal ?? null, null)
  assert.equal(trip.waivers.length, 1)
  assert.match(trip.waivers[0].reason, /the flicker is in the test rig/)
  assert.match(trip.waivers[0].waived, /the check failed/)
  assert.equal(trip.waivers[0].step, 'land')
  assert.match(trip.steps.find((s) => s.id === 'land').latest.waiver.reason, /test rig/)
  const noted = y.store.objects("SELECT raw FROM activity WHERE action = 'trip.waived'")
  assert.equal(noted.length, 1)
  assert.match(JSON.stringify(noted[0]), /the flicker is in the test rig/)
})

test('a refused trip lands once the ruling waives it; a ruling that never does leaves the trip stuck with the reason, still without a card', async () => {
  const y = yard(['src/lamp.mjs'])
  await y.tick()
  await y.says('build', { commit: 'aaa1111' })
  await y.says('check', { verdict: 'FAIL: wrong colour' })
  await y.says('rule', { verdict: 'PASS' })
  await y.says('rule', { verdict: 'PASS\nWAIVER: the check, the colour is as the brief says' })
  assert.deepEqual(y.landed, ['aaa1111'])
  assert.equal(y.trip().waivers.length, 1)

  const z = yard(['src/lamp.mjs'])
  await z.tick()
  await z.says('build', { commit: 'aaa1111' })
  await z.says('check', { verdict: 'FAIL: wrong colour' })
  for (let round = 0; round < 5; round++) await z.says('rule', { verdict: 'PASS' })
  assert.deepEqual(z.landed, [])
  assert.equal(z.trip().status, 'stuck')
  assert.match(z.trip().reason, /Not landed: the check failed.*"rule" was already tried 5 times/)
  assert.equal(z.store.count('cards'), 0)
})

test('a public trip without a review row cannot land: the review starts by itself, with no click, and its pass is what lands it', async () => {
  const y = yard(['site/index.html'])
  await y.tick()
  await y.says('build', { commit: 'aaa1111' })
  await y.says('check', { verdict: 'FAIL: the footer link is dead' })
  // The ruling waives the check and sends it to land, past the review step.
  await y.says('rule', { verdict: 'PASS\nWAIVER: the check, the dead link is on a page that is going away' })
  assert.deepEqual(y.landed, [], 'not merged: the public will see it and nobody scored it')
  let trip = y.trip()
  assert.equal(trip.refusal.why, 'review-missing')
  assert.match(trip.refusal.reason, /it changes site\/index\.html.*no scored review/)
  assert.equal(trip.current, 'review')
  const review = y.store.object('SELECT raw FROM jobs WHERE id = ?', trip.steps.find((s) => s.id === 'review').latest.jobId)
  assert.equal(review.assigneeAgentId, 's1', 'the reviewer has the job')
  assert.equal(review.status, 'todo')
  assert.equal(y.store.rows("SELECT id FROM wakes WHERE agent_id = 's1' AND status = 'queued'").length, 1, 'and is woken for it')
  assert.equal(y.store.count('cards'), 0)
  assert.equal(y.store.count('reviews'), 0)
  await y.says('review', { verdict: 'VERDICT: PASS' })
  assert.deepEqual(y.landed, ['aaa1111'])
  trip = y.trip()
  assert.equal(trip.status, 'done')
  assert.equal(y.store.objects('SELECT raw FROM reviews')[0].verdict, 'pass')
  assert.match(trip.waivers[0].waived, /the check failed/)
})

test('a score that is not kept in the reviews table does not count, and a failed score is not covered by a waiver that does not name the review', async () => {
  const y = yard(['site/index.html'])
  await y.tick()
  await y.says('build', { commit: 'aaa1111' })
  await y.says('check', { verdict: 'PASS' })
  await y.says('review', { verdict: 'PASS' })
  assert.deepEqual(y.landed, ['aaa1111'])
  // The same trip, run again from land with the owner's note and its review row gone: a note is not a waiver.
  const tripId = y.store.row('SELECT id FROM trips').id
  y.store.db.exec('DELETE FROM reviews')
  rerunTrip(y.store, tripId, { step: 'land', note: 'Land it, I looked at it myself' }, { now: T0 + 60_000, actor: OWNER })
  await y.tick()
  assert.equal(y.landed.length, 1, 'not merged again')
  assert.equal(y.trip().refusal.why, 'review-missing')

  const z = yard(['site/index.html'])
  await z.tick()
  await z.says('build', { commit: 'bbb2222' })
  await z.says('check', { verdict: 'PASS' })
  await z.says('review', { verdict: 'FAIL: the hero is blurry' })
  await z.says('rule', { verdict: 'PASS\nWAIVER: the check is fine as it is' })
  // The failed score went stale with the ruling: nothing scored stands, so the review runs again by itself.
  assert.deepEqual(z.landed, [])
  assert.equal(z.trip().current, 'review')
  await z.says('review', { verdict: 'FAIL: the hero is still blurry' })
  // A ruling that waives the review by name lands it, and says what it waived.
  await z.says('rule', { verdict: 'PASS\nWAIVER: the review. The blur is the brand look; the owner signed it off in the brief.' })
  assert.deepEqual(z.landed, ['bbb2222'])
  assert.match(z.trip().waivers[0].waived, /the scored review did not run/)
  assert.equal(z.store.objects('SELECT raw FROM reviews').filter((r) => r.verdict === 'pass').length, 0)
})

test('a ruling that said no is never landed, whatever is run again; only the land step is guarded', async () => {
  const store = openStore(':memory:')
  const version = { main: 'main', steps: [{ id: 'check', kind: 'bot', leaves: ['verdict'] }, { id: 'rule', kind: 'bot', ruling: true, leaves: ['verdict'] }, { id: 'land', kind: 'script', command: LAND }] }
  const put = (id, stepId, status, at, snapshot = {}) => store.put('trip_steps', { id, tripId: 't1', requestId: 'r1', stepId, kind: 'bot', title: stepId, try: 1, status, snapshot: { verdict: status === 'passed' ? 'pass' : 'fail', findings: 'row 2 is wrong', ...snapshot }, createdAt: at, finishedAt: at })
  const io = { changedFiles: async () => ['src/a.mjs'] }
  const guard = () => landGuard(store, { id: 't1' }, { companyId: 'co' }, version, version.steps[2], { public_paths: 'site/', commit: 'aaa1111', repo: '/r' }, io)
  put('a', 'check', 'passed', '2026-11-25T10:00:00Z')
  assert.equal((await guard()).refusal, '')
  put('b', 'rule', 'failed', '2026-11-25T11:00:00Z')
  assert.match((await guard()).refusal, /^Not landed: the ruling said no/)
  put('b', 'rule', 'failed', '2026-11-25T11:00:00Z', { verdict: 'stop' })
  assert.match((await guard()).refusal, /the ruling said STOP/)
  // ASK OWNER is a no until the owner's yes at the gate; with it, the ruling's waiver counts.
  put('a', 'check', 'failed', '2026-11-25T10:00:00Z')
  put('b', 'rule', 'failed', '2026-11-25T11:00:00Z', { verdict: 'ask', waiver: 'the check, if the owner agrees' })
  assert.match((await guard()).refusal, /asked the owner, who has not said yes/)
  store.put('trip_steps', { id: 'g', tripId: 't1', requestId: 'r1', stepId: 'owner', kind: 'gate', title: 'Owner', try: 1, status: 'passed', snapshot: { verdict: 'pass' }, createdAt: '2026-11-25T12:00:00Z', finishedAt: '2026-11-25T12:00:00Z' })
  const yes = await guard()
  assert.equal(yes.refusal, '')
  assert.equal(yes.waiver.ownerYes, true)
  // A step that is not the land tool is not guarded.
  assert.deepEqual(await landGuard(store, { id: 't1' }, {}, version, { id: 'x', kind: 'script', command: 'echo' }, {}, io), { refusal: '' })
})

test('a waiver is read from a line of its own, and covers the review only when it names it; the built-in ruling is told so', () => {
  assert.equal(waiverIn('VERDICT: PASS\nWAIVER: the check; a flaky rig'), 'the check; a flaky rig')
  assert.equal(waiverIn('**Waiver:** the review, brand look'), 'the review, brand look')
  assert.equal(waiverIn('PASS. I would not call this a waiver of anything.'), '')
  assert.equal(coversReview('the check; a flaky rig'), false)
  assert.equal(coversReview('I reviewed it and the check is fine'), false)
  assert.equal(coversReview('the review, brand look'), true)
  assert.match(BUILD_TRACK.steps.find((s) => s.id === 'rule').words, /add a line WAIVER: what you waive \(the check, the review, or both\) and why/)
})
