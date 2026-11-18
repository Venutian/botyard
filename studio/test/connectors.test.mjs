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
  addConnector, connectorList, engineSignIns, finishSignIn, gateway, loadTools, readAnswer, readStore, removeConnector, setAccess, settleHeld, startSignIn, whatWouldBeSent, writeBotConfigs,
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

  // A business's account: an allowed change is made straight away (the owner's own account is tested below).
  await setAccess(id, { bots: { 'bot-lead': 'read', 'bot-freelancer': 'write' }, writes: ['deploy', 'whoami', 'no-such-tool'], owner: 'business' }, { folder: where.folder, crew: CREW, out: where.out })
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

// ── the owner's own account: a change waits for the owner's yes on a card ────────────

/** Cards as the engine would keep them: what was put on which job, and what the bot was told there. */
function fakeCards({ job = 'job-1' } = {}) {
  const seen = { cards: [], told: [] }
  return {
    seen,
    place: async ({ bot, title, prompt }) => { if (!job) return null; const card = `card-${seen.cards.length + 1}`; seen.cards.push({ card, bot, title, prompt, job }); return { job, card } },
    tell: async (to, text) => { seen.told.push({ job: to, text }) },
  }
}

async function ownAccount() {
  const svc = service()
  const where = room()
  const { id } = await signedIn(svc, where)
  await setAccess(id, { bots: { 'bot-lead': 'read', 'bot-freelancer': 'write' }, writes: ['deploy'] }, { folder: where.folder, crew: CREW, out: where.out })
  const store = readStore(where.folder)
  return { svc, where, id, lead: store.passes['bot-lead'], freelancer: store.passes['bot-freelancer'] }
}

test('a connector is the owner\'s own account unless they say it is a business\'s, and that can be changed', async () => {
  const { where, id } = await ownAccount()
  assert.equal(connectorList({ crew: CREW, folder: where.folder }).connectors[0].owner, 'own')
  await setAccess(id, { owner: 'business' }, { folder: where.folder, crew: CREW, out: where.out })
  assert.equal(connectorList({ crew: CREW, folder: where.folder }).connectors[0].owner, 'business')
  await assert.rejects(setAccess(id, { owner: 'mine' }, { folder: where.folder, crew: CREW, out: where.out }), /own account or a business/)
})

test('on the owner\'s own account a change becomes a card showing exactly what would be sent, and is never sent before the yes', async () => {
  const { svc, where, id, freelancer } = await ownAccount()
  const cards = fakeCards()
  const before = svc.seen.calls.filter((m) => m.method === 'tools/call').length
  const args = { to: 'buyer@example.com', text: 'Your order ships Monday', amount: 12.5 }
  const answer = JSON.parse((await gateway(id, freelancer, { body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'deploy', arguments: args } }) }, { folder: where.folder, fetcher: svc.fetcher, cards })).body)
  assert.match(answer.result.content[0].text, /^Not done yet\./, 'the bot is told it waits, as an answer and not a failure')
  assert.equal(svc.seen.calls.filter((m) => m.method === 'tools/call').length, before, 'nothing reaches the service before the yes')
  assert.equal(cards.seen.cards.length, 1)
  const card = cards.seen.cards[0]
  assert.equal(card.bot, 'bot-freelancer')
  assert.match(card.title, /deploy, on your own account/)
  for (const line of ['to: buyer@example.com', 'text: Your order ships Monday', 'amount: 12.5']) assert.ok(card.prompt.includes(line), `the card shows ${line}`)
  assert.ok(readStore(where.folder).held[card.card], 'the call is kept until the owner answers')

  // The yes sends it, exactly as asked, and the bot is told on its job what came back.
  const out = await settleHeld(card.card, 'accept', { folder: where.folder, fetcher: svc.fetcher, cards })
  assert.deepEqual(out, { sent: true })
  const sent = svc.seen.calls.filter((m) => m.method === 'tools/call')
  assert.equal(sent.length, before + 1)
  assert.deepEqual(sent.at(-1).params, { name: 'deploy', arguments: args })
  assert.equal(cards.seen.told[0].job, 'job-1')
  assert.match(cards.seen.told[0].text, /said yes.*done[\s\S]*ran deploy/)
  assert.equal(readStore(where.folder).held[card.card], undefined)
  assert.equal(await settleHeld(card.card, 'accept', { folder: where.folder, fetcher: svc.fetcher, cards }), null, 'a card is settled once')
})

test('a no on the card reaches the bot and nothing is sent', async () => {
  const { svc, where, id, freelancer } = await ownAccount()
  const cards = fakeCards()
  await gateway(id, freelancer, { body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'deploy', arguments: { to: 'x' } } }) }, { folder: where.folder, fetcher: svc.fetcher, cards })
  const before = svc.seen.calls.filter((m) => m.method === 'tools/call').length
  const out = await settleHeld(cards.seen.cards[0].card, 'reject', { reason: 'Wrong buyer', folder: where.folder, fetcher: svc.fetcher, cards })
  assert.deepEqual(out, { sent: false })
  assert.equal(svc.seen.calls.filter((m) => m.method === 'tools/call').length, before)
  assert.match(cards.seen.told[0].text, /said no to .*deploy.*not sent.*Wrong buyer/)
})

