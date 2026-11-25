/** Tracks in Botyard's engine (docs/tracks.md): saved as data, run step by step, back-lines with rounds, gates, snapshots, rerun, and "finished means in main". */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { putDocument } from '../server/engine/write.mjs'
import {
  BUILD_TRACK, SAMPLE_TRACK, answerGate, checkTrack, getRequest, pauseTrip, rerunTrip, resumeTrip, saveTrack, startRequest, stopTrip, tickTracks, trackIo, tripView, verdictOf,
} from '../server/engine/tracks.mjs'

const OWNER = { user: 'local-board' }
const T0 = Date.parse('2026-11-18T12:00:00Z')

function yard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-tracks-'))
  const repo = path.join(dataDir, 'repo')
  fs.mkdirSync(repo)
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  for (const [id, name] of [['b1', 'Builder'], ['c1', 'Checker'], ['j1', 'Judge']]) store.put('agents', { id, companyId: 'co', name, status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Harbour', status: 'in_progress' }, { position: 0 })
  store.put('project_workspaces', { id: 'w1', projectId: 'p1', name: 'main', cwd: repo, isPrimary: true })
  return { store, dataDir, repo }
}

/** A stand-in for the outside world: scripts answer from a table, git answers from a flag. */
function fakeIo(scripts = {}, { inMain = async () => true } = {}) {
  const ran = []
  return {
    ran,
    startKeeper(specFile) {
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
      const line = spec.args.at(-1)
      ran.push({ line, env: spec.env, cwd: spec.cwd })
      const act = scripts[line]
      if (!act) throw new Error(`no fake for ${line}`)
      const { exitCode = 0, out = null, stdout = '' } = act(spec) || {}
      if (out) fs.writeFileSync(spec.env.BOTYARD_STEP_OUT, JSON.stringify(out))
      fs.writeFileSync(spec.logFile, stdout ? `${JSON.stringify({ stream: 'stdout', chunk: stdout })}\n` : '')
      fs.writeFileSync(spec.resultFile, JSON.stringify({ exitCode, timedOut: false }))
      return 1
    },
    alive: () => false,
    inMain,
  }
}

/** A bot finishing its step's job: documents it leaves, then the job is done. */
function botDoes(store, jobId, docs, now) {
  for (const [key, body] of Object.entries(docs)) putDocument(store, jobId, key, { body }, { now, actor: { agent: 'x' } })
  const job = store.object('SELECT raw FROM jobs WHERE id = ?', jobId)
  store.put('jobs', { ...job, status: 'done' })
}
const workingJob = (store, tripId, stepId) => store.objects("SELECT raw FROM trip_steps WHERE trip_id = ? AND step_id = ? AND status = 'working'", tripId, stepId)[0]?.jobId

const CREW = {
  key: 'crew', title: 'Build, check, land', inputs: ['brief'],
  steps: [
    { id: 'build', kind: 'bot', bot: 'Builder', words: 'Build what the brief asks.', needs: ['brief'], leaves: ['commit'] },
    { id: 'tests', kind: 'script', command: 'run tests', needs: ['commit'], leaves: ['tests'] },
    { id: 'check', kind: 'bot', bot: 'Checker', words: 'Check the build against the brief.', needs: ['brief', 'commit'], leaves: ['verdict'] },
    { id: 'decide', kind: 'gate', title: 'Owner decides' },
    { id: 'land', kind: 'script', command: 'land it', needs: ['commit'], leaves: ['commit'] },
  ],
  lines: [
    { from: 'build', to: 'tests', on: 'pass' }, { from: 'build', to: 'decide', on: 'fail' },
    { from: 'tests', to: 'check', on: 'pass' }, { from: 'tests', to: 'build', on: 'fail', rounds: 2, then: 'decide' },
    { from: 'check', to: 'land', on: 'pass' }, { from: 'check', to: 'build', on: 'fail', rounds: 2, then: 'decide' },
    { from: 'decide', to: 'land', on: 'pass' },
    { from: 'land', to: 'decide', on: 'fail' },
  ],
}

test('a track is refused unless every rule holds', () => {
  const ok = checkTrack(CREW, { selfKey: 'crew' })
  assert.equal(ok.steps.length, 5)
  assert.equal(ok.delivers, 'change')
  const bad = (change, why) => assert.throws(() => checkTrack(change(structuredClone(CREW)), { selfKey: 'crew' }), (err) => why.test(err.message), why)
  bad((t) => { t.lines = t.lines.filter((l) => !(l.from === 'land' && l.on === 'fail')); return t }, /"land" can fail and has nothing after a fail/)
  bad((t) => { delete t.lines.find((l) => l.from === 'check' && l.on === 'fail').rounds; return t }, /needs its rounds/)
  bad((t) => { delete t.lines.find((l) => l.from === 'check' && l.on === 'fail').then; return t }, /needs a "then"/)
  bad((t) => { t.lines.find((l) => l.from === 'check' && l.on === 'fail').then = 'tests'; return t }, /a gate or a ruling step/)
  bad((t) => { t.steps[2].needs.push('plan'); return t }, /needs "plan", which no earlier step leaves/)
  bad((t) => { t.lines.push({ from: 'build', to: 'check', on: 'pass' }); return t }, /two ways on for a pass/)
  bad((t) => { t.lines.push({ from: 'land', to: 'build', on: 'pass' }); return t }, /A pass goes forward/)
  bad((t) => { t.steps.push({ id: 'lost', kind: 'gate' }); return t }, /No line reaches "lost"/)
  bad((t) => { t.steps.push({ id: 'twice', kind: 'track', track: 'crew' }); return t }, /cannot run the track it is in/)
  bad((t) => { t.steps.push({ id: 'other', kind: 'track', track: 'nowhere' }); return t }, /not saved here/)
  bad((t) => { t.steps[0].id = 'Build Step'; return t }, /needs an id/)
  bad((t) => { t.steps[1].kind = 'robot'; return t }, /one of: bot, script, gate, track/)
  // A ruling step may take the work when the rounds are used.
  const ruled = structuredClone(CREW)
  ruled.steps.splice(3, 0, { id: 'rule', kind: 'bot', bot: 'Judge', ruling: true, leaves: ['verdict'] })
  ruled.lines.find((l) => l.from === 'check' && l.on === 'fail').then = 'rule'
  ruled.lines.push({ from: 'rule', to: 'land', on: 'pass' }, { from: 'rule', to: 'decide', on: 'fail' })
  assert.equal(checkTrack(ruled, { selfKey: 'crew' }).steps[3].ruling, true)
})

test('saving keeps versions, and the same track saved again is not a new version; bots may not save one', () => {
  const { store } = yard()
  const first = saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  assert.equal(first.version, 1)
  assert.equal(saveTrack(store, 'co', CREW, { now: T0 + 1, actor: OWNER }).unchanged, true)
  const second = saveTrack(store, 'co', { ...CREW, steps: CREW.steps.map((s) => (s.id === 'build' ? { ...s, model: 'big' } : s)) }, { now: T0 + 2, actor: OWNER })
  assert.equal(second.version, 2)
  assert.equal(store.count('track_versions'), 2)
  assert.throws(() => saveTrack(store, 'co', CREW, { actor: { agent: 'b1' } }), /Only the owner/)
})

test('verdicts are read in the crew\'s words', () => {
  for (const t of ['PASS', 'pass: all good', 'MET', 'Approved']) assert.equal(verdictOf(t), 'pass', t)
  for (const t of ['FAIL', 'NOT MET: two rows', 'Rejected']) assert.equal(verdictOf(t), 'fail', t)
  assert.equal(verdictOf('looks fine'), null)
  // A verdict document that repeats its name, as the crew's bots write it, plain or in bold.
  assert.equal(verdictOf('VERDICT: PASS'), 'pass')
  assert.equal(verdictOf('**VERDICT:** FAIL. The hero image is blurry.'), 'fail')
  assert.equal(verdictOf('Verdict: met'), 'pass')
})

test('a request moves along its track: a failed check goes back with its findings, rounds are counted, the gate decides, and it is finished only in main', async () => {
  const { store, dataDir, repo } = yard()
  saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  let testsPass = true
  let landed = false
  const io = fakeIo({
    'run tests': () => (testsPass ? { out: { verdict: 'pass', leaves: { tests: '12 passed' }, numbers: { passed: 12 } } } : { exitCode: 1, stdout: '3 failed' }),
    'land it': (spec) => ({ out: { leaves: { commit: `${spec.env.BOTYARD_IN_COMMIT}-merged` } } }),
  }, { inMain: async (where, commit, branch) => { assert.equal(where, repo); assert.equal(branch, 'main'); return landed } })
  const request = startRequest(store, 'co', { track: 'crew', title: 'Add a lighthouse', projectId: 'p1', inputs: { brief: 'A lighthouse on the hill' } }, { now: T0, actor: { agent: 'lead-bot' } })
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'in_progress')
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  // The builder gets a job under the request, with the brief.
  const build1 = workingJob(store, tripId, 'build')
  const job1 = store.object('SELECT raw FROM jobs WHERE id = ?', build1)
  assert.equal(job1.parentId, request.jobId)
  assert.equal(job1.assigneeAgentId, 'b1')
  assert.match(job1.description, /A lighthouse on the hill/)
  assert.equal(store.object("SELECT raw FROM wakes WHERE agent_id = 'b1'").payload.issueId, build1, 'the bot is woken')
  // The request names the bot on its step now, for its line on the Work sheet.
  assert.equal(getRequest(store, request.id).trip.currentBotId, 'b1')
  store.put('runs', { id: 'r1', companyId: 'co', agentId: 'b1', issueId: build1, status: 'succeeded', usageJson: { costUsd: 1.25, inputTokens: 100, outputTokens: 10 } })
  botDoes(store, build1, { commit: 'aaa1111' }, T0)
  await tick(2)
  // Tests passed with the commit handed in; the checker got its job.
  assert.equal(io.ran[0].env.BOTYARD_IN_COMMIT, 'aaa1111')
  const check1 = workingJob(store, tripId, 'check')
  assert.ok(check1)
  store.put('runs', { id: 'r2', companyId: 'co', agentId: 'c1', issueId: check1, status: 'succeeded', usageJson: { costUsd: 0.5 } })
  botDoes(store, check1, { verdict: 'FAIL: the lamp does not turn' }, T0)
  await tick(3)
  // Back to build, round 1, with the findings and the commit it continues.
  const build2 = workingJob(store, tripId, 'build')
  const job2 = store.object('SELECT raw FROM jobs WHERE id = ?', build2)
  assert.match(job2.description, /the lamp does not turn/)
  assert.match(job2.description, /Start from commit aaa1111/)
  assert.equal(job2.startFrom, 'aaa1111')
  assert.match(job2.title, /round 2/)
  let view = tripView(store, tripId)
  assert.deepEqual(view.rounds, { 'check>build': 1 })
  assert.equal(view.steps.find((s) => s.id === 'build').tries.length, 2)
  assert.equal(view.steps.find((s) => s.id === 'check').tries[0].status, 'stale', 'the failed check is kept, no longer read')
  assert.equal(view.steps.find((s) => s.id === 'check').tries[0].snapshot.verdict, 'fail')
  // Round 2 fails at the tests, round 3 at the check: both back-lines count their own rounds.
  botDoes(store, build2, { commit: 'bbb2222' }, T0)
  testsPass = false
  await tick(4)
  assert.deepEqual(tripView(store, tripId).rounds, { 'check>build': 1, 'tests>build': 1 })
  assert.match(store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build')).description, /3 failed/)
  testsPass = true
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'ccc3333' }, T0)
  await tick(5)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL again' }, T0)
  await tick(6)
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'ddd4444' }, T0)
  await tick(7)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL a third time' }, T0)
  await tick(8)
  // Two rounds back from the check are used: the gate decides, and shows the findings.
  view = tripView(store, tripId)
  assert.equal(view.current, 'decide')
  const card = store.object("SELECT raw FROM cards WHERE status = 'pending'")
  assert.equal(card.issueId, request.jobId)
  assert.match(card.summary, /FAIL a third time/)
  assert.throws(() => answerGate(store, tripId, { action: 'approve' }, { actor: { agent: 'b1' } }), /Only the owner/)
  // The checks failed, so the gate never offers to land it: its yes sends the work back to the build with the findings.
  assert.equal(card.payload.acceptLabel, 'Send it back to build')
  assert.match(card.payload.prompt, /The work did not pass, so going on to land is not offered here/)
  answerGate(store, tripId, { action: 'approve' }, { now: T0 + 9000, actor: OWNER })
  await tick(10)
  const build5 = store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build'))
  assert.match(build5.description, /FAIL a third time/)
  assert.equal(io.ran.filter((r) => r.line === 'land it').length, 0, 'nothing landed on the yes')
  botDoes(store, build5.id, { commit: 'eee5555' }, T0)
  await tick(11)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'PASS' }, T0)
  await tick(12)
  // Landed by the script once a check passed, but not in main yet: not finished.
  view = tripView(store, tripId)
  assert.equal(view.status, 'not-in-main')
  assert.equal(view.commit, 'eee5555-merged')
  assert.equal(getRequest(store, request.id).status, 'not-in-main')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'in_progress')
  landed = true
  await tick(80)
  assert.equal(tripView(store, tripId).status, 'done')
  const shown = getRequest(store, request.jobCode)
  assert.equal(shown.status, 'done')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'done')
  // The build rounds the landed one replaced are closed as superseded; the round that landed stays done.
  const builds = store.objects("SELECT raw FROM trip_steps WHERE trip_id = ? AND step_id = 'build' ORDER BY created_at", tripId)
  assert.deepEqual(builds.map((b) => store.object('SELECT raw FROM jobs WHERE id = ?', b.jobId).status), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'done'])
  assert.match(store.objects('SELECT raw FROM comments WHERE job_id = ?', builds[0].jobId).at(-1).body, /^Superseded: a later round of this request landed in main \(eee5555-merg/)
  // Cost is added up across every step and round of the request.
  assert.equal(shown.cost.usd, 1.75)
  assert.equal(shown.cost.inputTokens, 100)
})

