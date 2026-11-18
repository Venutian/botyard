/**
 * The PC load control: the route takes five level names and nothing else, reads the tool's real `show --json`,
 * is hidden when the yard names no tool, tells the tool the change is the owner's, and refuses a bot's run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { botRunOf } from '../server/engine/caller.mjs'
import { LEVELS, readShow, stateLine, throttleAct, throttleState, throttleTool } from '../server/lib/throttle.mjs'
import { CONFIRM, throttleHtml, throttleLayerHtml } from '../src/ui/throttle.js'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

/** What the real tool prints for `show --json` while Full holds two jobs, one of which has since gone. */
const FULL = JSON.stringify({
  day: 'full', night: 'light', now: 'full', heldMB: 9626,
  paused: [{ pid: 11, name: 'voices', rssMB: 7168, state: 'ok' }, { pid: 12, name: 'build', rssMB: 2458, state: 'ok' }, { pid: 13, name: 'gone', rssMB: 500, state: 'gone' }],
})

/** A fake tool that logs its arguments and who it was told set them, and answers `show` from a file. */
function fake(show = JSON.stringify({ day: 'heavy', night: 'heavy', now: 'heavy', paused: [], heldMB: 0 })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-'))
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(path.join(dir, 'show.txt'), show)
  fs.writeFileSync(tool, `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$BOTYARD_SET_BY" >> "${dir}/calls.log"\nif [ "$1" = show ]; then cat "${dir}/show.txt"; else exit 0; fi\n`, { mode: 0o755 })
  const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
  return { tool, dir, calls, sets: () => calls().filter((c) => !c.startsWith('show')) }
}

test('only the five level names reach the tool; anything else is refused before it runs', async () => {
  const f = fake()
  const marker = path.join(f.dir, 'ran')
  for (const bad of ['', 'FULL', `heavy; touch ${marker}`, `$(touch ${marker})`, '--day', 'light --night', '--help', 'none\nfull', 5, null, ['heavy'], {}]) {
    const [status, body] = await throttleAct({ level: bad }, { tool: f.tool })
    assert.equal(status, 400, JSON.stringify(bad))
    assert.match(body.error, /must be one of/)
  }
  assert.equal((await throttleAct({ level: 'light', scope: 'x; id' }, { tool: f.tool }))[0], 400)
  assert.equal((await throttleAct(null, { tool: f.tool }))[0], 400)
  assert.deepEqual(f.calls(), [], 'the tool was never run')
  assert.equal(fs.existsSync(marker), false)
})

test('each valid level runs the tool with plain arguments, day and night when asked, and says who asked', async () => {
  const f = fake()
  for (const level of LEVELS) assert.equal((await throttleAct({ level }, { tool: f.tool, setBy: 'owner (page)' }))[0], 200)
  await throttleAct({ level: 'light', scope: 'night' }, { tool: f.tool, setBy: 'owner (phone)' })
  await throttleAct({ level: 'none', scope: 'day' }, { tool: f.tool, setBy: 'owner (page)' })
  assert.deepEqual(f.sets(), ['none|owner (page)', 'light|owner (page)', 'medium|owner (page)', 'heavy|owner (page)', 'full|owner (page)', 'light --night|owner (phone)', 'none --day|owner (page)'])
})

test('the tool never runs looking like a bot run, even when the server was started from one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-env-'))
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(tool, `#!/bin/sh\nenv > "${dir}/env.txt"\necho '{"now":"none","day":"none","night":"none","paused":[],"heldMB":0}'\n`, { mode: 0o755 })
  await throttleState({ tool, env: { PATH: process.env.PATH, BOTYARD_RUN_ID: 'r1', BOTYARD_API_KEY: 'stu_x', BOTYARD_JOB_ID: 'j1', BOTYARD_HOME: '/h' } })
  const seen = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8')
  assert.doesNotMatch(seen, /BOTYARD_(RUN_ID|API_KEY|JOB_ID)=/)
  assert.match(seen, /BOTYARD_HOME=\/h/)
})

test('show --json is read as the tool prints it: paused is a list of jobs, heldMB the memory they hold', () => {
  const s = readShow(FULL)
  assert.deepEqual([s.now, s.day, s.night, s.paused, s.heldGb], ['full', 'full', 'light', 2, 9.4])
  assert.equal(stateLine(s), 'Full: 2 jobs paused, 9.4 GB held')
  assert.equal(stateLine(readShow(JSON.stringify({ now: 'full', day: 'full', night: 'full', paused: [{ state: 'ok', rssMB: 1 }], heldMB: 0 }))), 'Full: 1 job paused')
  assert.equal(stateLine(readShow(JSON.stringify({ now: 'light', day: 'light', night: 'none', paused: [], heldMB: 0 }))), 'Light (day Light, night None)')
  for (const junk of ['', 'day heavy', '[]', '{"now":"turbo"}', 'null']) assert.equal(stateLine(readShow(junk)), 'The PC load is not known', junk)
  // The tool's own line of what the level lets run is shown as it is, control characters taken out.
  const noted = readShow(JSON.stringify({ now: 'none', day: 'none', night: 'none', paused: [], heldMB: 0, note: 'None: up to 6 Claude, 6 free, 4 heavy\n<b>' }))
  assert.equal(stateLine(noted), 'None: up to 6 Claude, 6 free, 4 heavy <b>')
  assert.match(throttleHtml({ configured: true, ...noted, line: stateLine(noted) }), /None: up to 6 Claude, 6 free, 4 heavy &lt;b&gt;<\/span>/)
})

