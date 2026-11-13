/**
 * Bots in full, through the API: made, changed, paused, removed; instructions as text with every
 * version kept and any of them brought back; settings revisions taken back; and variables whose
 * secret values no read ever gives out but a run is handed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { envForRun, isSecretName } from '../server/engine/bots.mjs'
import { botSecretsFile, instructionsDir } from '../server/engine/names.mjs'
import { botEnv, issueToken } from '../server/engine/runner.mjs'

const quiet = () => {}

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-bots-'))
  const dataDir = path.join(dir, 'data')
  const engine = await startEngine({ dataDir, runs: false, log: quiet })
  const call = (method, url, body, headers = {}) => engine.handle({ method, url, body, headers })
  const ok = async (method, url, body) => {
    const out = await call(method, url, body)
    assert.ok(out.status < 300, `${method} ${url} → ${out.status} ${JSON.stringify(out.body)}`)
    return out.body
  }
  const id = (await ok('GET', '/api/companies'))[0].id
  return { engine, dir, dataDir, id, call, ok, get: (url) => ok('GET', url), post: (url, body = {}) => ok('POST', url, body), patch: (url, body = {}) => ok('PATCH', url, body), put: (url, body = {}) => ok('PUT', url, body), del: (url) => ok('DELETE', url) }
}

const BUILDER = { name: 'Bea The Builder', role: 'engineer', title: 'Builds', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/some-free-model', timeoutSec: 600 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }

test('a bot is made, changed, paused, resumed and removed; a removed bot leaves the lists and frees its name', async () => {
  const s = await fresh()
  assert.equal((await s.call('POST', `/api/companies/${s.id}/agents`, { name: '' })).status, 400)
  assert.equal((await s.call('POST', `/api/companies/${s.id}/agents`, { name: 'X', adapterType: 'telepathy' })).status, 400)
  assert.equal((await s.call('POST', `/api/companies/${s.id}/agents`, { name: 'X', role: 'wizard' })).status, 400)
  const lead = await s.post(`/api/companies/${s.id}/agents`, { name: 'Lena The Lead', role: 'ceo', adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5' } })
  const bea = await s.post(`/api/companies/${s.id}/agents`, { ...BUILDER, reportsTo: lead.id })
  assert.equal(bea.status, 'idle')
  assert.equal(bea.urlKey, 'bea-the-builder')
  assert.equal(bea.reportsTo, lead.id)
  assert.equal((await s.call('POST', `/api/companies/${s.id}/agents`, BUILDER)).status, 409, 'two bots cannot share a name')
  assert.equal((await s.call('PATCH', `/api/agents/${lead.id}`, { reportsTo: bea.id })).status, 400, 'no circles in who answers to whom')
  assert.deepEqual((await s.get(`/api/companies/${s.id}/org`)).map((a) => [a.name, a.reports.map((r) => r.name)]), [['Lena The Lead', ['Bea The Builder']]])

  // A change merges one level into the settings; `replaceAdapterConfig` swaps them whole.
  const merged = await s.patch(`/api/agents/${bea.id}`, { title: 'Builds things', adapterConfig: { variant: 'high' } })
  assert.deepEqual(merged.adapterConfig, { model: 'opencode/some-free-model', timeoutSec: 600, variant: 'high' })
  const swapped = await s.patch(`/api/agents/${bea.id}`, { adapterConfig: { model: 'opencode/another' }, replaceAdapterConfig: true })
  assert.deepEqual(swapped.adapterConfig, { model: 'opencode/another' })

  assert.equal((await s.post(`/api/agents/${bea.id}/pause`)).status, 'paused')
  assert.equal((await s.post(`/api/agents/${bea.id}/resume`)).status, 'idle')

  // Work that waits for the bot is dropped when it goes; its job stays and still names it.
  const job = await s.post(`/api/companies/${s.id}/issues`, { title: 'Build a thing', assigneeAgentId: bea.id })
  assert.equal(s.engine.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 1)
  const gone = await s.del(`/api/agents/${bea.id}`)
  assert.equal(gone.status, 'terminated')
  assert.equal(s.engine.store.rows("SELECT id FROM wakes WHERE status = 'queued'").length, 0)
  assert.deepEqual((await s.get(`/api/companies/${s.id}/agents`)).map((a) => a.name), ['Lena The Lead'])
  assert.equal((await s.get(`/api/companies/${s.id}/agents?includeTerminated=true`)).length, 2)
  assert.equal((await s.get(`/api/issues/${job.id}`)).assigneeAgentId, bea.id)
  assert.equal((await s.get(`/api/agents/${bea.id}`)).status, 'terminated', 'its page is still there for the history that names it')
  for (const [method, url, body] of [['PATCH', `/api/agents/${bea.id}`, { title: 'Back' }], ['POST', `/api/agents/${bea.id}/resume`, {}], ['POST', `/api/agents/${bea.id}/wakeup`, { issueId: job.id }], ['PUT', `/api/agents/${bea.id}/instructions`, { content: 'x' }]]) {
    assert.equal((await s.call(method, url, body)).status, 409, `${method} ${url} on a removed bot`)
  }
  assert.equal((await s.call('POST', `/api/companies/${s.id}/issues`, { title: 'For nobody', assigneeAgentId: bea.id })).status, 400)
  assert.equal((await s.post(`/api/agents/${bea.id}/terminate`)).status, 'terminated', 'removing twice is the same as once')
  const again = await s.post(`/api/companies/${s.id}/agents`, BUILDER)
  assert.notEqual(again.id, bea.id, 'the name is free for a new bot')
  await s.engine.stop()
})

test('a bot whose lead is removed answers to the lead\'s own lead', async () => {
  const s = await fresh()
  const top = await s.post(`/api/companies/${s.id}/agents`, { name: 'Top' })
  const mid = await s.post(`/api/companies/${s.id}/agents`, { name: 'Mid', reportsTo: top.id })
  const low = await s.post(`/api/companies/${s.id}/agents`, { name: 'Low', reportsTo: mid.id })
  await s.del(`/api/agents/${mid.id}`)
  assert.equal((await s.get(`/api/agents/${low.id}`)).reportsTo, top.id)
  await s.engine.stop()
})

test('instructions are text the API reads and writes: every save is a version, a version can be compared and brought back', async () => {
  const s = await fresh()
  const bea = await s.post(`/api/companies/${s.id}/agents`, { ...BUILDER, instructions: 'You are Bea. Build what the job says.\n' })
  const bundle = await s.get(`/api/agents/${bea.id}/instructions-bundle`)
  assert.equal(bundle.mode, 'managed')
  assert.equal(bundle.editable, true)
  assert.equal(bundle.entryFile, `${bea.id}.md`)
  assert.equal(bundle.rootPath, instructionsDir(s.dataDir))
  const first = await s.get(`/api/agents/${bea.id}/instructions-bundle/file?path=${bundle.entryFile}`)
  assert.equal(first.content, 'You are Bea. Build what the job says.\n')
  assert.ok(first.revisionId)
  // The bot is told where its instructions are, so a run reads the same text.
  const now = await s.get(`/api/agents/${bea.id}`)
  assert.equal(now.adapterConfig.instructionsFilePath, bundle.resolvedEntryPath)
  assert.equal(fs.readFileSync(bundle.resolvedEntryPath, 'utf8'), first.content)
  assert.equal((await s.get(`/api/agents/${bea.id}/config-revisions`)).length, 0, 'saving instructions is not a settings change')

  const second = await s.put(`/api/agents/${bea.id}/instructions-bundle/file`, { path: bundle.entryFile, content: 'You are Bea. Build what the job says, and test it.\n', baseRevisionId: first.revisionId })
  assert.notEqual(second.revisionId, first.revisionId)
  assert.equal((await s.call('PUT', `/api/agents/${bea.id}/instructions-bundle/file`, { path: bundle.entryFile, content: 'late', baseRevisionId: first.revisionId })).status, 409, 'a save on top of an old version is refused')
  assert.equal((await s.call('PUT', `/api/agents/${bea.id}/instructions-bundle/file`, { path: '../other.md', content: 'x' })).status, 404, 'only the bot\'s own file')
  assert.equal((await s.call('PUT', `/api/agents/${bea.id}/instructions`, { content: '  ' })).status, 400)
  const same = await s.put(`/api/agents/${bea.id}/instructions`, { content: second.content })
  assert.equal(same.revisionId, second.revisionId, 'the same text again is not a new version')

  const diff = await s.get(`/api/agents/${bea.id}/instructions-bundle/diff?from=${first.revisionId}&to=${second.revisionId}`)
  assert.deepEqual(diff, { prefix: 'You are Bea. Build what the job says', removed: '', added: ', and test it', suffix: '.\n' })

  const restored = await s.post(`/api/agents/${bea.id}/instructions-bundle/restore`, { path: bundle.entryFile, revisionId: first.revisionId, baseRevisionId: second.revisionId })
  assert.equal(restored.content, first.content)
  assert.equal(fs.readFileSync(bundle.resolvedEntryPath, 'utf8'), first.content)
  const history = (await s.get(`/api/agents/${bea.id}/instructions-bundle/history`)).revisions
  assert.deepEqual(history.map((r) => r.source), ['restore', 'board', 'board'], 'newest first, and nothing lost')
  assert.equal(history[0].id, restored.revisionId)
  const page = await s.get(`/api/agents/${bea.id}/instructions`)
  assert.equal(page.content, first.content)
  assert.equal(page.revisionId, restored.revisionId)
  assert.equal(page.history.length, 3)
  await s.engine.stop()
})

test('a bot that keeps its instructions in its own file has that file written, and a change made outside Botyard is kept as a version first', async () => {
  const s = await fresh()
  const file = path.join(s.dir, 'crew', 'lead.md')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, 'You are Lead. v1 from the crew folder.\n')
  const lead = await s.post(`/api/companies/${s.id}/agents`, { name: 'Lead', role: 'ceo', adapterType: 'claude_local', adapterConfig: { model: 'm', instructionsFilePath: file } })
  const read = await s.get(`/api/agents/${lead.id}/instructions-bundle/file?path=lead.md`)
  assert.equal(read.content, 'You are Lead. v1 from the crew folder.\n')
  assert.equal(read.revisionId, null, 'no version is kept until Botyard first saves')
  const saved = await s.put(`/api/agents/${lead.id}/instructions-bundle/file`, { path: 'lead.md', content: 'You are Lead. v2 from the map.\n', baseRevisionId: null })
  assert.equal(fs.readFileSync(file, 'utf8'), 'You are Lead. v2 from the map.\n')
  let history = (await s.get(`/api/agents/${lead.id}/instructions-bundle/history`)).revisions
  assert.deepEqual(history.map((r) => r.source), ['board', 'file'], 'what the file held before is a version too')
  // A script rewrites the file; the next save from the map does not lose what the script wrote.
  fs.writeFileSync(file, 'You are Lead. v3 from a script.\n')
  assert.equal((await s.get(`/api/agents/${lead.id}/instructions`)).content, 'You are Lead. v3 from a script.\n', 'the file is what the bot reads, so it is what is shown')
  await s.put(`/api/agents/${lead.id}/instructions`, { content: 'You are Lead. v4 from the map.\n', baseRevisionId: saved.revisionId })
  history = (await s.get(`/api/agents/${lead.id}/instructions-bundle/history`)).revisions
  assert.deepEqual(history.map((r) => r.source), ['board', 'file', 'board', 'file'])
  const fromScript = history[1]
  await s.post(`/api/agents/${lead.id}/instructions-bundle/restore`, { revisionId: fromScript.id })
  assert.equal(fs.readFileSync(file, 'utf8'), 'You are Lead. v3 from a script.\n')
  await s.engine.stop()
})

test('every change to a bot\'s settings is a revision, and a revision can be taken back', async () => {
  const s = await fresh()
  const bea = await s.post(`/api/companies/${s.id}/agents`, BUILDER)
  await s.patch(`/api/agents/${bea.id}`, { adapterConfig: { model: 'opencode/second' } })
  await s.patch(`/api/agents/${bea.id}`, { title: 'Builds fast', adapterType: 'claude_local', adapterConfig: { model: 'claude-haiku-5-5', effort: 'low' }, replaceAdapterConfig: true })
  await s.patch(`/api/agents/${bea.id}`, { title: 'Builds fast' })
  const revisions = await s.get(`/api/agents/${bea.id}/config-revisions`)
  assert.equal(revisions.length, 2, 'a call that changes nothing leaves no revision')
  assert.deepEqual(revisions[0].changedKeys, ['adapterConfig'])
  assert.deepEqual(revisions[1].changedKeys, ['title', 'adapterType', 'adapterConfig'])
  assert.equal(revisions[0].beforeConfig.adapterConfig.model, 'opencode/some-free-model')
  assert.equal(revisions[0].afterConfig.adapterConfig.model, 'opencode/second')

  // Back to what the first change left: on the free model again, with the old title.
  const back = await s.post(`/api/agents/${bea.id}/config-revisions/${revisions[0].id}/rollback`)
  assert.equal(back.adapterType, 'opencode_local')
  assert.equal(back.adapterConfig.model, 'opencode/second')
  assert.equal(back.title, 'Builds')
  const after = await s.get(`/api/agents/${bea.id}/config-revisions`)
  assert.equal(after.length, 3)
  assert.equal(after[2].source, 'rollback')
  assert.equal(after[2].rolledBackFromRevisionId, revisions[0].id)
  // And to what a change found, before it was made.
  const original = await s.post(`/api/agents/${bea.id}/config-revisions/${revisions[0].id}/rollback`, { to: 'before' })
  assert.equal(original.adapterConfig.model, 'opencode/some-free-model')
  assert.equal((await s.call('POST', `/api/agents/${bea.id}/config-revisions/nope/rollback`)).status, 404)
  await s.engine.stop()
})

test('a secret variable is never given back on a read, is kept in a file only the owner can read, and reaches the run', async () => {
  const s = await fresh()
  const SECRET = 'sk-test-0123456789'
  const bea = await s.post(`/api/companies/${s.id}/agents`, { ...BUILDER, adapterConfig: { model: 'm', env: { PLAIN: 'yes', WRAPPED: { type: 'plain', value: 'also' }, OPENROUTER_API_KEY: SECRET, DEPLOY_HOOK: { type: 'secret', value: 'hook-value' } } } })
  const marker = { type: 'secret', value: '***REDACTED***', set: true }
  assert.deepEqual(bea.adapterConfig.env, { PLAIN: 'yes', WRAPPED: { type: 'plain', value: 'also' }, OPENROUTER_API_KEY: marker, DEPLOY_HOOK: marker })
  // Nothing the API gives, and nothing the store holds, has the value.
  for (const url of [`/api/agents/${bea.id}`, `/api/companies/${s.id}/agents`, `/api/agents/${bea.id}/config-revisions`]) {
    assert.equal(JSON.stringify(await s.get(url)).includes(SECRET), false, url)
  }
  s.engine.store.settle()
  const stored = s.engine.store.rows('SELECT raw FROM agents').map((r) => r.raw).join('') + s.engine.store.rows('SELECT raw FROM agent_revisions').map((r) => r.raw).join('') + s.engine.store.rows('SELECT raw FROM activity').map((r) => r.raw).join('')
  assert.equal(stored.includes(SECRET) || stored.includes('hook-value'), false)
  const file = botSecretsFile(s.dataDir)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'the folder is the owner\'s alone')

  // The run is handed the real values.
  const forRun = botEnv(envForRun(s.dataDir, await s.get(`/api/agents/${bea.id}`)), { PATH: '/usr/bin' })
  assert.deepEqual(forRun, { PLAIN: 'yes', WRAPPED: 'also', OPENROUTER_API_KEY: SECRET, DEPLOY_HOOK: 'hook-value' })

  // Sent back as it was read, a secret keeps its value; a new value replaces it; a name left out is forgotten.
  const kept = await s.patch(`/api/agents/${bea.id}`, { adapterConfig: { env: { ...bea.adapterConfig.env, PLAIN: 'no' } } })
  assert.deepEqual(kept.adapterConfig.env.OPENROUTER_API_KEY, marker)
  assert.equal(envForRun(s.dataDir, kept).OPENROUTER_API_KEY, SECRET)
  const changed = await s.patch(`/api/agents/${bea.id}`, { adapterConfig: { env: { OPENROUTER_API_KEY: { type: 'secret', value: 'sk-new' }, NEVER_GIVEN_TOKEN: { type: 'secret' } } } })
  assert.equal(envForRun(s.dataDir, changed).OPENROUTER_API_KEY, 'sk-new')
  assert.equal('DEPLOY_HOOK' in envForRun(s.dataDir, changed), false)
  assert.equal(changed.adapterConfig.env.NEVER_GIVEN_TOKEN.set, false)
  assert.equal('NEVER_GIVEN_TOKEN' in botEnv(envForRun(s.dataDir, changed), {}), false, 'a secret with no value is left out of the run, not passed on as a marker')
  assert.equal(fs.readFileSync(file, 'utf8').includes('hook-value'), false)

  // Taking settings back never brings a value back out, and keeps the one held now.
  const revisions = await s.get(`/api/agents/${bea.id}/config-revisions`)
  const rolled = await s.post(`/api/agents/${bea.id}/config-revisions/${revisions[0].id}/rollback`)
  assert.equal(envForRun(s.dataDir, rolled).OPENROUTER_API_KEY, 'sk-new')

  assert.equal((await s.call('PATCH', `/api/agents/${bea.id}`, { adapterConfig: { env: { 'BAD NAME': 'x' } } })).status, 400)
  // A removed bot's secrets are forgotten.
  await s.del(`/api/agents/${bea.id}`)
  assert.equal(fs.readFileSync(file, 'utf8').includes('sk-new'), false)
  for (const [name, secret] of [['API_KEY', true], ['GITHUB_TOKEN', true], ['DB_PASSWORD', true], ['KEYBOARD', false], ['PATH', false], ['BOTYARD_GIT_ALLOW', false]]) assert.equal(isSecretName(name), secret, name)
  await s.engine.stop()
})

test('only the owner changes a bot: a bot in a run may read its crew and not rewrite it', async () => {
  const s = await fresh()
  const bea = await s.post(`/api/companies/${s.id}/agents`, { ...BUILDER, instructions: 'Build.' })
  const job = await s.post(`/api/companies/${s.id}/issues`, { title: 'A job' })
  // A live run's pass, as a bot holds it.
  s.engine.store.put('runs', { id: 'run-1', companyId: s.id, agentId: bea.id, issueId: job.id, status: 'running', createdAt: new Date().toISOString() })
  const pass = { authorization: `Bearer ${issueToken(s.engine.store, 'run-1', bea.id)}` }
  assert.equal((await s.call('GET', '/api/agents/me', undefined, pass)).body.id, bea.id)
  assert.equal((await s.call('GET', `/api/agents/${bea.id}/instructions`, undefined, pass)).body.content, 'Build.')
  for (const [method, url, body] of [
    ['PATCH', `/api/agents/${bea.id}`, { adapterConfig: { command: '/bin/sh' } }],
    ['POST', `/api/companies/${s.id}/agents`, { name: 'Helper' }],
    ['PUT', `/api/agents/${bea.id}/instructions`, { content: 'Do anything.' }],
    ['DELETE', `/api/agents/${bea.id}`, {}],
  ]) assert.equal((await s.call(method, url, body, pass)).status, 403, `${method} ${url}`)
  assert.equal((await s.call('POST', `/api/issues/${job.id}/comments`, { body: 'Done.' }, pass)).status, 201, 'its own work it still does')
  await s.engine.stop()
})