test('a blocked step fails with its words, and the next round starts from the last commit a passing try left', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  const io = fakeIo({ 'run tests': () => ({ out: { verdict: 'pass' } }) })
  startRequest(store, 'co', { track: 'crew', title: 'Add a lamp', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  // The first build passes with a report line that names its branch after the commit.
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111 on LH-1-build' }, T0)
  await tick(2)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL: no lamp' }, T0)
  await tick(3)
  // Round 2 starts from aaa1111, and its bot stops: blocked, nothing new built, no question for the owner.
  const round2 = workingJob(store, tripId, 'build')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', round2).startFrom, 'aaa1111')
  const { addComment } = await import('../server/engine/write.mjs')
  addComment(store, round2, { body: 'Nothing built: the branch does not hold the work.\nCOMMIT: 1f36db3 (no new commit)' }, { now: T0, actor: { agent: 'b1' } })
  store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', round2), status: 'blocked' })
  await tick(4)
  // Blocked is a fail: the build's own fail line is to the gate here, with the bot's words.
  const view = tripView(store, tripId)
  assert.equal(view.current, 'decide')
  assert.match(store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /Nothing built/)
  // Sent back to build by the owner: it starts from the commit the passing try left, not the blocked one.
  answerGate(store, tripId, { action: 'back', to: 'build', note: 'go on from your first commit' }, { now: T0 + 5000, actor: OWNER })
  await tick(6)
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build')).startFrom, 'aaa1111')
})

test('a gate with nothing to land says so: its yes sends the work back from the commit the findings name, its no stops it', async () => {
  const SHA = '44a585bf9bd60064cfa56b214a688f7a92316a86'
  for (const answer of ['accept', 'reject']) {
    const { store, dataDir } = yard()
    saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
    const io = fakeIo({})
    const request = startRequest(store, 'co', { track: 'crew', title: 'Redesign the site', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
    const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
    await tick(1)
    const tripId = store.row('SELECT id FROM trips').id
    // The build stops at once: the work it should go on from is on another commit.
    const build = workingJob(store, tripId, 'build')
    const { addComment } = await import('../server/engine/write.mjs')
    addComment(store, build, { body: `Stopped: the fixes are in commit ${SHA}, which is not under this branch.` }, { now: T0, actor: { agent: 'b1' } })
    store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', build), status: 'blocked' })
    await tick(2)
    assert.equal(tripView(store, tripId).current, 'decide')
    const card = store.object("SELECT raw FROM cards WHERE status = 'pending'")
    // The card names the request and says what each answer does: there is nothing to land.
    assert.match(card.title, /^Your call: .*Redesign the site/)
    assert.equal(card.payload.acceptLabel, 'Send it back to build')
    assert.equal(card.payload.rejectLabel, 'Stop it')
    assert.match(card.payload.prompt, /a step failed/)
    assert.match(card.payload.prompt, /from 44a585bf9bd6, the commit the findings name/)
    assert.match(card.payload.prompt, /Build starts again from 44a585bf9bd6.*There is nothing to land yet: no build passed/)
    assert.match(card.payload.prompt, /Stop it: The request stops here and nothing is merged/)
    // Answered as the card says, the way the tray answers it: yes or no, with an optional note for a stop.
    answerGate(store, tripId, { action: 'answer', yes: answer === 'accept', note: answer === 'reject' ? 'Not now' : '' }, { now: T0 + 3000, actor: OWNER })
    await tick(4)
    if (answer === 'accept') {
      // Back to the build, from the named commit, with the findings as its note.
      const again = store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build'))
      assert.equal(again.startFrom, SHA)
      assert.match(again.description, /not under this branch/)
      assert.equal(tripView(store, tripId).status, 'running')
    } else {
      assert.equal(tripView(store, tripId).status, 'stopped')
      assert.equal(store.object('SELECT raw FROM requests WHERE id = ?', request.id).status, 'stopped')
      assert.equal(tripView(store, tripId).reason, 'Not now')
    }
  }
})

/** A small crew track with the scored review before landing, as the built-in one has it. */
const SCORED = {
  key: 'scored', inputs: ['brief'], optional: ['reviewer', 'public_paths', 'public_projects', 'public_mark'],
  defaults: { reviewer: 'Judge', public_paths: 'site/,marketing/' },
  steps: [
    { id: 'build', kind: 'bot', bot: 'Builder', needs: ['brief'], leaves: ['commit'] },
    { id: 'check', kind: 'bot', bot: 'Checker', needs: ['brief', 'commit'], leaves: ['verdict'] },
    { id: 'review', kind: 'bot', bot: '$reviewer', orBot: 'Checker', onlyFor: 'public', needs: ['commit'], leaves: ['verdict'] },
    { id: 'decide', kind: 'gate' },
    { id: 'land', kind: 'script', command: 'land it', needs: ['commit'], leaves: ['commit'] },
  ],
  lines: [
    { from: 'build', to: 'check', on: 'pass' }, { from: 'build', to: 'decide', on: 'fail' },
    { from: 'check', to: 'review', on: 'pass' }, { from: 'check', to: 'build', on: 'fail', rounds: 1, then: 'decide' },
    { from: 'review', to: 'land', on: 'pass' }, { from: 'review', to: 'build', on: 'fail', rounds: 1, then: 'decide' },
    { from: 'decide', to: 'land', on: 'pass' }, { from: 'land', to: 'decide', on: 'fail' },
  ],
}

test('work the public will see cannot land without the reviewer\'s PASS; a fail goes back to the build with the findings', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', SCORED, { now: T0, actor: OWNER })
  const io = { ...fakeIo({ 'land it': (spec) => ({ out: { leaves: { commit: spec.env.BOTYARD_IN_COMMIT } } }) }), changedFiles: async () => ['site/index.html', 'src/app.mjs'] }
  startRequest(store, 'co', { track: 'scored', title: 'New home page', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111' }, T0)
  await tick(2)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'VERDICT: PASS' }, T0)
  await tick(3)
  // The check passed, and still nothing lands: the page goes to the reviewer, the bot the track names.
  const review = store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'review'))
  assert.equal(review.assigneeAgentId, 'j1')
  assert.equal(io.ran.length, 0)
  assert.equal(tripView(store, tripId).current, 'review')
  // The reviewer fails it: back to the build, with the findings.
  botDoes(store, review.id, { verdict: 'VERDICT: FAIL. The hero image is blurry at 375 px.' }, T0)
  await tick(4)
  assert.match(store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build')).description, /blurry at 375 px/)
  assert.equal(io.ran.length, 0)
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'bbb2222' }, T0)
  await tick(5)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'VERDICT: PASS' }, T0)
  await tick(6)
  botDoes(store, workingJob(store, tripId, 'review'), { verdict: 'VERDICT: PASS' }, T0)
  await tick(7)
  // Only after the reviewer's PASS does the land step run.
  assert.deepEqual(io.ran.map((r) => r.line), ['land it'])
  assert.equal(tripView(store, tripId).status, 'done')
})

