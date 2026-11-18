/** The built-in crew track (build, tests, check, back to the builder, ruling, owner, land) and its tools, on a real git repo. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { addComment } from '../server/engine/write.mjs'
import { BUILD_TRACK, TRACK_MARK, TRACK_TOOLS, botLeft, getRequest, saveTrack, startRequest, tickTracks, trackIo, tripView } from '../server/engine/tracks.mjs'

const OWNER = { user: 'local-board' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim()

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'math.mjs'), 'export const add = (a, b) => a + b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'first')
  return dir
}
/** A commit on a branch of its own, as a builder's worktree leaves it. */
function branchCommit(dir, name, file, text) {
  git(dir, 'checkout', '-q', '-b', name)
  fs.writeFileSync(path.join(dir, file), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', `work on ${name}`)
  const sha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', 'main')
  return sha
}
function tool(name, env, args = []) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-out-')), 'out.json')
  const r = spawnSync(process.execPath, [path.join(TRACK_TOOLS, name), ...args], { env: { ...process.env, ...env, BOTYARD_STEP_OUT: out }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

test('the brief check passes words that hold every section and names what is missing', () => {
  const full = '## OUTCOME\nA lamp\nWHERE: the hill\nTHE BAR: it turns'
  assert.deepEqual(tool('brief.mjs', { BOTYARD_IN_WORDS: full }, ['OUTCOME', 'WHERE', 'THE BAR']).leaves, { brief: full })
  const short = tool('brief.mjs', { BOTYARD_IN_WORDS: 'OUTCOME: a lamp' }, ['OUTCOME', 'PROOF'])
  assert.equal(short.verdict, 'fail')
  assert.match(short.findings, /missing: PROOF/)
  assert.equal(tool('brief.mjs', { BOTYARD_IN_WORDS: 'Make a lamp' }).verdict, 'pass', 'with no sections asked, words are a brief')
})

test('landing merges a clean commit after the tests pass on the merged tree, and refuses otherwise', () => {
  const dir = repo()
  const base = { BOTYARD_PROJECT_FOLDER: dir, BOTYARD_MAIN: 'main', BOTYARD_REQUEST_TITLE: 'Add multiply' }
  const good = branchCommit(dir, 'build-1', 'mul.mjs', 'export const mul = (a, b) => a * b\n')
  // A failing test command on the merged tree: nothing is merged.
  const failing = tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: good, BOTYARD_IN_TEST_COMMAND: 'test -f nothing-here' })
  assert.equal(failing.verdict, 'fail')
  assert.match(failing.findings, /The tests .* failed on the merged tree/)
  assert.equal(spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', good, 'main']).status, 1)
  // The tests see the merged tree.
  const landed = tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: good, BOTYARD_IN_TEST_COMMAND: 'test -f mul.mjs && test -f math.mjs' })
  assert.equal(landed.verdict, 'pass', landed.findings)
  assert.equal(landed.leaves.commit, good)
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Merge: Add multiply')
  assert.equal(tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: good }).verdict, 'pass', 'already in main')
  // Conflicts go back as findings.
  const theirs = branchCommit(dir, 'build-2', 'math.mjs', 'export const add = (a, b) => b + a\n')
  fs.writeFileSync(path.join(dir, 'math.mjs'), 'export const add = (x, y) => x + y\n')
  git(dir, 'commit', '-qam', 'main moved')
  const clash = tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: theirs })
  assert.equal(clash.verdict, 'fail')
  assert.match(clash.findings, /does not merge cleanly[\s\S]*math\.mjs/)
  // A folder off main, or with changes the merge would touch, is not merged into.
  const other = branchCommit(dir, 'build-3', 'div.mjs', 'export const div = (a, b) => a / b\n')
  fs.writeFileSync(path.join(dir, 'div.mjs'), 'local edit\n')
  git(dir, 'add', 'div.mjs')
  assert.match(tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: other }).findings, /changes to files this merge touches: div\.mjs/)
  git(dir, 'reset', '-q', '--hard')
  git(dir, 'checkout', '-q', 'build-1')
  assert.match(tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: other }).findings, /is on build-1, not main/)
  assert.match(tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: 'not-a-sha' }).findings, /No commit to land/)
  git(dir, 'checkout', '-q', 'main')
  assert.equal(tool('land.mjs', { ...base, BOTYARD_IN_COMMIT: `${good} on build-1` }).verdict, 'pass', 'a commit named with its branch')
})

test('a bot\'s report lines are read as what it left', () => {
  const left = botLeft(new Map([['brief', 'from a document']]), 'Done.\n\n**COMMIT:** abc1234\nOUTCOME: NOT MET\nVERDICT: FAIL - two rows red\nchange expected: none')
  assert.equal(left('commit'), 'abc1234')
  assert.equal(left('outcome'), 'NOT MET')
  assert.equal(left('verdict'), 'FAIL - two rows red')
  assert.equal(left('brief'), 'from a document', 'a document wins')
  assert.equal(left('missing'), undefined)
})

