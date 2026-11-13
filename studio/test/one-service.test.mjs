/**
 * The whole of Botyard in one process, started the way `npm start` starts it, in an empty home on
 * spare ports. Pinned here: who answers which path, that the engine speaks to this computer only,
 * that one store has one engine running bots, and that the service stops cleanly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fromThisComputer, whose } from '../server/studio.mjs'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = fs.existsSync(path.join(studio, 'dist', 'index.html'))
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-one-'))
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)) }
  return false
}

/** Start `server/studio.mjs` as its own process; resolves when it says it is up, or with its exit. */
async function start(homeDir, extra = {}, args = []) {
  const ports = { PORT: await freePort(), BOTYARD_ENGINE_PORT: await freePort(), BOTYARD_PHONE_PORT: await freePort(), BOTYARD_PREVIEW_PORT: await freePort() }
  const env = { PATH: process.env.PATH, HOME: homeDir, BOTYARD_HOME: path.join(homeDir, 'studio-home'), NODE_NO_WARNINGS: '1', ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])), ...extra }
  const child = spawn(process.execPath, [path.join(studio, 'server', 'studio.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  let code = null
  exited.then((c) => { code = c ?? -1 })
  await until(() => out.includes('Botyard →') || code !== null)
  const stop = async () => { if (code === null) child.kill('SIGTERM'); return exited }
  return { child, env, ports: Object.fromEntries(Object.entries(env).filter(([k]) => k in ports).map(([k, v]) => [k, Number(v)])), out: () => out, code: () => code, exited, stop, at: `http://127.0.0.1:${env.PORT}`, engine: `http://127.0.0.1:${env.BOTYARD_ENGINE_PORT}` }
}
const get = async (url, headers = {}) => { const res = await fetch(url, { headers }); return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text().then((text) => { try { return JSON.parse(text) } catch { return text } }) } }
const post = async (url, body, headers = {}) => { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() } }

test('each path under /api has one owner', () => {
  assert.equal(whose('/api/studio/setup'), 'mine')
  assert.equal(whose('/api/studio/timetable'), 'mine')
  for (const map of ['/api/studio', '/api/studio/jobs', '/api/studio/setup-rows', '/api/health', '/api/state']) assert.equal(whose(map), 'map', map)
  for (const engine of ['/api/companies', '/api/companies/1/issues', '/api/agents/me', '/api/issues/1', '/api/health/extra', '/api/studios', '/api/']) assert.equal(whose(engine), 'engine', engine)
})