test('whether work is public is decided from its project and the paths it changes, not from the brief', async () => {
  const run = async ({ files, defaults = {}, brief = 'b' }) => {
    const { store, dataDir } = yard()
    saveTrack(store, 'co', { ...SCORED, defaults: { ...SCORED.defaults, ...defaults } }, { now: T0, actor: OWNER })
    const io = { ...fakeIo({ 'land it': () => ({ out: { leaves: { commit: 'aaa1111' } } }) }), changedFiles: async () => files }
    startRequest(store, 'co', { track: 'scored', title: 'Change', projectId: 'p1', inputs: { brief } }, { now: T0, actor: OWNER })
    const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
    await tick(1)
    const tripId = store.row('SELECT id FROM trips').id
    botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111' }, T0)
    await tick(2)
    botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'VERDICT: PASS' }, T0)
    await tick(3)
    return tripView(store, tripId)
  }
  // Internal code only: the review does not run, and it says why; the work lands.
  const inner = await run({ files: ['src/engine.mjs', 'test/engine.test.mjs'] })
  assert.equal(inner.status, 'done')
  assert.match(inner.steps.find((s) => s.id === 'review').latest.snapshot.summary, /^Not run: nothing it changes is seen by the public/)
  // A changed marketing file, a public project, a brief with the mark, or files that cannot be read: it is scored.
  assert.equal((await run({ files: ['marketing/kit/cover.png'] })).current, 'review')
  assert.equal((await run({ files: ['src/x.mjs'], defaults: { public_projects: 'harbour' } })).current, 'review')
  assert.equal((await run({ files: ['src/x.mjs'], defaults: { public_mark: 'SCORED BAR' }, brief: 'SCORED BAR: page bar' })).current, 'review')
  assert.equal((await run({ files: null })).current, 'review')
  // A commit already in main shows no changed files: that is not "nothing public", it is scored.
  assert.equal((await run({ files: [] })).current, 'review')
  // A brief that leaves the mark out does not skip it when the files are public.
  assert.equal((await run({ files: ['site/about.html'], defaults: { public_mark: 'SCORED BAR' }, brief: 'nothing said' })).current, 'review')
})

