/**
 * Connectors: Studio signs in to a service itself, keeps the key, and a bot reaches the service only
 * through Botyard's gateway, with the tools the owner allowed. The service here is a fake one that
 * follows the MCP sign-in rules.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addConnector, connectorList, engineSignIns, finishSignIn, gateway, loadTools, readAnswer, readStore, removeConnector, setAccess, startSignIn, writeBotConfigs,
} from '../server/lib/connectors.mjs'

const CREW = [{ id: 'bot-lead', name: 'Lead' }, { id: 'bot-freelancer', name: 'Freelancer' }]
const TOOLS = [
  { name: 'whoami', description: 'Who is signed in', annotations: { readOnlyHint: true } },
  { name: 'search', description: 'Search the docs', annotations: { readOnlyHint: true } },
  { name: 'deploy', description: 'Deploy a worker' },
  { name: 'delete_zone', description: 'Delete a zone', annotations: { destructiveHint: true } },
]

/** A service with a sign-in page, the way the MCP rules lay it out. */
function service({ sse = false, expiresIn = 3600 } = {}) {
  const seen = { calls: [], registered: [], tokens: 0, refreshed: 0 }
  let token = 'tok-1'
  const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return reply({ resource: 'https://svc.test/mcp', authorization_servers: ['https://svc.test'], scopes_supported: ['read', 'write'] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return reply({ issuer: 'https://svc.test', authorization_endpoint: 'https://svc.test/authorize', token_endpoint: 'https://svc.test/token', registration_endpoint: 'https://svc.test/register' })
    if (u.pathname === '/register') { const body = JSON.parse(init.body); seen.registered.push(body); return reply({ client_id: 'client-9' }, 201) }
    if (u.pathname === '/token') {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return reply({ error: 'invalid_grant' }, 400)
        seen.tokens++
        return reply({ access_token: token, refresh_token: 'ref-1', expires_in: expiresIn })
      }
      seen.refreshed++
      token = `tok-${seen.refreshed + 1}`
      return reply({ access_token: token, expires_in: 3600 })
    }
    if (u.pathname === '/mcp') {
      if ((init.headers?.Authorization || '') !== `Bearer ${token}`) return reply('', 401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://svc.test/.well-known/oauth-protected-resource/mcp"' })
      const msg = JSON.parse(init.body)
      seen.calls.push(msg)
      const answer = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Fake service' }, capabilities: {} }
        : msg.method === 'tools/list' ? { tools: TOOLS }
          : msg.method === 'tools/call' ? { content: [{ type: 'text', text: `ran ${msg.params.name}` }] } : {}
      if (msg.id === undefined) return reply('', 202)
      const out = { jsonrpc: '2.0', id: msg.id, result: answer }
      return sse ? new Response(`event: message\ndata: ${JSON.stringify(out)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's1' } }) : reply(out, 200, { 'Mcp-Session-Id': 's1' })
    }
    return reply({ error: 'not found' }, 404)
  }
  return { fetcher, seen }
}

const room = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-'))
  return { folder: path.join(dir, 'keys'), out: path.join(dir, 'bots') }
}

async function signedIn(svc, where) {
  const made = await addConnector({ name: 'Fake', address: 'https://svc.test/mcp' }, { folder: where.folder, fetcher: svc.fetcher, crew: CREW })
  const { url } = await startSignIn(made.id, { redirectUri: 'http://localhost:5274/api/studio/connect/callback', folder: where.folder, fetcher: svc.fetcher })
  const state = new URL(url).searchParams.get('state')
  await finishSignIn({ state, code: 'good-code' }, { folder: where.folder, fetcher: svc.fetcher })
  return { id: made.id, url }
}

test('a service is added by its address, signed in to on its own page, and its tools are read with what each does', async () => {
  const svc = service()
  const where = room()
  const made = await addConnector({ name: 'Fake', address: 'https://svc.test/mcp' }, { folder: where.folder, fetcher: svc.fetcher, crew: CREW })
  assert.equal(made.state, 'signed-out')
  assert.equal(made.how, 'signin')
  const { url } = await startSignIn(made.id, { redirectUri: 'http://localhost:5274/api/studio/connect/callback', folder: where.folder, fetcher: svc.fetcher })
  const go = new URL(url)
  assert.equal(go.origin + go.pathname, 'https://svc.test/authorize')
  assert.equal(go.searchParams.get('client_id'), 'client-9')
  assert.equal(go.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(go.searchParams.get('resource'), 'https://svc.test/mcp')
  assert.deepEqual(svc.seen.registered[0].redirect_uris, ['http://localhost:5274/api/studio/connect/callback'])
  assert.equal(connectorList({ crew: CREW, folder: where.folder, engines: () => [] }).connectors[0].state, 'signing-in')
  await finishSignIn({ state: go.searchParams.get('state'), code: 'good-code' }, { folder: where.folder, fetcher: svc.fetcher })
  const view = connectorList({ crew: CREW, folder: where.folder, engines: () => [] }).connectors[0]
  assert.equal(view.state, 'ready')
  assert.equal(view.reads, 2)
  assert.equal(view.changes, 2)
  assert.deepEqual(view.tools.find((t) => t.name === 'deploy'), { name: 'deploy', about: 'Deploy a worker', reads: false, allowed: false })
  // Nothing secret reaches the page.
  assert.doesNotMatch(JSON.stringify(view), /tok-1|ref-1|client-9/)
  // And the file with the keys is the owner's alone.
  assert.equal(fs.statSync(path.join(where.folder, 'connectors.json')).mode & 0o777, 0o600)
})

test('a sign-in that was refused, or that Botyard did not start, connects nothing', async () => {
  const svc = service()
  const where = room()
  const made = await addConnector({ name: 'Fake', address: 'https://svc.test/mcp' }, { folder: where.folder, fetcher: svc.fetcher })
  const { url } = await startSignIn(made.id, { redirectUri: 'http://localhost:5274/cb', folder: where.folder, fetcher: svc.fetcher })
  await assert.rejects(() => finishSignIn({ state: 'made-up', code: 'good-code' }, { folder: where.folder, fetcher: svc.fetcher }), /not started from Botyard/)
  await assert.rejects(() => finishSignIn({ state: new URL(url).searchParams.get('state'), error: 'access_denied' }, { folder: where.folder, fetcher: svc.fetcher }), /said no/)
  assert.equal(svc.seen.tokens, 0)
  assert.equal(connectorList({ folder: where.folder, engines: () => [] }).connectors[0].state, 'signed-out')
})

test('a bot reaches a connector only when given it, sees only the tools it may use, and a changing tool is refused before it is sent', async () => {
  const svc = service()
  const where = room()
  const { id } = await signedIn(svc, where)
  const call = (pass, msg) => gateway(id, pass, { body: JSON.stringify(msg) }, { folder: where.folder, fetcher: svc.fetcher })
  // Not given: refused, and nothing is sent to the service.
  const before = svc.seen.calls.length
  assert.equal((await call('no-such-pass', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403)
  assert.equal(svc.seen.calls.length, before)

  await setAccess(id, { bots: { 'bot-lead': 'read', 'bot-freelancer': 'write' }, writes: ['deploy', 'whoami', 'no-such-tool'] }, { folder: where.folder, crew: CREW, out: where.out })
  const store = readStore(where.folder)
  assert.deepEqual(store.connectors[id].writes, ['deploy'], 'only a real tool that changes things can be ticked')
  const lead = store.passes['bot-lead']
  const freelancer = store.passes['bot-freelancer']
  assert.notEqual(lead, freelancer)

  const names = async (pass) => JSON.parse((await call(pass, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body).result.tools.map((t) => t.name)
  assert.deepEqual(await names(lead), ['whoami', 'search'])
  assert.deepEqual(await names(freelancer), ['whoami', 'search', 'deploy'])

  const sent = svc.seen.calls.length
  const refused = JSON.parse((await call(lead, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'deploy', arguments: {} } })).body)
  assert.match(refused.error.message, /has not allowed "deploy"/)
  const never = JSON.parse((await call(freelancer, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_zone', arguments: {} } })).body)
  assert.match(never.error.message, /has not allowed "delete_zone"/)
  assert.equal(svc.seen.calls.length, sent, 'a refused call never leaves Studio')

  const ran = JSON.parse((await call(freelancer, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'deploy', arguments: {} } })).body)
  assert.equal(ran.result.content[0].text, 'ran deploy')
  // The bot never holds the key: Studio adds it on the way out.
  assert.equal((await call(lead, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'whoami' } })).status, 200)
})

test('a service that answers as an event stream is read the same, and its tool list is still cut', async () => {
  const svc = service({ sse: true })
  const where = room()
  const { id } = await signedIn(svc, where)
  await setAccess(id, { bots: { 'bot-lead': 'read' } }, { folder: where.folder, crew: CREW, out: where.out })
  const out = await gateway(id, readStore(where.folder).passes['bot-lead'], { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, { folder: where.folder, fetcher: svc.fetcher })
  assert.match(out.headers['Content-Type'], /event-stream/)
  assert.deepEqual(readAnswer(out.body, 'text/event-stream').result.tools.map((t) => t.name), ['whoami', 'search'])
})

test('a key that is about to run out is renewed before the next call, once', async () => {
  const svc = service({ expiresIn: 30 })
  const where = room()
  const { id } = await signedIn(svc, where)
  await setAccess(id, { bots: { 'bot-lead': 'read' } }, { folder: where.folder, crew: CREW, out: where.out })
  const pass = readStore(where.folder).passes['bot-lead']
  const ask = () => gateway(id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } }) }, { folder: where.folder, fetcher: svc.fetcher })
  const [a, b] = await Promise.all([ask(), ask()])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(svc.seen.refreshed, 1, 'renewed once for both calls')
})

test('each bot gets a file listing its connectors for its launcher, and loses the entry when the connector is taken away', async () => {
  const svc = service()
  const where = room()
  const { id } = await signedIn(svc, where)
  await setAccess(id, { bots: { 'bot-lead': 'read' } }, { folder: where.folder, crew: CREW, out: where.out })
  writeBotConfigs({ folder: where.folder, out: where.out, crew: CREW, base: 'http://127.0.0.1:5274' })
  const lead = JSON.parse(fs.readFileSync(path.join(where.out, 'lead.claude.json'), 'utf8'))
  assert.match(lead.mcpServers.fake.url, /^http:\/\/127\.0\.0\.1:5274\/api\/mcp\/fake\/[\w-]{20,}$/)
  assert.equal(lead.mcpServers.fake.type, 'http')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(where.out, 'freelancer.claude.json'), 'utf8')), { mcpServers: {} })
  assert.equal(JSON.parse(fs.readFileSync(path.join(where.out, 'lead.opencode.json'), 'utf8')).mcp.fake.type, 'remote')
  await removeConnector(id, { folder: where.folder, out: where.out })
  writeBotConfigs({ folder: where.folder, out: where.out, crew: CREW })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(where.out, 'lead.claude.json'), 'utf8')), { mcpServers: {} })
})

test('a service from the list is added with a pasted key, sent in the header that service wants', async () => {
  const where = room()
  const seen = []
  const fetcher = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization })
    const msg = JSON.parse(init.body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: TOOLS } : {} }), { status: msg.id === undefined ? 202 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  const made = await addConnector({ from: 'github', key: 'pat-123' }, { folder: where.folder, fetcher, crew: CREW })
  assert.equal(made.name, 'GitHub')
  assert.equal(made.state, 'ready')
  assert.equal(made.how, 'key')
  assert.equal(seen[0].url, 'https://api.githubcopilot.com/mcp/')
  assert.equal(seen[0].auth, 'Bearer pat-123')
  assert.doesNotMatch(JSON.stringify(connectorList({ folder: where.folder, engines: () => [] })), /pat-123/)
  // Once added it leaves the list of services to add.
  assert.ok(!connectorList({ folder: where.folder, engines: () => [] }).catalogue.some((a) => a.id === 'github'))
  await assert.rejects(() => addConnector({ from: 'pagerduty' }, { folder: where.folder, fetcher }), /Paste the/)
  await assert.rejects(() => addConnector({ address: 'http://plain.example/mcp' }, { folder: where.folder, fetcher }), /https/)
})

test('a service that stops answering shows as trouble, and one that refuses the key as needing sign-in', async () => {
  const svc = service()
  const where = room()
  const { id } = await signedIn(svc, where)
  await loadTools(id, { folder: where.folder, fetcher: async () => new Response('down', { status: 500 }) })
  let view = connectorList({ folder: where.folder, engines: () => [] }).connectors[0]
  assert.equal(view.state, 'trouble')
  assert.equal(view.tools.length, 4, 'its last known tools stay')
  await loadTools(id, { folder: where.folder, fetcher: async () => new Response('', { status: 401 }) })
  view = connectorList({ folder: where.folder, engines: () => [] }).connectors[0]
  assert.equal(view.state, 'signed-out')
})

test('the engines\' sign-ins are read from where each keeps them, without reading anything out', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-'))
  const crew = path.join(home, 'crew')
  let list = engineSignIns({ home, crew })
  assert.equal(list.find((e) => e.id === 'claude').ok, false)
  assert.match(list.find((e) => e.id === 'claude').fix, /setup-token/)
  fs.mkdirSync(path.join(home, 'crew'), { recursive: true })
  fs.writeFileSync(path.join(home, 'crew', 'claude-token'), 'secret-token-value')
  list = engineSignIns({ home, crew })
  assert.equal(list.find((e) => e.id === 'claude').ok, true)
  assert.doesNotMatch(JSON.stringify(list), /secret-token-value/)
})
