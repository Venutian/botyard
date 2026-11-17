/**
 * A bot's call to a connector (`/api/mcp/<connector>/<its pass>`) reaches the gateway through the
 * service's own handler: a real HTTP POST, a fake connector behind it, a good pass accepted and a
 * wrong one refused with 403 (never 404, which is what an unrouted path answers).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-route-'))
process.env.BOTYARD_KEYS = path.join(dir, 'keys')
process.env.BOTYARD_DATA = path.join(dir, 'data')
const { apiMiddleware } = await import('../server/api.mjs')
const { addConnector, connectorList, gatewayReach, setAccess, readStore } = await import('../server/lib/connectors.mjs')

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('a bot reaches the gateway by its path, and only with its own pass', async (t) => {
  const seen = []
  const connector = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(404); return res.end() }
      const msg = JSON.parse(body)
      seen.push(msg.method)
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Fake' }, capabilities: {} }
        : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'Who', annotations: { readOnlyHint: true } }, { name: 'deploy', description: 'Deploy' }] } : {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  const studio = http.createServer((req, res) => apiMiddleware(req, res))
  const [cPort, sPort] = [await listen(connector), await listen(studio)]
  t.after(() => { connector.close(); studio.close(); connector.closeAllConnections?.(); studio.closeAllConnections?.() })

  const crew = [{ id: 'bot-lead', name: 'Lead' }]
  const made = await addConnector({ name: 'Fake', address: `http://127.0.0.1:${cPort}/mcp`, owner: 'business' }, { crew })
  await setAccess(made.id, { bots: { 'bot-lead': 'read' } }, { crew, out: path.join(dir, 'bots') })
  const pass = readStore().passes['bot-lead']
  const call = (who, msg, extra = {}) => fetch(`http://127.0.0.1:${sPort}/api/mcp/${made.id}/${who}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg), ...extra })

  const init = await call(pass, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.status, 200)
  assert.equal((await init.json()).result.serverInfo.name, 'Fake')
  const list = await (await call(pass, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
  assert.deepEqual(list.result.tools.map((x) => x.name), ['whoami'], 'the list is cut to what the bot may use')
  assert.ok(seen.includes('initialize') && seen.includes('tools/list'), 'the connector was reached')

  const before = seen.length
  const wrong = await call('not-the-pass', { jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.equal(wrong.status, 403)
  assert.equal(seen.length, before, 'nothing is sent on with a wrong pass')
  // A name that is not this computer's is refused, and so is a verb the gateway has no use for.
  const named = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: sPort, path: `/api/mcp/${made.id}/${pass}`, method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode) })
    r.end('{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
  })
  assert.equal(named, 403)
  assert.equal((await fetch(`http://127.0.0.1:${sPort}/api/mcp/${made.id}/${pass}`, { method: 'PUT', body: '{}' })).status, 405)

  // The Connectors page: reachable means ready; a road that ends in the engine's 404 means "not reachable", with the reason.
  assert.equal(await gatewayReach(`http://127.0.0.1:${sPort}`, made.id), '')
  const dead = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"API route not found"}') })
  const dPort = await listen(dead)
  t.after(() => { dead.close(); dead.closeAllConnections?.() })
  const why = await gatewayReach(`http://127.0.0.1:${dPort}`, made.id)
  assert.match(why, /API route not found/)
  assert.ok(!why.includes(pass), 'the pass is never in the reason')
  const view = connectorList({ crew, engines: () => [], reach: { [made.id]: why } }).connectors[0]
  assert.equal(view.state, 'unreachable')
  assert.equal(view.stateWords, 'Not reachable')
  assert.equal(view.trouble, why)
  assert.equal(connectorList({ crew, engines: () => [], reach: { [made.id]: '' } }).connectors[0].state, 'ready')
})