test('the built-in crew track scores public work before landing, and its ruling cannot skip the score', () => {
  const lines = BUILD_TRACK.lines
  assert.deepEqual(lines.filter((l) => l.to === 'land').map((l) => l.from).sort(), ['owner', 'review'])
  assert.ok(lines.some((l) => l.from === 'rule' && l.to === 'review' && l.on === 'pass'))
  assert.ok(lines.some((l) => l.from === 'check' && l.to === 'review' && l.on === 'pass'))
  assert.deepEqual(lines.find((l) => l.from === 'review' && l.on === 'fail'), { from: 'review', to: 'build', on: 'fail', rounds: 2, then: 'rule' })
  // Only the ruler's ASK OWNER reaches the owner's gate on this track.
  assert.deepEqual(lines.filter((l) => l.to === 'owner').map((l) => `${l.from}:${l.on}`), ['rule:ask'])
  assert.equal(BUILD_TRACK.steps.find((s) => s.id === 'review').onlyFor, 'public')
  // The ruling is the ruler's (a bot other than the checker, when the studio names one), else the lead's.
  const rule = BUILD_TRACK.steps.find((s) => s.id === 'rule')
  assert.deepEqual([rule.bot, rule.orBot], ['$ruler', '$lead'])
  assert.equal(checkTrack(BUILD_TRACK, { selfKey: 'build-check-land' }).optional.includes('reviewer'), true)
})

/** A crew track with the ruler deciding every failure past its rounds; only his ASK OWNER reaches the owner. */
const RULED = {
  key: 'ruled', inputs: ['brief'],
  steps: [
    { id: 'build', kind: 'bot', bot: 'Builder', needs: ['brief'], leaves: ['commit'] },
    { id: 'check', kind: 'bot', bot: 'Checker', needs: ['commit'], leaves: ['verdict'] },
    { id: 'rule', kind: 'bot', bot: 'Judge', ruling: true, leaves: ['verdict'] },
    { id: 'decide', kind: 'gate' },
    { id: 'land', kind: 'script', command: 'land it', needs: ['commit'], leaves: ['commit'] },
  ],
  lines: [
    { from: 'build', to: 'check', on: 'pass' }, { from: 'build', to: 'rule', on: 'fail' },
    { from: 'check', to: 'land', on: 'pass' }, { from: 'check', to: 'build', on: 'fail', rounds: 1, then: 'rule' },
    { from: 'rule', to: 'land', on: 'pass' }, { from: 'rule', to: 'build', on: 'fail', rounds: 1, then: 'rule' }, { from: 'rule', to: 'decide', on: 'ask' },
    { from: 'decide', to: 'land', on: 'pass' }, { from: 'land', to: 'rule', on: 'fail' },
  ],
}