test('reads pass straight through on the owner\'s own account; a tool with no read-only mark counts as a change', async () => {
  const { svc, where, id, freelancer } = await ownAccount()
  const cards = fakeCards()
  const read = JSON.parse((await gateway(id, freelancer, { body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami' } }) }, { folder: where.folder, fetcher: svc.fetcher, cards })).body)
  assert.equal(read.result.content[0].text, 'ran whoami')
  assert.equal(cards.seen.cards.length, 0)
  // "deploy" has no annotation at all: it is held like any change.
  assert.equal(readStore(where.folder).connectors[id].tools.find((t) => t.name === 'deploy').readOnly, false)
  // In a batch a change is refused outright, never sent.
  const batch = JSON.parse((await gateway(id, freelancer, { body: JSON.stringify([{ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'deploy' } }]) }, { folder: where.folder, fetcher: svc.fetcher, cards })).body)
  assert.match(batch.error.message, /on its own/)
})

test('a change with no job to hold it on is refused with what to do instead, and nothing is sent', async () => {
  const { svc, where, id, freelancer } = await ownAccount()
  const cards = fakeCards({ job: '' })
  const before = svc.seen.calls.filter((m) => m.method === 'tools/call').length
  const answer = JSON.parse((await gateway(id, freelancer, { body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'deploy' } }) }, { folder: where.folder, fetcher: svc.fetcher, cards })).body)
  assert.match(answer.error.message, /Ask the owner in a comment/)
  assert.equal(svc.seen.calls.filter((m) => m.method === 'tools/call').length, before)
})

test('what would be sent is written out in full, field by field, and cut only past a long length', () => {
  assert.equal(whatWouldBeSent({ to: 'a@b.c', body: 'Hi' }), 'to: a@b.c\nbody: Hi')
  assert.match(whatWouldBeSent({}), /nothing/)
  assert.match(whatWouldBeSent({ text: 'x'.repeat(5000) }), /more characters$/)
})

test('a service that registers no app is signed in to through the owner\'s own app: no registration, its scope and fields asked for', async () => {
  const where = room()
  const seen = []
  const fetcher = async (url, init = {}) => {
    seen.push(url)
    const u = new URL(url)
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.host === 'gmailmcp.googleapis.com' && u.pathname === '/mcp/v1') return reply({ jsonrpc: '2.0', id: 0, result: {} })
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp/v1') return reply({ resource: 'https://gmailmcp.googleapis.com/mcp/v1', authorization_servers: ['https://accounts.google.com/'] })
    if (u.host === 'accounts.google.com' && u.pathname === '/.well-known/openid-configuration') return reply({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token' })
    return reply({}, 404)
  }
  await assert.rejects(addConnector({ from: 'gmail', how: 'signin' }, { folder: where.folder, fetcher, crew: CREW }), /client ID/)
  const made = await addConnector({ from: 'gmail', how: 'signin', clientId: 'my-app.apps.googleusercontent.com', clientSecret: 'shh' }, { folder: where.folder, fetcher, crew: CREW })
  assert.equal(made.state, 'signed-out', 'it waits for the owner to sign in, though the server answered a first question without one')
  const { url } = await startSignIn(made.id, { redirectUri: 'http://localhost:5274/api/studio/connect/callback', folder: where.folder, fetcher })
  const go = new URL(url)
  assert.equal(go.origin + go.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(go.searchParams.get('client_id'), 'my-app.apps.googleusercontent.com')
  assert.match(go.searchParams.get('scope'), /gmail\.modify/)
  assert.equal(go.searchParams.get('access_type'), 'offline')
  assert.equal(go.searchParams.get('resource'), null, 'no resource where the service would refuse it')
  assert.ok(!seen.some((u) => /register/.test(u)), 'nothing is registered on the service')
  assert.ok(!JSON.stringify(connectorList({ crew: CREW, folder: where.folder })).includes('shh'), 'the secret is never shown')
})

test('a service that only reads but marks no tool read-only still gives a reading bot its tools, from the catalogue\'s list', async () => {
  // DeepWiki, 18 Nov: its server marks none of its tools read-only, so a bot given "read" saw no tools at all.
  const where = room()
  const tools = [{ name: 'read_wiki_structure', description: 'Topics' }, { name: 'read_wiki_contents', description: 'Docs' }, { name: 'ask_wiki_question', description: 'Ask' }, { name: 'new_tool_that_writes', description: 'A tool the catalogue does not know' }]
  const fetcher = async (url, init = {}) => {
    if (!String(url).startsWith('https://mcp.deepwiki.com/mcp')) return new Response('{}', { status: 404 })
    const msg = JSON.parse(init.body || '{}')
    if (msg.id === undefined) return new Response('', { status: 202 })
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'DeepWiki' }, capabilities: {} }
      : msg.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: `ran ${msg.params?.name}` }] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const made = await addConnector({ from: 'deepwiki' }, { folder: where.folder, fetcher, crew: CREW })
  await loadTools(made.id, { folder: where.folder, fetcher })
  await setAccess(made.id, { bots: { 'bot-lead': 'read' } }, { folder: where.folder, crew: CREW, out: where.out })
  const listed = connectorList({ crew: CREW, folder: where.folder }).connectors.find((c) => c.id === made.id)
  assert.deepEqual(listed.tools.filter((t) => t.reads).map((t) => t.name).sort(), ['ask_wiki_question', 'read_wiki_contents', 'read_wiki_structure'])
  const pass = readStore(where.folder).passes['bot-lead']
  const seen = await gateway(made.id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }, { folder: where.folder, fetcher })
  const names = JSON.parse(seen.body).result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['ask_wiki_question', 'read_wiki_contents', 'read_wiki_structure'], 'a tool the catalogue does not list stays a change')
  const ran = await gateway(made.id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_wiki_structure', arguments: { repoName: 'a/b' } } }) }, { folder: where.folder, fetcher })
  assert.match(ran.body, /ran read_wiki_structure/)
})
