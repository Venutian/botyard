/**
 * The engine as the only engine, from nothing: an empty folder becomes a studio, and through the API
 * alone it gets a project with its repository, a bot with instructions and a secret, a routine and
 * a job. Everything here goes through `startEngine(...).handle`, the way one process holds the
 * engine with no port.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { RUN_VARS, botSecretsFile, runVars, storeFile, worktreeDir } from '../server/engine/names.mjs'
import { prefixFrom } from '../server/engine/studio.mjs'

const quiet = () => {}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `engine-${name}-`))

/** A new engine in an empty folder, and short ways to call it. */
async function fresh(options = {}) {
  const dataDir = path.join(tmp('studio'), 'data')
  const engine = await startEngine({ dataDir, runs: false, log: quiet, ...options })
  const call = async (method, url, body, headers = {}) => engine.handle({ method, url, body, headers })
  const ok = async (method, url, body) => {
    const out = await call(method, url, body)
    assert.ok(out.status < 300, `${method} ${url} → ${out.status} ${JSON.stringify(out.body)}`)
    return out.body
  }
  const company = (await ok('GET', '/api/companies'))[0]
  return { engine, dataDir, call, ok, company, get: (url) => ok('GET', url), post: (url, body = {}) => ok('POST', url, body), patch: (url, body = {}) => ok('PATCH', url, body), put: (url, body = {}) => ok('PUT', url, body), del: (url) => ok('DELETE', url) }
}

function repo() {
  const dir = path.join(tmp('repo'), 'game')
  fs.mkdirSync(dir)
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), 'a game\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first')
  return dir
}

test('an empty folder becomes a studio that is live, with its owner, and every list the map opens on answers', async () => {
  const s = await fresh()
  assert.equal(s.company.name, 'My studio')
  assert.equal(s.company.issuePrefix, 'STU')
  assert.equal(s.company.status, 'active')
  assert.ok(fs.existsSync(storeFile(s.dataDir)))
  assert.deepEqual(await s.get('/api/health'), { status: 'ok', engine: 'studio', live: true, setUp: false })
  const id = s.company.id
  for (const list of ['agents', 'projects', 'issues', 'routines', 'chats', 'live-runs', 'heartbeat-runs?limit=5', 'approvals', 'goals', 'skills', 'org', 'costs/window-spend', 'costs/by-agent']) {
    assert.deepEqual(await s.get(`/api/companies/${id}/${list}`), [], list)
  }
  assert.equal((await s.get(`/api/companies/${id}/attention`)).totalCount, 0)
  assert.equal((await s.get(`/api/companies/${id}/dashboard`)).tasks.open, 0)
  assert.equal((await s.get(`/api/companies/${id}/members`)).members[0].membershipRole, 'owner')
  assert.equal((await s.get(`/api/companies/${id}/timeline`)).events.length, 0)
  await s.engine.stop()

  // Opened again it is the same studio, not a second one.
  const again = await startEngine({ dataDir: s.dataDir, runs: false, log: quiet })
  assert.equal((await again.handle({ url: '/api/companies' })).body[0].id, id)
  await again.stop()
})

test('a studio is renamed and its job code chosen while it has no jobs; a second studio is refused', async () => {
  const s = await fresh()
  const id = s.company.id
  assert.equal((await s.call('POST', '/api/companies', { name: 'Another' })).status, 409)
  const named = await s.patch(`/api/companies/${id}`, { name: 'Night Owl Games', issuePrefix: 'nog', description: 'Small games' })
  assert.equal(named.name, 'Night Owl Games')
  assert.equal(named.issuePrefix, 'NOG')
  assert.equal((await s.call('PATCH', `/api/companies/${id}`, { issuePrefix: '9x' })).status, 400)
  assert.equal((await s.call('PATCH', `/api/companies/${id}`, { name: ' ' })).status, 400)
  const job = await s.post(`/api/companies/${id}/issues`, { title: 'First job' })
  assert.equal(job.identifier, 'NOG-1')
  assert.equal((await s.call('PATCH', `/api/companies/${id}`, { issuePrefix: 'OWL' })).status, 409, 'jobs carry the code now')
  assert.equal((await s.get(`/api/companies/${id}`)).issueCounter, 1)
  assert.equal(prefixFrom('Night Owl Games'), 'NOG')
  assert.equal(prefixFrom('Lighthouse'), 'LIG')
  assert.equal(prefixFrom('!!!'), 'STU')
  await s.engine.stop()
})