test('a failure past its rounds goes to the ruler, who passes it, sends it back with his plan, stops it, or asks the owner', async () => {
  const run = async (said) => {
    const { store, dataDir } = yard()
    saveTrack(store, 'co', RULED, { now: T0, actor: OWNER })
    const io = fakeIo({ 'land it': () => ({ out: { leaves: { commit: 'aaa1111' } } }) })
    const request = startRequest(store, 'co', { track: 'ruled', title: 'Kit', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
    const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
    await tick(1)
    const tripId = store.row('SELECT id FROM trips').id
    botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111' }, T0)
    await tick(2)
    botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL: row 2 wrong' }, T0)
    await tick(3)
    botDoes(store, workingJob(store, tripId, 'build'), { commit: 'bbb2222' }, T0)
    await tick(4)
    botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL: row 2 still wrong' }, T0)
    await tick(5)
    // The check's round is used: the ruler is asked, the owner is not.
    assert.equal(tripView(store, tripId).current, 'rule')
    assert.equal(store.rows("SELECT id FROM cards WHERE status = 'pending'").length, 0, 'no card to the owner')
    botDoes(store, workingJob(store, tripId, 'rule'), { verdict: said }, T0)
    await tick(6)
    return { store, tripId, request, io }
  }
  // PASS: it lands, with no card to the owner.
  const pass = await run('PASS: good enough as it is')
  assert.equal(tripView(pass.store, pass.tripId).status, 'done')
  assert.equal(pass.store.rows('SELECT id FROM cards').length, 0)
  // FAIL with a plan: back to the build, the plan as its note.
  const fail = await run('FAIL. Plan: start from bbb2222, redo row 2 with the town in frame, prove it with a capture.')
  assert.equal(tripView(fail.store, fail.tripId).current, 'build')
  assert.match(fail.store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(fail.store, fail.tripId, 'build')).description, /redo row 2 with the town in frame/)
  assert.equal(fail.store.rows('SELECT id FROM cards').length, 0)
  // STOP: the request ends, with his reason, and nothing is asked of the owner.
  const stop = await run('STOP: the kit is not worth a sixth round')
  assert.equal(tripView(stop.store, stop.tripId).status, 'stopped')
  assert.match(tripView(stop.store, stop.tripId).reason, /not worth a sixth round/)
  assert.equal(stop.store.object('SELECT raw FROM requests WHERE id = ?', stop.request.id).status, 'stopped')
  assert.equal(stop.store.rows('SELECT id FROM cards').length, 0)
  // ASK OWNER: only now does the owner get a card, with his options.
  const ask = await run('ASK OWNER: redesign with the artist (my pick) or a sixth fix round')
  assert.equal(tripView(ask.store, ask.tripId).current, 'decide')
  assert.match(ask.store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /redesign with the artist \(my pick\)/)
})

test('a ruler who sends the same work back past his own rounds stops it instead of being asked again', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', RULED, { now: T0, actor: OWNER })
  const io = fakeIo({ 'land it': () => ({ out: { leaves: { commit: 'aaa1111' } } }) })
  startRequest(store, 'co', { track: 'ruled', title: 'Kit', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  const fails = async (n) => {
    botDoes(store, workingJob(store, tripId, 'build'), { commit: `c${n}c${n}c${n}c` }, T0); await tick(n * 10 + 1)
    botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL' }, T0); await tick(n * 10 + 2)
    if (workingJob(store, tripId, 'build')) { botDoes(store, workingJob(store, tripId, 'build'), { commit: `d${n}d${n}d${n}d` }, T0); await tick(n * 10 + 3); botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'FAIL' }, T0); await tick(n * 10 + 4) }
    botDoes(store, workingJob(store, tripId, 'rule'), { verdict: 'FAIL. Try again from the last commit.' }, T0); await tick(n * 10 + 5)
  }
  await fails(1)
  assert.equal(tripView(store, tripId).current, 'build')
  await fails(2)
  const view = tripView(store, tripId)
  assert.equal(view.status, 'stopped')
  assert.match(view.reason, /sent it back 1 time and it still failed/)
  assert.equal(store.rows('SELECT id FROM cards').length, 0)
})

test('a track that delivers a change and leaves no commit is stuck, never done', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', { key: 'nocommit', steps: [{ id: 'only', kind: 'script', command: 'ok' }, { id: 'decide', kind: 'gate' }], lines: [{ from: 'only', to: 'decide', on: 'fail' }] }, { actor: OWNER })
  const request = startRequest(store, 'co', { track: 'nocommit', title: 'Tidy', projectId: 'p1' }, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io: fakeIo({ ok: () => ({}) }), now: T0 })
  const shown = getRequest(store, request.id)
  assert.equal(shown.trip.status, 'stuck')
  assert.match(shown.trip.reason, /no step left a commit/)
  assert.equal(shown.status, 'working')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'in_progress')
})