test('the built-in crew track runs end to end on a real repo: bots by role, a failed check goes back, the land step merges, and only then is it finished', async () => {
  const dir = repo()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-crew-'))
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  for (const [id, name] of [['b1', 'Builder'], ['c1', 'Checker'], ['l1', 'Lead']]) store.put('agents', { id, companyId: 'co', name, status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Harbour', status: 'in_progress' }, { position: 0 })
  store.put('project_workspaces', { id: 'w1', projectId: 'p1', name: 'main', cwd: dir, isPrimary: true })
  // The studio's own copy: its bots by default, and the brief sections it asks for.
  saveTrack(store, 'co', {
    ...BUILD_TRACK, key: 'crew', defaults: { builder: 'Builder', checker: 'Checker', lead: 'Lead' },
    steps: BUILD_TRACK.steps.map((s) => (s.id === 'brief' ? { ...s, command: `${s.command} OUTCOME PROOF` } : s)),
  }, { actor: OWNER })
  // Only the git calls are real; the bots are played here.
  const io = { ...trackIo, head: async () => '' }
  const tick = async () => { for (let n = 0; n < 50; n++) { await tickTracks(store, { dataDir, io, now: Date.now() }); const t = tripView(store, store.row('SELECT id FROM trips').id); if (t.status !== 'running' || t.steps.some((s) => s.state === 'working' && s.kind === 'bot') || t.steps.some((s) => s.state === 'working' && s.kind === 'gate')) return t; await new Promise((r) => setTimeout(r, 50)) } }
  const request = startRequest(store, 'co', { track: 'crew', title: 'Add multiply', projectId: 'p1', words: 'OUTCOME: mul works\nPROOF: a test', inputs: { test_command: 'test -f mul.mjs' } }, { now: Date.now(), actor: { agent: 'l1' } })
  let trip = await tick()
  const work = (step) => trip.steps.find((s) => s.id === step).latest
  const finish = (step, text, sha = '') => {
    const jobId = work(step).jobId
    const job = store.object('SELECT raw FROM jobs WHERE id = ?', jobId)
    if (sha) {
      // The job's own worktree at its commit, as the runner keeps it: the tests run there.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-wt-'))
      fs.rmSync(cwd, { recursive: true })
      git(dir, 'worktree', 'add', '-q', '--detach', cwd, sha)
      store.put('workspaces', { id: `ws-${jobId}`, projectId: 'p1', sourceIssueId: jobId, cwd, branchName: `${job.identifier}-build`, baseRef: '', updatedAt: new Date().toISOString() })
    }
    addComment(store, jobId, { body: text }, { now: Date.now(), actor: { agent: job.assigneeAgentId } })
    store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', jobId), status: 'done' })
  }
  // The brief held its sections: no bot wrote it. The builder named by the track's default got the job, marked as a track step.
  assert.equal(trip.steps.find((s) => s.id === 'brief').state, 'passed')
  assert.equal(trip.steps.find((s) => s.id === 'write-brief').state, 'not-started')
  const buildJob = store.object('SELECT raw FROM jobs WHERE id = ?', work('build').jobId)
  assert.equal(buildJob.assigneeAgentId, 'b1')
  assert.match(buildJob.description, new RegExp(`${TRACK_MARK} ${trip.id}/build/1`))
  const first = branchCommit(dir, 'b-1', 'notes.txt', 'first try\n')
  // The report names its branch after the commit, as a builder did on the first live run: the commit is still read.
  finish('build', `Built it.\nCOMMIT: ${first} LH-2-build-branch\nOUTCOME: MET`, first)
  trip = await tick()
  // The tests ran (no mul.mjs on the first try): back to the builder with the findings, continuing its commit.
  assert.equal(trip.steps.find((s) => s.id === 'tests').tries[0].status, 'stale')
  assert.match(store.object('SELECT raw FROM jobs WHERE id = ?', work('build').jobId).description, /Start from commit/)
  const second = branchCommit(dir, 'b-2', 'mul.mjs', 'export const mul = (a, b) => a * b\n')
  finish('build', `COMMIT: ${second}\nOUTCOME: MET`, second)
  trip = await tick()
  assert.equal(work('check').jobId && store.object('SELECT raw FROM jobs WHERE id = ?', work('check').jobId).assigneeAgentId, 'c1')
  finish('check', 'Read it, ran it.\nVERDICT: PASS')
  trip = await tick()
  assert.equal(trip.status, 'done', trip.reason)
  assert.equal(spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', second, 'main']).status, 0, 'the work is in main')
  const shown = getRequest(store, request.id)
  assert.equal(shown.status, 'done')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId).status, 'done')
})

test('a request on the built-in crew track names its bots, or is refused', () => {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Harbour', status: 'in_progress' }, { position: 0 })
  assert.throws(() => startRequest(store, 'co', { track: 'build-check-land', title: 'X', projectId: 'p1' }, { actor: OWNER }), /needs builder, checker, lead/)
})