test('a tool that fails is reported, and the state says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-bad-'))
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(tool, '#!/bin/sh\necho broken >&2\nexit 3\n', { mode: 0o755 })
  const [status, body] = await throttleAct({ level: 'none' }, { tool })
  assert.equal(status, 502)
  assert.match(body.error, /broken/)
  assert.equal((await throttleState({ tool })).line, 'The PC load could not be read')
  assert.equal((await throttleState({ tool: fake(FULL).tool })).line, 'Full: 2 jobs paused, 9.4 GB held')
})

test('a yard that names no tool has no control: the state says so and a change is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-none-'))
  const settingsFile = path.join(dir, 'pc-load.json')
  const env = {}
  assert.equal(throttleTool({ settingsFile, env }), '')
  assert.deepEqual(await throttleState({ settingsFile, env }), { configured: false, levels: LEVELS })
  assert.equal((await throttleAct({ level: 'none' }, { settingsFile, env }))[0], 404)
  // A relative name, a folder or a file that cannot be run is no tool either.
  for (const tool of ['pc-throttle', dir, settingsFile]) {
    fs.writeFileSync(settingsFile, JSON.stringify({ tool }))
    assert.equal(throttleTool({ settingsFile, env }), '', tool)
  }
  const f = fake()
  fs.writeFileSync(settingsFile, JSON.stringify({ tool: f.tool }))
  assert.equal(throttleTool({ settingsFile, env }), f.tool)
  assert.equal((await throttleState({ settingsFile, env })).configured, true)
})

test('a process is known as a bot run by its own variables or a parent\'s, read from /proc', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-proc-'))
  const make = (pid, ppid, vars) => {
    fs.mkdirSync(path.join(proc, String(pid)))
    fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${vars.join('\0')}\0`)
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (sh) S ${ppid} 0 0`)
  }
  make(100, 1, ['HOME=/h', 'BOTYARD_RUN_ID=run-7', 'BOTYARD_API_KEY=stu_x'])
  make(200, 100, ['HOME=/h']) // a curl the bot started with its variables cleared
  make(300, 1, ['HOME=/h', 'BOTYARD_RUN_ID='])
  make(400, 300, ['HOME=/h'])
  assert.equal(botRunOf(100, { proc }), 'run-7')
  assert.equal(botRunOf(200, { proc }), 'run-7')
  assert.equal(botRunOf(400, { proc }), '')
  assert.equal(botRunOf('', { proc }), '')
})

test('the page shows each level as the chosen one, with names for a screen reader', () => {
  for (const now of LEVELS) {
    const html = throttleHtml({ configured: true, now, day: now, night: now, line: stateLine({ now, paused: 0 }) })
    assert.match(html, /role="radiogroup"/)
    assert.equal((html.match(/role="radio"/g) || []).length, 5)
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1)
    assert.match(html, new RegExp(`aria-checked="true"[^>]*data-level="${now}"`))
  }
})

test('full shows its stop icon, its paused jobs and Resume; the others offer no Resume', () => {
  const full = throttleHtml({ configured: true, now: 'full', line: 'Full: 2 jobs paused, 9.4 GB held' })
  assert.match(full, /Resume/)
  assert.match(full, /ld-icon/)
  assert.match(full, /Full: 2 jobs paused, 9\.4 GB held/)
  assert.doesNotMatch(throttleHtml({ configured: true, now: 'heavy', line: 'Heavy' }), /Resume/)
  // The line only says what the buttons cannot: a plain level shows none, a day and night split or an error does.
  assert.match(throttleHtml({ configured: true, now: 'heavy', day: 'heavy', night: 'heavy', line: 'Heavy' }), /<span class="ld-line"[^>]*><\/span>/)
  assert.match(throttleHtml({ configured: true, now: 'light', day: 'light', night: 'none', line: 'Light (day Light, night None)' }), /day Light, night None/)
  assert.match(throttleHtml({ configured: true, now: 'none', line: 'None' }, { error: 'The load could not be set' }), /could not be set/)
})