test('pause holds a trip, resume goes on, and a rerun from a step keeps every snapshot before it', async () => {
  const { store, dataDir } = yard()
  const io = fakeIo({ one: () => ({ out: { leaves: { a: 'first' } } }), two: (spec) => ({ out: { leaves: { b: `${spec.env.BOTYARD_IN_A}+${spec.env.BOTYARD_IN_NOTE || ''}` } } }) })
  saveTrack(store, 'co', {
    key: 'two', delivers: 'nothing',
    steps: [{ id: 's1', kind: 'script', command: 'one', leaves: ['a'] }, { id: 's2', kind: 'script', command: 'two', needs: ['a'], leaves: ['b'] }, { id: 'stop', kind: 'gate' }],
    lines: [{ from: 's1', to: 's2', on: 'pass' }, { from: 's1', to: 'stop', on: 'fail' }, { from: 's2', to: 'stop', on: 'fail' }],
  }, { actor: OWNER })
  const request = startRequest(store, 'co', { track: 'two', title: 'Two steps' }, { now: T0, actor: OWNER })
  const tripId = store.row('SELECT id FROM trips').id
  pauseTrip(store, tripId, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 1000 })
  assert.equal(io.ran.length, 0, 'a paused trip starts nothing')
  assert.throws(() => pauseTrip(store, tripId, { actor: { agent: 'b1' } }), /Only the owner/)
  resumeTrip(store, tripId, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 2000 })
  assert.deepEqual(io.ran.map((r) => r.line), ['one', 'two'])
  assert.equal(getRequest(store, request.id).status, 'done')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'done')
  // Rerun from the second step with a note: the first is not run again, its value is read from its snapshot.
  rerunTrip(store, tripId, { step: 's2', note: 'louder' }, { now: T0 + 3000, actor: OWNER })
  assert.equal(getRequest(store, request.id).status, 'working', 'a rerun opens the request again')
  await tickTracks(store, { dataDir, io, now: T0 + 4000 })
  assert.deepEqual(io.ran.map((r) => r.line), ['one', 'two', 'two'])
  const view = tripView(store, tripId)
  assert.equal(view.steps[0].tries.length, 1)
  assert.equal(view.steps[1].latest.snapshot.leaves.b, 'first+louder')
  assert.equal(view.steps[1].tries[0].status, 'stale')
  assert.equal(view.status, 'done')
  assert.throws(() => rerunTrip(store, tripId, { step: 'nope' }, { actor: OWNER }), /Say which step/)
})

test('at a gate the owner sends the work back to a chosen step with a note, or adds context and the step before runs again', async () => {
  const { store, dataDir } = yard()
  const io = fakeIo({ draft: (spec) => ({ out: { leaves: { text: `draft(${spec.env.BOTYARD_IN_NOTE || ''})` } } }), polish: (spec) => ({ out: { leaves: { text: `${spec.env.BOTYARD_IN_TEXT}+polish(${spec.env.BOTYARD_IN_NOTE || ''})` } } }) })
  saveTrack(store, 'co', {
    key: 'write', delivers: 'nothing',
    steps: [{ id: 'draft', kind: 'script', command: 'draft', leaves: ['text'] }, { id: 'polish', kind: 'script', command: 'polish', needs: ['text'], leaves: ['text'] }, { id: 'look', kind: 'gate', needs: ['text'] }],
    lines: [{ from: 'draft', to: 'polish', on: 'pass' }, { from: 'draft', to: 'look', on: 'fail' }, { from: 'polish', to: 'look', on: 'always' }],
  }, { actor: OWNER })
  startRequest(store, 'co', { track: 'write', title: 'A page' }, { now: T0, actor: OWNER })
  const tripId = store.row('SELECT id FROM trips').id
  await tickTracks(store, { dataDir, io, now: T0 })
  assert.match(store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /draft\(\)\+polish\(\)/)
  assert.throws(() => answerGate(store, tripId, { action: 'back', to: 'look', note: 'x' }, { actor: OWNER }), /a step before the gate/)
  assert.throws(() => answerGate(store, tripId, { action: 'back', to: 'draft' }, { actor: OWNER }), /a note goes with the work/)
  answerGate(store, tripId, { action: 'back', to: 'draft', note: 'shorter' }, { now: T0 + 1, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 2 })
  assert.match(store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /draft\(shorter\)\+polish\(\)/)
  answerGate(store, tripId, { action: 'context', note: 'warmer' }, { now: T0 + 3, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 4 })
  assert.match(store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /draft\(shorter\)\+polish\(warmer\)/)
  assert.deepEqual(io.ran.map((r) => r.line), ['draft', 'polish', 'draft', 'polish', 'polish'])
  answerGate(store, tripId, { action: 'approve' }, { now: T0 + 5, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 6 })
  assert.equal(tripView(store, tripId).status, 'done')
  assert.throws(() => answerGate(store, tripId, { action: 'approve' }, { actor: OWNER }), /not waiting at a gate/)
})

test('a "no" on the gate\'s card sends the work back to the step before it', async () => {
  const { store, dataDir } = yard()
  const io = fakeIo({ make: () => ({ out: { leaves: {} } }) })
  saveTrack(store, 'co', { key: 'mk', delivers: 'nothing', steps: [{ id: 'make', kind: 'script', command: 'make' }, { id: 'ok', kind: 'gate' }], lines: [{ from: 'make', to: 'ok', on: 'always' }] }, { actor: OWNER })
  const request = startRequest(store, 'co', { track: 'mk', title: 'Make' }, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 })
  const card = store.object("SELECT raw FROM cards WHERE status = 'pending'")
  const { settleCard } = await import('../server/engine/write.mjs')
  settleCard(store, request.jobId, card.id, 'reject', { reason: 'not like this' }, { now: T0 + 1, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 + 2 })
  assert.equal(io.ran.length, 2)
  assert.equal(tripView(store, store.row('SELECT id FROM trips').id).current, 'ok')
})

test('a step can run another saved track and take what it leaves', async () => {
  const { store, dataDir } = yard()
  const io = fakeIo({ inner: () => ({ out: { leaves: { score: '9' } } }), outer: (spec) => ({ out: { leaves: { said: `score ${spec.env.BOTYARD_IN_SCORE}` } } }) })
  saveTrack(store, 'co', { key: 'scoring', delivers: 'nothing', steps: [{ id: 'score', kind: 'script', command: 'inner', leaves: ['score'] }, { id: 'g', kind: 'gate' }], lines: [{ from: 'score', to: 'g', on: 'fail' }] }, { actor: OWNER })
  saveTrack(store, 'co', {
    key: 'outer', delivers: 'nothing',
    steps: [{ id: 'sub', kind: 'track', track: 'scoring', leaves: ['score'] }, { id: 'say', kind: 'script', command: 'outer', needs: ['score'], leaves: ['said'] }, { id: 'g', kind: 'gate' }],
    lines: [{ from: 'sub', to: 'say', on: 'pass' }, { from: 'sub', to: 'g', on: 'fail' }, { from: 'say', to: 'g', on: 'fail' }],
  }, { actor: OWNER })
  const request = startRequest(store, 'co', { track: 'outer', title: 'Score it' }, { now: T0, actor: OWNER })
  for (let n = 0; n < 3; n++) await tickTracks(store, { dataDir, io, now: T0 + n })
  const shown = getRequest(store, request.id)
  assert.equal(shown.status, 'done')
  assert.equal(shown.trips[0].steps[1].latest.snapshot.leaves.said, 'score 9')
  assert.equal(shown.trips[0].innerTrips.length, 1)
})

