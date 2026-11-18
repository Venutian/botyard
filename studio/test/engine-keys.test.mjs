/**
 * The engine's port tells its callers apart: a bot by its run's pass, the owner's side of Botyard by
 * the owner key, a crew script by the scripts key and its name. A page elsewhere is refused whatever
 * it sends. Only the owner answers a card. The keys roll out in two steps: "log" keeps a call with no
 * key working and writes down who made it, "enforce" refuses it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { OWNER_KEY_FILE, SCRIPTS_KEY_FILE, callerOf, ownerKeyHeaders } from '../server/engine/caller.mjs'
import { startEngine } from '../server/engine/main.mjs'
import { issueToken } from '../server/engine/runner.mjs'
import { fromThisComputer, notFromHere } from '../server/lib/local-call.mjs'

async function yard(keyMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-keys-'))
  const dataDir = path.join(root, 'data')
  const keysDir = path.join(root, 'keys')
  const lines = []
  const engine = await startEngine({ dataDir, port: 0, runs: false, log: (line) => lines.push(line), keysDir, keyMode })
  const port = engine.server.address().port
  const key = (name) => fs.readFileSync(path.join(keysDir, name), 'utf8').trim()
  /** A call to the port with the headers given, Host and all. */
  const ask = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...headers } }, (res) => {
      let got = ''
      res.on('data', (c) => { got += c })
      res.on('end', () => resolve({ status: res.statusCode, body: got ? JSON.parse(got) : null }))
    })
    req.on('error', reject)
    req.end(text)
  })
  const owner = () => ({ 'x-botyard-key': key(OWNER_KEY_FILE) })
  const script = (name) => ({ 'x-botyard-key': key(SCRIPTS_KEY_FILE), 'x-botyard-script': name })
  const id = (await ask('GET', '/api/companies', undefined, owner())).body[0].id
  const bot = (await ask('POST', `/api/companies/${id}/agents`, { name: 'Ada', adapterType: 'claude_local' }, owner())).body
  const job = (await ask('POST', `/api/companies/${id}/issues`, { title: 'Ship the door', assigneeAgentId: bot.id }, owner())).body
  engine.store.put('runs', { id: 'run-1', companyId: id, agentId: bot.id, issueId: job.id, status: 'running', createdAt: new Date().toISOString() })
  const pass = { authorization: `Bearer ${issueToken(engine.store, 'run-1', bot.id)}` }
  const card = async () => (await ask('POST', `/api/issues/${job.id}/interactions`, { kind: 'request_confirmation', title: 'Merge it?' }, pass)).body
  return { engine, ask, owner, script, pass, id, bot, job, card, lines, dataDir, keysDir, port }
}

test('the keys are made on the first start, readable by this user alone', async () => {
  const s = await yard('log')
  for (const name of [OWNER_KEY_FILE, SCRIPTS_KEY_FILE]) {
    const stat = fs.statSync(path.join(s.keysDir, name))
    assert.equal(stat.mode & 0o777, 0o600, name)
    assert.ok(fs.readFileSync(path.join(s.keysDir, name), 'utf8').trim().length >= 40)
  }
  assert.equal((fs.statSync(s.keysDir).mode & 0o777), 0o700)
  assert.deepEqual(Object.keys(ownerKeyHeaders(s.keysDir)), ['x-botyard-key'])
  await s.engine.stop()
})

test('a foreign Host or a page elsewhere gets 403, whatever key it carries', async () => {
  const s = await yard('log')
  const away = await s.ask('GET', `/api/companies/${s.id}/agents`, undefined, { host: 'evil.example', ...s.owner() })
  assert.equal(away.status, 403)
  assert.match(away.body.error, /another name/)
  const rebound = await s.ask('GET', '/api/companies', undefined, { host: `evil.example:${s.port}` })
  assert.equal(rebound.status, 403)
  const posted = await s.ask('POST', `/api/issues/${s.job.id}/comments`, { body: 'hi' }, { origin: 'https://evil.example', ...s.owner() })
  assert.equal(posted.status, 403)
  assert.match(posted.body.error, /page elsewhere/)
  const tunnelled = await s.ask('GET', '/api/companies', undefined, { 'x-forwarded-for': '1.2.3.4', ...s.owner() })
  assert.equal(tunnelled.status, 403)
  // This computer's own names, and a page on this computer, are fine.
  assert.equal((await s.ask('GET', '/api/companies', undefined, { host: `localhost:${s.port}`, origin: 'http://127.0.0.1:5274', ...s.owner() })).status, 200)
  await s.engine.stop()
})

test('a bot\'s pass, a script\'s key and no key at all cannot settle a human-only card; the owner key can', async () => {
  const s = await yard('enforce')
  const card = await s.card()
  assert.equal(card.resolverPolicy, 'human_only')
  const settle = (headers) => s.ask('POST', `/api/issues/${s.job.id}/interactions/${card.id}/accept`, {}, headers)
  const asBot = await settle(s.pass)
  assert.equal(asBot.status, 403)
  assert.match(asBot.body.error, /Only the owner answers a card/)
  const asScript = await settle(s.script('review-guard'))
  assert.equal(asScript.status, 403)
  assert.match(asScript.body.error, /a script may not/)
  const bare = await settle({})
  assert.equal(bare.status, 401)
  assert.equal((await settle({ 'x-botyard-key': 'not-a-key' })).status, 401)
  const asOwner = await settle(s.owner())
  assert.equal(asOwner.status, 200)
  assert.equal(asOwner.body.status, 'accepted')
  assert.equal(asOwner.body.resolvedByUserId, 'local-board')
  await s.engine.stop()
})