test('a call handed on by a tunnel or a proxy did not start on this computer', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:5274', ...headers } })
  assert.equal(fromThisComputer(req('127.0.0.1')), true)
  assert.equal(fromThisComputer(req('::1', { host: 'localhost:5274' })), true)
  assert.equal(fromThisComputer(req('::1', { host: '[::1]:5274', origin: 'http://localhost:5274' })), true)
  // A page on another site that points its own name at this computer, or posts here from there.
  assert.equal(fromThisComputer(req('127.0.0.1', { host: 'evil.example:5274' })), false)
  assert.equal(fromThisComputer(req('127.0.0.1', { origin: 'https://evil.example' })), false)
  assert.equal(fromThisComputer(req('127.0.0.1', { host: '' })), false)
  assert.equal(fromThisComputer(req('192.168.1.20')), false)
  assert.equal(fromThisComputer(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false)
  assert.equal(fromThisComputer(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false)
  assert.equal(fromThisComputer(req('127.0.0.1', { 'x-botyard-edge': '1' })), false)
})

test('one process is the whole of Botyard', { skip: built ? false : 'the map is not built in this checkout (npm run build)', timeout: 90000 }, async (t) => {
  const homeDir = temp()
  // A timetable of one small helper, so no script of the real crew is started by a test.
  const table = path.join(homeDir, 'timetable.json')
  fs.writeFileSync(path.join(homeDir, 'hello.mjs'), 'console.log("helper told:", process.env.BOTYARD_API_URL)')
  fs.writeFileSync(table, JSON.stringify({ jobs: [{ name: 'hello', what: 'Says where the engine is', command: ['{node}', path.join(homeDir, 'hello.mjs')], every: '1h' }] }))
  const token = 'test-token-'.padEnd(48, 'x')
  const one = await start(homeDir, { BOTYARD_TIMETABLE_FILE: table, BOTYARD_PHONE_TOKEN: token })
  t.after(() => one.stop())
  assert.equal(one.code(), null, one.out())

  await t.test('the page, the map\'s API and the engine answer on the people port', async () => {
    const home = await get(one.at + '/')
    assert.equal(home.status, 200)
    assert.match(home.type, /text\/html/)
    assert.equal((await get(one.at + '/some/page/of/the/map')).status, 200)
    assert.equal((await get(one.at + '/api/health')).body.workspace, studio)
    const studios = await get(one.at + '/api/companies')
    assert.equal(studios.status, 200)
    assert.equal(studios.body.length, 1, 'an empty home gets a yard of its own')
    assert.equal((await get(one.engine + '/api/health')).body.engine, 'studio')
  })

  await t.test('the engine is not shown to a caller who came from somewhere else', async () => {
    for (const header of [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { 'x-botyard-edge': '1' }]) {
      const out = await get(one.at + '/api/companies', header)
      assert.equal(out.status, 404)
      assert.deepEqual(out.body, { error: 'Not found' })
    }
    assert.equal((await get(one.at + '/api/studio/setup', { 'cf-connecting-ip': '203.0.113.9' })).status, 403)
    // A page on another site cannot read the engine through the browser of the person at this computer.
    const fromSite = await fetch(one.at + '/api/companies', { headers: { Origin: 'https://evil.example' } })
    assert.equal(fromSite.status, 404)
  })

  await t.test('the phone\'s door is open on its own port and passes nothing on raw', async () => {
    const doorAt = `http://127.0.0.1:${one.ports.BOTYARD_PHONE_PORT}`
    assert.equal((await get(doorAt + '/v1/summary')).status, 401)
    const raw = await get(doorAt + '/api/companies', { Authorization: `Bearer ${token}` })
    assert.ok([401, 404].includes(raw.status), `the door answered ${raw.status} to an engine path`)
    assert.notEqual(Array.isArray(raw.body), true)
  })

  await t.test('setup answers, and saves a key closed', async () => {
    const state = await get(one.at + '/api/studio/setup')
    assert.equal(state.status, 200)
    assert.equal(state.body.items.find((item) => item.id === 'map').state, 'ok')
    const saved = await post(one.at + '/api/studio/setup', { action: 'key', id: 'openrouter', key: 'sk-or-v1-testtesttest' })
    assert.equal(saved.status, 200)
    const file = path.join(one.env.BOTYARD_HOME, 'keys', 'openrouter.key')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(JSON.stringify(saved.body).includes('testtesttest'), false)
    const other = await post(one.at + '/api/studio/setup', { action: 'key', id: 'openrouter', key: 'sk-or-v1-fromanothersite' }, { Origin: 'https://evil.example' })
    assert.equal(other.status, 403)
  })

  await t.test('the timetable is on in a new home and runs a helper that is told where the engine is', async () => {
    const state = await get(one.at + '/api/studio/timetable')
    assert.equal(state.body.state, 'on')
    assert.deepEqual(state.body.jobs.map((job) => job.name), ['hello'])
    assert.equal((await post(one.at + '/api/studio/timetable', { action: 'run', name: 'hello' })).status, 200)
    assert.ok(await until(async () => (await get(one.at + '/api/studio/timetable')).body.jobs[0].lastOk === true))
    assert.match((await get(one.at + '/api/studio/timetable?log=hello')).body.log, new RegExp(`helper told: ${one.engine}\n`))
    assert.equal((await get(one.at + '/api/studio/timetable?log=nobody')).status, 404)
  })

  await t.test('everything the yard owns is in its home folder', () => {
    assert.ok(fs.existsSync(path.join(one.env.BOTYARD_HOME, 'studio.db')), 'the store is in the home folder')
    assert.ok(fs.existsSync(path.join(one.env.BOTYARD_HOME, 'keys', 'openrouter.key')))
    // The home was chosen by hand: the default place is not made beside it. (The AI tools that setup
    // asks for their version make folders of their own in the user's home; those are theirs.)
    assert.equal(fs.existsSync(path.join(homeDir, '.botyard')), false)
  })

  await t.test('a second Botyard over the same home answers but starts no bot', async () => {
    const two = await start(homeDir, { BOTYARD_TIMETABLE: 'off' })
    try {
      assert.equal(two.code(), null, two.out())
      assert.match(two.out(), /starts no bot: another Botyard \(process \d+\) already runs the bots of this yard/)
      assert.equal((await get(two.at + '/api/companies')).status, 200)
    } finally { assert.equal(await two.stop(), 0) }
    assert.ok(fs.existsSync(path.join(one.env.BOTYARD_HOME, 'engine.lock')), 'the first still holds the bots')
  })

  await t.test('a port in use is said in plain words, before anything is touched', async () => {
    const other = temp()
    const clash = await start(other, { PORT: String(one.ports.PORT) })
    assert.equal(await clash.exited, 1)
    assert.match(clash.out(), new RegExp(`Port ${one.ports.PORT} is in use, so Botyard cannot start`))
    assert.equal(fs.existsSync(path.join(other, 'studio-home', 'studio.db')), false)
  })

  await t.test('asked to stop, it closes everything and lets go of the bots', async () => {
    assert.equal(await one.stop(), 0)
    assert.equal(fs.existsSync(path.join(one.env.BOTYARD_HOME, 'engine.lock')), false)
    await assert.rejects(fetch(one.at + '/'))
    await assert.rejects(fetch(one.engine + '/api/health'))
  })
})

test('--demo is the real service on a made-up yard in a home of its own, with no bot started', { skip: built ? false : 'the map is not built in this checkout (npm run build)', timeout: 90000 }, async (t) => {
  const homeDir = temp()
  const demo = await start(homeDir, {}, ['--demo'])
  t.after(() => demo.stop())
  assert.equal(demo.code(), null, demo.out())
  assert.match(demo.out(), /The sample yard: Lighthouse Labs, 8 bots/)
  assert.match(demo.out(), /the demo: a made-up yard/)
  // The real map over the real engine: the crew, their work and what waits for the owner.
  const view = await get(demo.at + '/api/studio')
  assert.equal(view.body.on, true)
  assert.equal(view.body.manager.bots.length, 8)
  assert.ok(view.body.manager.lines.some((line) => line.stage === 'ruling'))
  assert.equal((await get(demo.at + '/api/companies')).body[0].name, 'Lighthouse Labs')
  // The helpers are listed with when each last ran and would next run, and none can be started.
  const table = (await get(demo.at + '/api/studio/timetable')).body
  assert.equal(table.state, 'off')
  assert.match(table.why, /sample yard/)
  assert.ok(table.jobs.filter((job) => job.kind === 'timer').every((job) => job.lastOk === true && job.lastEnd > 0), 'every helper has a last run to show')
  assert.equal((await post(demo.at + '/api/studio/timetable', { action: 'run', name: table.jobs[0].name }, { Origin: demo.at })).status, 409)
  assert.ok((await get(demo.at + '/api/studio/timers')).body.timers.some((timer) => timer.last && timer.next), 'the Routines page has helper rows')
  // The map shows the sample crew alone: nobody's own sessions are read, and none can be listed or opened.
  assert.ok(view.body.threads.length > 0 && view.body.threads.every((thread) => thread.crew), 'only bots of the yard are on the map')
  for (const gone of ['/api/threads', '/api/office', '/api/jobs']) assert.equal((await get(demo.at + gone)).status, 404, gone)
  for (const gone of ['/api/open', '/api/message', '/api/new-session', '/api/reveal', '/api/missions']) assert.equal((await post(demo.at + gone, {}, { Origin: demo.at })).status, 404, gone)
  // The home the caller named is left alone: the demo made its own, and takes it away when it stops.
  assert.equal(fs.existsSync(path.join(demo.env.BOTYARD_HOME, 'studio.db')), false)
  const own = /It is kept in (\S+) until/.exec(demo.out())?.[1]
  assert.ok(own && fs.existsSync(path.join(own, 'studio.db')), 'the demo keeps its store in a throwaway home')
  await demo.stop()
  assert.equal(fs.existsSync(own), false, 'gone when the demo stops')
})