test('pressing Full asks once, with the words the owner gave', () => {
  const html = throttleLayerHtml({ now: 'heavy', line: 'Heavy' }, { confirming: true })
  assert.ok(html.includes(CONFIRM))
  assert.match(html, /data-act="load-full-yes"/)
  assert.doesNotMatch(throttleLayerHtml({ now: 'heavy', line: 'Heavy' }), /alertdialog/)
})

/** Fetch from a child process with the given variables, so the server sees a different caller. */
function fetchFrom(vars, url, init = {}) {
  const code = `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.json() })))`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, ...vars }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', () => { try { resolve(JSON.parse(out)) } catch (err) { reject(new Error(`no answer from ${url}: ${err.message}`)) } })
  })
}

test('the page port: the owner sets the level, a bot\'s run, a pass or a script key is refused, and the phone door too', { skip: process.platform !== 'linux' && 'reads /proc' }, async (t) => {
  const f = fake()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-yard-'))
  const yard = path.join(home, 'yard')
  fs.mkdirSync(path.join(yard, 'config'), { recursive: true })
  fs.writeFileSync(path.join(yard, 'config', 'pc-load.json'), JSON.stringify({ tool: f.tool }))
  const ports = { PORT: await freePort(), BOTYARD_ENGINE_PORT: await freePort(), BOTYARD_PHONE_PORT: await freePort(), BOTYARD_PREVIEW_PORT: await freePort() }
  const env = { PATH: process.env.PATH, HOME: home, BOTYARD_HOME: yard, BOTYARD_PHONE_HOST: '127.0.0.1', BOTYARD_ENGINE_RUNS: 'off', BOTYARD_TIMETABLE: 'off', NODE_NO_WARNINGS: '1', ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])) }
  const child = spawn(process.execPath, [path.join(studio, 'server', 'studio.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGTERM'))
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const end = Date.now() + 60000
  while (!out.includes('Botyard →') && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 50))
  assert.match(out, /Botyard →/, out)
  const at = `http://127.0.0.1:${ports.PORT}/api/studio/throttle`
  const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

  // The owner, at this computer: a process that is not a bot's run. (When the crew runs this test, this test's own
  // process is a bot's run, so the owner's side is checked from a fresh process with no run variables, whose parents
  // are this test and its bot: then it is refused like any bot, which is the guard working.)
  const ownerIsHere = !botRunOf(process.pid)
  const owner = await fetchFrom({}, at, post({ level: 'light', scope: 'night' }))
  if (ownerIsHere) {
    assert.equal(owner.status, 200, JSON.stringify(owner))
    assert.equal(owner.body.configured, true)
    assert.deepEqual(f.sets(), ['light --night|owner (page)'])
  } else {
    assert.equal(owner.status, 403)
  }
  // A bot's run, its pass, a script's key: refused before the tool runs.
  const before = f.sets().length
  for (const [vars, headers] of [[{ BOTYARD_RUN_ID: 'run-1' }, {}], [{ BOTYARD_API_KEY: 'stu_abc' }, {}], [{}, { Authorization: 'Bearer stu_abc' }], [{}, { 'X-Botyard-Script': 'x', 'X-Botyard-Key': 'k' }]]) {
    const refused = await fetchFrom(vars, at, post({ level: 'full' }, headers))
    assert.equal(refused.status, 403, JSON.stringify({ vars, headers }))
    const read = await fetchFrom(vars, at, { headers })
    assert.equal(read.status, 403)
  }
  // Another site's page in the owner's browser is refused too.
  assert.equal((await fetchFrom({}, at, post({ level: 'full' }, { Origin: 'https://evil.example' }))).status, 403)
  assert.equal(f.sets().length, before, 'the tool was not run for any of them')

  // The phone's door: the owner's paired phone sets it; no key, no way in; a bot's run with a key is refused.
  const pair = await fetchFrom({}, `http://127.0.0.1:${ports.PORT}/api/studio/pair`, post({ name: 'Test phone', host: '127.0.0.1' }))
  if (!ownerIsHere) return
  const key = new URL(pair.body.link.replace('botyard:', 'http:')).searchParams.get('token')
  const door = `http://127.0.0.1:${ports.BOTYARD_PHONE_PORT}/v1/throttle`
  assert.equal((await fetchFrom({}, door, post({ level: 'medium' }))).status, 401)
  const phone = await fetchFrom({}, door, post({ level: 'medium' }, { Authorization: `Bearer ${key}` }))
  assert.equal(phone.status, 200, JSON.stringify(phone))
  assert.equal((await fetchFrom({}, door, { headers: { Authorization: `Bearer ${key}` } })).body.line, 'Heavy')
  assert.equal((await fetchFrom({ BOTYARD_RUN_ID: 'run-2' }, door, post({ level: 'full' }, { Authorization: `Bearer ${key}` }))).status, 403)
  assert.deepEqual(f.sets().slice(-1), ['medium|owner (phone)'])
})