test('a store opened with no studio takes its first one through POST /companies', async () => {
  const { openStore } = await import('../server/engine/store.mjs')
  const { answer } = await import('../server/engine/api.mjs')
  const store = openStore(':memory:')
  assert.deepEqual(answer(store, { url: '/api/companies' }).body, [])
  assert.equal(answer(store, { method: 'POST', url: '/api/companies', body: {} }).status, 400)
  const made = answer(store, { method: 'POST', url: '/api/companies', body: { name: 'Lighthouse Works', issuePrefix: 'BW' } })
  assert.equal(made.status, 201)
  assert.equal(made.body.issuePrefix, 'BW')
  assert.equal(answer(store, { method: 'POST', url: '/api/companies', body: { name: 'A second' } }).status, 409)
  store.close()
})

test('a project is made with its repository, changed, given a second folder, and put away without losing anything', async () => {
  const s = await fresh()
  const id = s.company.id
  const folder = repo()
  assert.equal((await s.call('POST', `/api/companies/${id}/projects`, { name: '' })).status, 400)
  assert.equal((await s.call('POST', `/api/companies/${id}/projects`, { name: 'Game', workspace: { cwd: '/no/such/folder' } })).status, 400)
  assert.deepEqual(await s.get(`/api/companies/${id}/projects`), [], 'a refused project leaves nothing behind')
  const project = await s.post(`/api/companies/${id}/projects`, { name: 'Tide Tables', description: 'GOAL: ship part one', workspace: { cwd: folder } })
  assert.equal(project.urlKey, 'tide-tables')
  assert.equal(project.primaryWorkspace.cwd, folder)
  assert.equal(project.workspaces.length, 1)
  assert.equal(project.codebase.localFolder, folder)
  assert.equal((await s.call('POST', `/api/companies/${id}/projects`, { name: 'Tide Tables' })).status, 409)
  assert.equal((await s.get('/api/health')).setUp, true)

  const changed = await s.patch(`/api/projects/${project.id}`, { name: 'Tide Tables 2', description: 'GOAL: ship part two', color: '#3366ff' })
  assert.equal(changed.urlKey, 'tide-tables-2')
  assert.equal(changed.primaryWorkspace.cwd, folder, 'its folder stays when its name changes')
  assert.equal((await s.get(`/api/projects/${project.id}`)).description, 'GOAL: ship part two')

  const second = repo()
  const added = await s.post(`/api/projects/${project.id}/workspaces`, { cwd: second, name: 'tools', repoUrl: 'https://github.com/example/tools.git' })
  assert.equal(added.isPrimary, false)
  assert.equal((await s.call('POST', `/api/projects/${project.id}/workspaces`, { cwd: second })).status, 409)
  const promoted = await s.patch(`/api/projects/${project.id}/workspaces/${added.id}`, { isPrimary: true, repoRef: 'main' })
  assert.equal(promoted.isPrimary, true)
  let now = await s.get(`/api/projects/${project.id}`)
  assert.equal(now.primaryWorkspace.id, added.id)
  assert.equal(now.codebase.repoName, 'tools')
  assert.equal(now.workspaces.filter((w) => w.isPrimary).length, 1)
  await s.del(`/api/projects/${project.id}/workspaces/${added.id}`)
  now = await s.get(`/api/projects/${project.id}`)
  assert.equal(now.workspaces.length, 1)
  assert.equal(now.primaryWorkspace.cwd, folder, 'the folder that is left is the one jobs are cut from')
  assert.ok(fs.existsSync(second), 'the folder itself is not touched')

  const job = await s.post(`/api/companies/${id}/issues`, { title: 'A job', projectId: project.id })
  const away = await s.del(`/api/projects/${project.id}`)
  assert.ok(away.archivedAt)
  assert.equal((await s.get(`/api/companies/${id}/projects`)).length, 1, 'still listed, marked as put away')
  assert.equal((await s.get(`/api/issues/${job.id}`)).projectId, project.id)
  assert.equal((await s.call('POST', `/api/companies/${id}/issues`, { title: 'Another', projectId: project.id })).status, 400)
  assert.equal((await s.patch(`/api/projects/${project.id}`, { archived: false })).archivedAt, null)
  await s.engine.stop()
})

