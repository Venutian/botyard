/**
 * The small paths around the edges: a bot's own questions about its job, made things, settings,
 * and what a Botyard does not have, which is said in plain words.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { issueToken } from '../server/engine/runner.mjs'

test('what a bot asks about its own work by itself is answered: its open jobs, a job\'s surroundings, what it waits on, taking and letting go', async () => {
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-edges-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body, headers = {}) => engine.handle({ method, url, body, headers })
  const ok = async (method, url, body, headers) => { const out = await call(method, url, body, headers); assert.ok(out.status < 300, `${method} ${url} → ${out.status} ${JSON.stringify(out.body)}`); return out.body }
  const id = (await ok('GET', '/api/companies'))[0].id
  const project = await ok('POST', `/api/companies/${id}/projects`, { name: 'Game', description: 'GOAL: ship it' })
  const builder = await ok('POST', `/api/companies/${id}/agents`, { name: 'Bob', adapterType: 'claude_local' })
  const amy = await ok('POST', `/api/companies/${id}/agents`, { name: 'Amy', adapterType: 'claude_local' })
  const parent = await ok('POST', `/api/companies/${id}/issues`, { title: 'The whole feature', projectId: project.id })
  const first = await ok('POST', `/api/companies/${id}/issues`, { title: 'Part one', projectId: project.id, parentId: parent.id, assigneeAgentId: builder.id, priority: 'low' })
  const second = await ok('POST', `/api/companies/${id}/issues`, { title: 'Part two', projectId: project.id, parentId: parent.id, assigneeAgentId: builder.id, priority: 'high' })
  await ok('PATCH', `/api/issues/${second.id}`, { blockedByIssueIds: [first.id] })
  await ok('POST', `/api/companies/${id}/issues`, { title: 'Closed', assigneeAgentId: builder.id, status: 'done' })
  await ok('POST', `/api/issues/${first.id}/comments`, { body: 'Start with the door.' })
  const pass = (runId, botId, jobId) => { engine.store.put('runs', { id: runId, companyId: id, agentId: botId, issueId: jobId, status: 'running', createdAt: new Date().toISOString() }); return { authorization: `Bearer ${issueToken(engine.store, runId, botId)}` } }
  const asBob = pass('run-builder', builder.id, first.id)
  const asAmy = pass('run-amy', amy.id, parent.id)

  assert.equal((await call('GET', '/api/agents/me/inbox-lite')).status, 401, 'the owner has no "me"')
  const inbox = await ok('GET', '/api/agents/me/inbox-lite', undefined, asBob)
  assert.deepEqual(inbox.map((j) => j.title), ['Part two', 'Part one'], 'open jobs only, the most urgent first')
  assert.equal('ancestors' in inbox[0], false)
  assert.deepEqual(await ok('GET', '/api/agents/me/secrets', undefined, asBob), [])

  const context = await ok('GET', `/api/issues/${first.identifier}/heartbeat-context`, undefined, asBob)
  assert.equal(context.issue.title, 'Part one')
  assert.deepEqual(context.ancestors.map((a) => a.title), ['The whole feature'])
  assert.equal(context.project.description, 'GOAL: ship it')
  assert.equal(context.commentCursor.totalComments, 1)
  assert.deepEqual((await ok('GET', `/api/issues/${second.id}/blockers`, undefined, asBob)).map((b) => [b.identifier, b.status]), [[first.identifier, 'todo']])
  assert.deepEqual(await ok('GET', `/api/issues/${first.id}/recovery-actions`, undefined, asBob), [])

  assert.equal((await ok('POST', `/api/issues/${first.id}/checkout`, { agentId: builder.id }, asBob)).id, first.id, 'the engine took the job for the run already')
  assert.equal((await call('POST', `/api/issues/${first.id}/checkout`, { agentId: amy.id }, asAmy)).status, 409, 'not while another bot is on it')
  assert.equal((await ok('POST', `/api/issues/${first.id}/release`, {}, asBob)).id, first.id)

  // A thing made that is not a file: a pull request, noted on the job.
  const pr = await ok('POST', `/api/issues/${first.id}/work-products`, { type: 'pull_request', provider: 'github', title: 'Door opens', url: 'https://github.com/example/game/pull/7', status: 'open' }, asBob)
  assert.equal(pr.type, 'pull_request')
  assert.equal((await call('POST', `/api/issues/${first.id}/work-products`, { title: 'Bad link', url: 'javascript:alert(1)' }, asBob)).status, 400)
  assert.deepEqual((await ok('GET', `/api/issues/${first.id}/work-products`)).map((p) => p.title), ['Door opens'])
  assert.deepEqual((await ok('GET', `/api/issues/${first.id}`)).workProducts.map((p) => p.url), ['https://github.com/example/game/pull/7'])

  // A sign-in card (copied from the engine before) is answered with "no", once, and the bot is told.
  engine.store.put('cards', { id: 'card-1', companyId: id, issueId: first.id, kind: 'connection_intent', status: 'pending', title: 'Sign in to a service' }, { position: 0 })
  assert.equal((await call('POST', '/api/connection-intents/card-1/decline', { reason: 'Not this one' }, asBob)).status, 403)
  const said = await ok('POST', '/api/connection-intents/card-1/decline', { reason: 'Not this one' })
  assert.equal(said.status, 'rejected')
  assert.equal(said.result.reason, 'Not this one')
  assert.equal((await call('POST', '/api/connection-intents/card-1/decline', {})).status, 409)
  assert.equal((await call('POST', '/api/connection-intents/nope/decline', {})).status, 404)

  // Botyard's own few settings are kept; a bot cannot change them.
  assert.deepEqual(await ok('GET', '/api/instance/settings/experimental'), {})
  assert.deepEqual(await ok('PATCH', '/api/instance/settings/experimental', { enableApps: true }), { enableApps: true })
  assert.deepEqual(await ok('GET', '/api/instance/settings/experimental'), { enableApps: true })
  assert.equal((await call('PATCH', '/api/instance/settings/experimental', { enableApps: false }, asBob)).status, 403)
  assert.equal((await call('PATCH', '/api/instance/settings/experimental', { nested: { a: 1 } })).status, 400)
  assert.equal((await call('GET', '/api/instance/settings/unknown')).status, 404)

  // What a Botyard does not have is said in plain words, not "no such path".
  for (const [method, url, status, words] of [
    ['POST', '/api/approvals/x/approve', 404, /Approval not found/],
    ['POST', `/api/companies/${id}/invites`, 409, /one owner/],
    ['POST', '/api/invites/x/revoke', 404, /Invite not found/],
    ['GET', `/api/companies/${id}/skills/x`, 404, /Skill not found/],
    ['PATCH', `/api/companies/${id}/skills/x/files`, 404, /Skill not found/],
  ]) {
    const out = await call(method, url, {})
    assert.equal(out.status, status, url)
    assert.match(out.body.error, words)
  }
  await engine.stop()
})