test('a script\'s comment and job show as script:<name>, never as the owner', async () => {
  const s = await yard('enforce')
  const said = await s.ask('POST', `/api/issues/${s.job.id}/comments`, { body: 'The crew check found 2 things.' }, s.script('health.py'))
  assert.equal(said.status, 201)
  assert.equal(said.body.authorUserId, 'script:health')
  assert.equal(said.body.authorAgentId, null)
  const made = await s.ask('POST', `/api/companies/${s.id}/issues`, { title: 'Fix the door' }, s.script('Waiting-Scan'))
  assert.equal(made.body.createdByUserId, 'script:waiting-scan')
  // A name that is not a name is kept as "unnamed", not passed on.
  const odd = await s.ask('POST', `/api/issues/${s.job.id}/comments`, { body: 'x' }, s.script('../../etc'))
  assert.equal(odd.body.authorUserId, 'script:unnamed')
  // The owner's side is the owner.
  assert.equal((await s.ask('POST', `/api/issues/${s.job.id}/comments`, { body: 'Yes.' }, s.owner())).body.authorUserId, 'local-board')
  // A script may seed a bot from the crew's files; a bot may not change one.
  assert.equal((await s.ask('PATCH', `/api/agents/${s.bot.id}`, { title: 'Builder' }, s.script('setup-bots'))).status, 200)
  assert.equal((await s.ask('PATCH', `/api/agents/${s.bot.id}`, { title: 'Boss' }, s.pass)).status, 403)
  // Only the owner changes Botyard's settings.
  assert.equal((await s.ask('PATCH', '/api/instance/settings/general', { x: 1 }, s.script('token-guard'))).status, 403)
  await s.engine.stop()
})

test('enforced: a call with no key is refused, and a write must say it is JSON', async () => {
  const s = await yard('enforce')
  const bare = await s.ask('GET', '/api/companies')
  assert.equal(bare.status, 401)
  assert.match(bare.body.error, /pass, or the owner's or a script's key/)
  assert.equal((await s.ask('GET', '/api/health', undefined, s.script('ping'))).status, 200)
  const plain = await s.ask('POST', `/api/issues/${s.job.id}/comments`, '{"body":"hi"}', { ...s.owner(), 'content-type': 'text/plain', 'content-length': 13 })
  assert.equal(plain.status, 415)
  // A bot's own calls are as before.
  assert.equal((await s.ask('GET', '/api/agents/me', undefined, s.pass)).status, 200)
  await s.engine.stop()
})

test('logging: a call with no key still works, is written down once with the process that made it, and a script answering a card is noted', async () => {
  const s = await yard('log')
  const bare = await s.ask('GET', `/api/companies/${s.id}/agents`)
  assert.equal(bare.status, 200)
  await s.ask('GET', `/api/companies/${s.id}/agents`)
  const plain = await s.ask('POST', `/api/issues/${s.job.id}/comments`, '{"body":"hi"}', { 'content-type': 'text/plain', 'content-length': 13 })
  assert.equal(plain.status, 201)
  const log = fs.readFileSync(path.join(s.dataDir, 'engine-callers.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const noKey = log.filter((line) => line.why === 'no key' && line.method === 'GET')
  assert.equal(noKey.length, 1, 'the same process and path are written once')
  assert.equal(noKey[0].path, '/api/companies/:id/agents')
  assert.match(noKey[0].who, /node/, 'the process that called is named')
  assert.ok(log.some((line) => /not JSON/.test(line.why)))
  const card = await s.card()
  const asScript = await s.ask('POST', `/api/issues/${s.job.id}/interactions/${card.id}/accept`, {}, s.script('land-approved'))
  assert.equal(asScript.status, 200, 'allowed while the keys roll out')
  assert.ok(s.lines.some((line) => /would refuse: script:land-approved answers a card/.test(line)))
  await s.engine.stop()
})

test('callerOf and the page port\'s check agree with the engine\'s', () => {
  const keys = { owner: 'o'.repeat(43), scripts: 's'.repeat(43) }
  assert.deepEqual(callerOf({ authorization: 'Bearer abc' }, keys), { kind: 'pass' })
  assert.deepEqual(callerOf({ 'x-botyard-key': keys.owner }, keys), { kind: 'owner' })
  assert.deepEqual(callerOf({ 'x-botyard-key': keys.scripts, 'x-botyard-script': 'Free-Fill.py' }, keys), { kind: 'script', script: 'free-fill' })
  assert.deepEqual(callerOf({ 'x-botyard-key': 'x' }, keys), { kind: 'wrong' })
  assert.deepEqual(callerOf({}, keys), { kind: 'none' })
  const req = (headers, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers })
  assert.equal(fromThisComputer(req({ host: '127.0.0.1:3210' })), true)
  assert.equal(fromThisComputer(req({ host: '127.0.0.1:3210' }, '10.0.0.2')), false)
  assert.match(notFromHere(req({ host: 'evil.example' })), /another name/)
})