test('a document\'s older version is restored as a new version, and a save over a version someone else changed is refused', async () => {
  const s = await fresh()
  const job = await s.post(`/api/companies/${s.company.id}/issues`, { title: 'Plan it' })
  const v1 = await s.put(`/api/issues/${job.id}/documents/plan`, { title: 'Plan', body: 'first' })
  const v2 = await s.put(`/api/issues/${job.id}/documents/plan`, { body: 'second', baseRevisionId: v1.latestRevisionId })
  assert.equal(v2.latestRevisionNumber, 2)
  assert.equal((await s.call('PUT', `/api/issues/${job.id}/documents/plan`, { body: 'late', baseRevisionId: v1.latestRevisionId })).status, 409)
  const restored = await s.post(`/api/issues/${job.id}/documents/plan/revisions/${v1.latestRevisionId}/restore`)
  assert.equal(restored.body, 'first')
  assert.equal(restored.latestRevisionNumber, 3)
  const versions = await s.get(`/api/issues/${job.id}/documents/plan/revisions`)
  assert.deepEqual(versions.map((v) => v.body), ['first', 'second', 'first'])
  assert.match(versions[2].changeSummary, /Restored version 1/)
  assert.equal((await s.call('POST', `/api/issues/${job.id}/documents/plan/revisions/nope/restore`)).status, 404)
  assert.equal((await s.call('POST', `/api/issues/${job.id}/documents/other/revisions/${v1.latestRevisionId}/restore`)).status, 404)
  await s.engine.stop()
})

test('the engine listens on a port of this computer when given one, and answers the same calls there', async () => {
  const dataDir = path.join(tmp('port'), 'data')
  const engine = await startEngine({ dataDir, port: 0, runs: false, log: quiet })
  assert.match(engine.apiUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  const health = await (await fetch(`${engine.apiUrl}/api/health`)).json()
  assert.equal(health.engine, 'studio')
  const id = (await (await fetch(`${engine.apiUrl}/api/companies`)).json())[0].id
  const made = await fetch(`${engine.apiUrl}/api/companies/${id}/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Over the port' }) })
  assert.equal(made.status, 201)
  assert.equal((await engine.handle({ url: `/api/companies/${id}/issues` })).body[0].title, 'Over the port', 'the port and the in-process door are one engine')
  assert.equal((await fetch(`${engine.apiUrl}/api/nothing-here`)).status, 404)
  await engine.stop()
  await assert.rejects(fetch(`${engine.apiUrl}/api/health`), 'stopped means the port is closed')
})

test('the engine answers every call itself: an unknown path is refused here, and nothing of two engines is left in it', async () => {
  const s = await fresh()
  assert.equal((await s.call('GET', '/api/some/unknown/path')).status, 404)
  assert.equal((await s.call('POST', `/api/companies/${s.company.id}/issues`, { title: 'Mine' })).status, 201)
  const dir = new URL('../server/engine/', import.meta.url)
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    assert.equal(/engine_live|isLive|fetch\(/.exec(fs.readFileSync(new URL(file, dir), 'utf8'))?.[0], undefined, `${file} still knows of another engine`)
  }
  await s.engine.stop()
})

test('every name a run or a folder is given comes from one module', () => {
  const vars = runVars({ apiUrl: 'http://x', apiKey: 'k', runId: 'r', jobId: 'j', botId: 'b', studioId: 's' })
  assert.equal(vars[RUN_VARS.apiUrl], 'http://x')
  assert.equal(vars[RUN_VARS.jobId], 'j')
  assert.equal(vars[RUN_VARS.branch], '', 'what is not given is empty, never "undefined"')
  assert.equal(Object.keys(vars).length, Object.keys(RUN_VARS).length + 1)
  assert.ok(worktreeDir('/repo', 'STU-1-x').startsWith('/repo/'))
  assert.ok(botSecretsFile('/data').startsWith('/data/keys/'))
  // No other engine file writes one of these names out by hand.
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'engine')
  const byHand = /BOTYARD_(API_URL|API_KEY|RUN_ID|JOB_ID|BOT_ID|ID\b|WAKE|WORKSPACE|SCRATCH|RESOLVED|HOME|MAY_NOT)|'.botyard'|'worktrees'|'run-logs'|'studio\.db'|\.botyard/
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'names.mjs')) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    assert.equal(byHand.exec(code)?.[0], undefined, `${file} writes a name out by hand`)
  }
})