test('stopping a trip lets go of the step at work and stops the request', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  const request = startRequest(store, 'co', { track: 'crew', title: 'X', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io: fakeIo(), now: T0 })
  const tripId = store.row('SELECT id FROM trips').id
  const job = workingJob(store, tripId, 'build')
  stopTrip(store, tripId, { now: T0, actor: OWNER })
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', job).status, 'cancelled')
  assert.equal(getRequest(store, request.id).status, 'stopped')
})

test('the built-in sample runs a real script and waits at the owner\'s gate, with no bot and no key', async () => {
  const { store, dataDir, repo } = yard()
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
  const request = startRequest(store, 'co', { track: SAMPLE_TRACK.key, title: 'Count the harbour', projectId: 'p1' }, { now: Date.now(), actor: OWNER })
  const tripId = store.row('SELECT id FROM trips').id
  for (let n = 0; n < 100; n++) {
    await tickTracks(store, { dataDir, io: trackIo, now: Date.now() })
    if (tripView(store, tripId).current === 'approve') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const view = tripView(store, tripId)
  assert.equal(view.current, 'approve')
  assert.equal(view.steps[0].latest.snapshot.leaves.report, 'This folder holds 2 files and folders.')
  assert.equal(view.steps[0].latest.snapshot.numbers.entries, 2)
  answerGate(store, tripId, { action: 'approve' }, { actor: OWNER })
  await tickTracks(store, { dataDir, io: trackIo, now: Date.now() })
  assert.equal(getRequest(store, request.id).status, 'done')
})

test('tracks, requests and trips through the engine\'s API', async () => {
  const { startEngine } = await import('../server/engine/main.mjs')
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-tracks-api-')), 'data'), runs: false, log: () => {} })
  try {
    const co = (await engine.handle({ url: '/api/companies' })).body[0].id
    const list = await engine.handle({ url: `/api/companies/${co}/tracks` })
    assert.equal(list.status, 200)
    assert.ok(list.body.some((t) => t.key === 'sample-check' && t.current.steps.length === 2), 'the sample is there in a new yard')
    const refused = await engine.handle({ method: 'POST', url: `/api/companies/${co}/tracks`, body: { key: 'bad', steps: [{ id: 'a', kind: 'script', command: 'x' }] } })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /nothing after a fail/)
    const started = await engine.handle({ method: 'POST', url: `/api/companies/${co}/requests`, body: { track: 'sample-check', title: 'Count' } })
    assert.equal(started.status, 201)
    const request = await engine.handle({ url: `/api/requests/${started.body.id}` })
    assert.equal(request.body.trips.length, 1)
    assert.equal(request.body.trips[0].steps.length, 2)
    const trip = await engine.handle({ url: `/api/trips/${request.body.trips[0].id}` })
    assert.equal(trip.body.track.key, 'sample-check')
    const paused = await engine.handle({ method: 'POST', url: `/api/trips/${trip.body.id}/pause`, body: {} })
    assert.equal(paused.body.status, 'paused')
    const gate = await engine.handle({ method: 'POST', url: `/api/trips/${trip.body.id}/gate`, body: { action: 'approve' } })
    assert.equal(gate.status, 409)
    assert.equal((await engine.handle({ url: `/api/companies/${co}/requests` })).body.length, 1)
  } finally {
    await engine.stop()
  }
})
// ── fix rounds start from the work ───────────────────────────────────────────────

test('a fix round after a build that said NOT MET still starts from that build\'s commit, not from main', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', {
    key: 'rounds', inputs: ['brief'],
    steps: [
      { id: 'build', kind: 'bot', bot: 'Builder', needs: ['brief'], leaves: ['commit'] },
      { id: 'decide', kind: 'gate' },
    ],
    lines: [{ from: 'build', to: 'build', on: 'fail', rounds: 2, then: 'decide' }, { from: 'build', to: 'decide', on: 'pass' }],
  }, { now: T0, actor: OWNER })
  const io = fakeIo({})
  startRequest(store, 'co', { track: 'rounds', title: 'Site', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  let n = 0
  const tick = () => tickTracks(store, { dataDir, io, now: T0 + ++n * 1000 })
  await tick()
  const tripId = store.row('SELECT id FROM trips').id
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'ddd4444', outcome: 'NOT MET: not deployed yet' }, T0)
  await tick()
  const round2 = store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build'))
  assert.equal(round2.startFrom, 'ddd4444')
  // The round after that goes on from the newest commit, too.
  botDoes(store, round2.id, { commit: 'eee5555', outcome: 'NOT MET' }, T0)
  await tick()
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', workingJob(store, tripId, 'build')).startFrom, 'eee5555')
})

// The land step's guard (nothing lands without its passes) has its own tests: engine-land-guard.test.mjs.

test('every scored review is kept in the reviews table with its piece kind and verdict; a skipped one is not', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', SCORED, { now: T0, actor: OWNER })
  const io = { ...fakeIo({ 'land it': () => ({ out: { leaves: { commit: 'aaa1111' } } }) }), changedFiles: async () => ['marketing/steam/capsule.png'] }
  startRequest(store, 'co', { track: 'scored', title: 'Steam kit', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111' }, T0)
  await tick(2)
  botDoes(store, workingJob(store, tripId, 'check'), { verdict: 'PASS' }, T0)
  await tick(3)
  botDoes(store, workingJob(store, tripId, 'review'), { verdict: 'VERDICT: FAIL. The capsule is blurry.' }, T0)
  await tick(4)
  const kept = store.objects('SELECT raw FROM reviews')
  assert.equal(kept.length, 1)
  assert.deepEqual([kept[0].piece.kind, kept[0].verdict, kept[0].source], ['kit', 'fail', 'track'])
  assert.match(kept[0].text, /capsule is blurry/)
})

test('a request has one open card at a time: a new question updates it and says how often it was asked', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', RULED, { now: T0, actor: OWNER })
  const io = fakeIo({ 'land it': () => ({ out: { leaves: { commit: 'aaa1111' } } }) })
  startRequest(store, 'co', { track: 'ruled', title: 'Kit', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  // The build fails straight to the ruler, who asks the owner; the owner sends it back; it fails again and is asked again.
  for (let round = 0; round < 2; round++) {
    const b = workingJob(store, tripId, 'build')
    store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', b), status: 'cancelled' })
    await tick(round * 10 + 2)
    botDoes(store, workingJob(store, tripId, 'rule'), { verdict: 'ASK OWNER: redesign or stop' }, T0)
    await tick(round * 10 + 3)
    if (round === 0) { answerGate(store, tripId, { action: 'back', to: 'build', note: 'one more try' }, { now: T0 + 4000, actor: OWNER }); await tick(round * 10 + 5) }
  }
  const pending = store.objects("SELECT raw FROM cards WHERE status = 'pending'")
  assert.equal(pending.length, 1, 'one open card')
  assert.match(pending[0].title, /\(asked 2 times\)$/)
})

test('a round that ended leaves no job open, a stuck request says so once, and a step is never a request of its own', async () => {
  const { store, dataDir } = yard()
  saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  const io = fakeIo({ 'run tests': () => ({ out: { verdict: 'pass' } }) })
  const request = startRequest(store, 'co', { track: 'crew', title: 'Add a lamp', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const tick = (n) => tickTracks(store, { dataDir, io, now: T0 + n * 1000 })
  const job = (id) => store.object('SELECT raw FROM jobs WHERE id = ?', id)
  await tick(1)
  const tripId = store.row('SELECT id FROM trips').id
  botDoes(store, workingJob(store, tripId, 'build'), { commit: 'aaa1111' }, T0)
  await tick(2)
  // The check's bot gives up: its job blocked, no question. The track sends the work back for round 2.
  const check = workingJob(store, tripId, 'check')
  store.put('jobs', { ...job(check), status: 'blocked' })
  await tick(3)
  const round2 = workingJob(store, tripId, 'build')
  assert.ok(round2, 'round 2 of the build is at work')
  // The blocked check is not left blocked: on the next turn it is closed, with why.
  const settled = await tick(4)
  assert.equal(job(check).status, 'cancelled')
  assert.ok(settled.settled.includes(job(check).identifier))
  assert.match(store.objects('SELECT raw FROM comments WHERE job_id = ? ORDER BY position', check).at(-1).body, /Closed by the track: the work went back to an earlier step/)
  assert.equal(job(round2).status, 'todo', 'the round at work is never touched')
  // A track started on one of its own steps is refused.
  assert.throws(() => startRequest(store, 'co', { track: 'crew', jobId: round2, inputs: { brief: 'b' } }, { now: T0, actor: OWNER }), /is a step of a track already/)
  // A trip that gets stuck: its request's job says so once, as blocked; a stopped one is closed.
  const trip = store.object('SELECT raw FROM trips WHERE id = ?', tripId)
  store.put('trips', { ...trip, status: 'stuck', reason: 'Step "land" has nothing after it' })
  await tick(5)
  assert.equal(job(request.jobId).status, 'blocked')
  assert.equal(job(round2).status, 'todo', 'a stuck trip\'s working step is left to the owner')
  await tick(6)
  assert.equal(store.objects('SELECT raw FROM comments WHERE job_id = ?', request.jobId).filter((c) => /cannot go on/.test(c.body)).length, 1, 'said once')
})

test('one request a goal: asking again for a goal that is moving is refused and names the one that carries it', async () => {
  const { store } = yard()
  saveTrack(store, 'co', CREW, { now: T0, actor: OWNER })
  const first = startRequest(store, 'co', { track: 'crew', title: 'Harbour: the lamp lights', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  assert.throws(() => startRequest(store, 'co', { track: 'crew', title: 'Fix 1 of Harbour: the lamp lights', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER }),
    new RegExp(`${first.jobCode} already carries this goal`))
  // Another goal, or the same goal once the first is stopped, is asked for as before.
  startRequest(store, 'co', { track: 'crew', title: 'Harbour: the door opens', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  store.put('requests', { ...store.object('SELECT raw FROM requests WHERE id = ?', first.id), status: 'stopped' })
  assert.ok(startRequest(store, 'co', { track: 'crew', title: 'Harbour: the lamp lights', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER }))
})

test('a step is tried at most five times in a trip, whichever lines send it back; then the trip waits for a person', async () => {
  const { store, dataDir } = yard()
  const LOOP = {
    key: 'loop', title: 'Loop', inputs: ['brief'],
    steps: [
      { id: 'build', kind: 'bot', bot: 'Builder', words: 'Build.', needs: ['brief'], leaves: ['commit'] },
      { id: 'check', kind: 'bot', bot: 'Checker', words: 'Check.', needs: ['commit'], leaves: ['verdict'] },
      { id: 'review', kind: 'bot', bot: 'Judge', words: 'Review.', needs: ['commit'], leaves: ['verdict'] },
      { id: 'decide', kind: 'gate', title: 'Owner decides' },
    ],
    lines: [
      { from: 'build', to: 'check', on: 'pass' }, { from: 'build', to: 'decide', on: 'fail' },
      { from: 'check', to: 'review', on: 'pass' }, { from: 'check', to: 'build', on: 'fail', rounds: 9, then: 'decide' },
      { from: 'review', to: 'build', on: 'fail', rounds: 9, then: 'decide' }, { from: 'review', to: 'decide', on: 'pass' },
    ],
  }
  saveTrack(store, 'co', LOOP, { now: T0, actor: OWNER })
  const request = startRequest(store, 'co', { track: 'loop', title: 'Harbour: lamp', projectId: 'p1', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  let n = 0
  const tick = () => tickTracks(store, { dataDir, io: fakeIo(), now: T0 + ++n * 1000 })
  await tick()
  const tripId = store.row('SELECT id FROM trips').id
  for (let round = 0; round < 12; round++) {
    const build = workingJob(store, tripId, 'build')
    if (!build) break
    botDoes(store, build, { commit: `aaa${1000 + round}` }, T0)
    await tick()
    const check = workingJob(store, tripId, 'check')
    if (!check) break
    botDoes(store, check, { verdict: 'FAIL: no lamp' }, T0)
    await tick()
  }
  const trip = store.object('SELECT raw FROM trips WHERE id = ?', tripId)
  assert.equal(trip.status, 'stuck')
  assert.match(trip.reason, /"build" was tried 5 times/)
  assert.equal(store.row("SELECT COUNT(*) AS n FROM trip_steps WHERE trip_id = ? AND step_id = 'build'", tripId).n, 5)
  await tick()
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'blocked', 'its request waits for a person, once')
})
