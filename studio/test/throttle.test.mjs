/**
 * The PC load control: the route takes six level names and nothing else, reads the tool's real `show --json`,
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
import { aboutLevels, LEVELS, readShow, stateLine, throttleAct, throttleState, throttleTool } from '../server/lib/throttle.mjs'
import { CONFIRM, throttleHtml, throttleLayerHtml } from '../src/ui/throttle.js'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

/** What the real tool prints for `show --json` while Stop holds two jobs, one of which has since gone. */
const FULL = JSON.stringify({
  day: 'stop', night: 'jog', now: 'stop', heldMB: 9626,
  paused: [{ pid: 11, name: 'voices', rssMB: 7168, state: 'ok' }, { pid: 12, name: 'build', rssMB: 2458, state: 'ok' }, { pid: 13, name: 'gone', rssMB: 500, state: 'gone' }],
})

/** A fake tool that logs its arguments and who it was told set them, and answers `show` from a file. */
function fake(show = JSON.stringify({ day: 'crawl', night: 'crawl', now: 'crawl', paused: [], heldMB: 0 })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-'))
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(path.join(dir, 'show.txt'), show)
  fs.writeFileSync(tool, `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$BOTYARD_SET_BY" >> "${dir}/calls.log"\nif [ "$1" = show ]; then cat "${dir}/show.txt"; else exit 0; fi\n`, { mode: 0o755 })
  const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
  return { tool, dir, calls, sets: () => calls().filter((c) => !c.startsWith('show')) }
}

test('only the six level names reach the tool; anything else is refused before it runs', async () => {
  const f = fake()
  const marker = path.join(f.dir, 'ran')
  for (const bad of ['', 'FULL', `heavy; touch ${marker}`, `$(touch ${marker})`, '--day', 'light --night', '--help', 'none\nfull', 5, null, ['crawl'], {}]) {
    const [status, body] = await throttleAct({ level: bad }, { tool: f.tool })
    assert.equal(status, 400, JSON.stringify(bad))
    assert.match(body.error, /must be one of/)
  }
  assert.equal((await throttleAct({ level: 'jog', scope: 'x; id' }, { tool: f.tool }))[0], 400)
  assert.equal((await throttleAct(null, { tool: f.tool }))[0], 400)
  assert.deepEqual(f.calls(), [], 'the tool was never run')
  assert.equal(fs.existsSync(marker), false)
})

test('each valid level runs the tool with plain arguments, day and night when asked, and says who asked', async () => {
  const f = fake()
  for (const level of LEVELS) assert.equal((await throttleAct({ level }, { tool: f.tool, setBy: 'owner (page)' }))[0], 200)
  await throttleAct({ level: 'jog', scope: 'night' }, { tool: f.tool, setBy: 'owner (phone)' })
  await throttleAct({ level: 'run', scope: 'day' }, { tool: f.tool, setBy: 'owner (page)' })
  assert.deepEqual(f.sets(), ['sprint|owner (page)', 'run|owner (page)', 'jog|owner (page)', 'walk|owner (page)', 'crawl|owner (page)', 'stop|owner (page)', 'jog --night|owner (phone)', 'run --day|owner (page)'])
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
  assert.deepEqual([s.now, s.day, s.night, s.paused, s.heldGb], ['stop', 'stop', 'jog', 2, 9.4])
  assert.equal(stateLine(s), 'Stop: 2 jobs paused, 9.4 GB held')
  assert.equal(stateLine(readShow(JSON.stringify({ now: 'stop', day: 'stop', night: 'stop', paused: [{ state: 'ok', rssMB: 1 }], heldMB: 0 }))), 'Stop: 1 job paused')
  assert.equal(stateLine(readShow(JSON.stringify({ now: 'jog', day: 'jog', night: 'run', paused: [], heldMB: 0 }))), 'Jog (day Jog, night Run)')
  for (const junk of ['', 'day heavy', '[]', '{"now":"zoom"}', 'null']) assert.equal(stateLine(readShow(junk)), 'The PC load is not known', junk)
  // The tool's own line of what the level lets run is shown as it is, control characters taken out.
  const noted = readShow(JSON.stringify({ now: 'run', day: 'run', night: 'run', paused: [], heldMB: 0, note: 'None: up to 6 Claude, 6 free, 4 heavy\n<b>' }))
  assert.equal(stateLine(noted), 'None: up to 6 Claude, 6 free, 4 heavy <b>')
  assert.match(throttleHtml({ configured: true, ...noted, line: stateLine(noted) }), /None: up to 6 Claude, 6 free, 4 heavy &lt;b&gt;<\/span>/)
})

test('a tool that fails is reported, and the state says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-bad-'))
  const tool = path.join(dir, 'tool.sh')
  fs.writeFileSync(tool, '#!/bin/sh\necho broken >&2\nexit 3\n', { mode: 0o755 })
  const [status, body] = await throttleAct({ level: 'run' }, { tool })
  assert.equal(status, 502)
  assert.match(body.error, /broken/)
  assert.equal((await throttleState({ tool })).line, 'The pace could not be read')
  assert.equal((await throttleState({ tool: fake(FULL).tool })).line, 'Stop: 2 jobs paused, 9.4 GB held')
})

test('a yard that names no tool has no control: the state says so and a change is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-none-'))
  const settingsFile = path.join(dir, 'pc-load.json')
  const env = {}
  assert.equal(throttleTool({ settingsFile, env }), '')
  assert.deepEqual(await throttleState({ settingsFile, env }), { configured: false, levels: LEVELS })
  assert.equal((await throttleAct({ level: 'run' }, { settingsFile, env }))[0], 404)
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

test('one pace scale: Sprint first, each level described from the server, old names still accepted', async () => {
  assert.deepEqual(LEVELS, ['sprint', 'run', 'jog', 'walk', 'crawl', 'stop'])
  const about = aboutLevels({ run: { says: '', nums: { claude: 6, free: 10, heavy: 4 } } })
  assert.deepEqual(about.map((a) => a.name), ['Sprint', 'Run', 'Jog', 'Walk', 'Crawl', 'Stop'])
  assert.equal(about[0].says, 'Sprint: everything at once, no weekly Claude limit; the week may run out early')
  assert.equal(about[1].numbers, 'Up to 6 Claude, 10 free, 4 heavy')
  assert.ok(about[0].warn && about[5].warn && !about[2].warn)
  const state = { configured: true, now: 'jog', day: 'jog', night: 'jog', line: '', label: 'Pace', labelSays: 'How fast the crew works.', about }
  const html = throttleHtml(state)
  assert.ok(html.indexOf('data-level="sprint"') < html.indexOf('data-level="run"'))
  assert.match(html, /title="Sprint: everything at once, no weekly Claude limit; the week may run out early"/)
  assert.match(html, /title="Run: full speed, keeps to the weekly Claude pace. Up to 6 Claude, 10 free, 4 heavy"/)
  assert.match(html, /title="How fast the crew works.">Pace<\/span>/)
  const f = fake()
  for (const [old, now] of [['max', 'sprint'], ['turbo', 'sprint'], ['none', 'run'], ['light', 'jog'], ['medium', 'walk'], ['heavy', 'crawl'], ['full', 'stop'], ['pause', 'stop']]) {
    assert.equal((await throttleAct({ level: old }, { tool: f.tool }))[0], 200, old)
    assert.equal(f.sets().at(-1).split('|')[0], now)
  }
  assert.equal(readShow(JSON.stringify({ now: 'light', day: 'light', night: 'full', paused: [], heldMB: 0 })).night, 'stop')
})

test('the page shows each level as the chosen one, with names for a screen reader', () => {
  for (const now of LEVELS) {
    const html = throttleHtml({ configured: true, now, day: now, night: now, line: stateLine({ now, paused: 0 }) })
    assert.match(html, /role="radiogroup"/)
    assert.equal((html.match(/role="radio"/g) || []).length, 6)
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1)
    assert.match(html, new RegExp(`aria-checked="true"[^>]*data-level="${now}"`))
  }
})

test('full shows its stop icon, its paused jobs and Resume; the others offer no Resume', () => {
  const full = throttleHtml({ configured: true, now: 'stop', line: 'Stop: 2 jobs paused, 9.4 GB held' })
  assert.match(full, /Resume/)
  assert.match(full, /ld-icon/)
  assert.match(full, /Stop: 2 jobs paused, 9\.4 GB held/)
  assert.doesNotMatch(throttleHtml({ configured: true, now: 'crawl', line: 'Crawl' }), /Resume/)
  // The line only says what the buttons cannot: a plain level shows none, a day and night split or an error does.
  assert.match(throttleHtml({ configured: true, now: 'crawl', day: 'crawl', night: 'crawl', line: 'Crawl' }), /<span class="ld-line"[^>]*><\/span>/)
  assert.match(throttleHtml({ configured: true, now: 'jog', day: 'jog', night: 'run', line: 'Jog (day Jog, night Run)' }), /day Jog, night Run/)
  assert.match(throttleHtml({ configured: true, now: 'run', line: 'Run' }, { error: 'The load could not be set' }), /could not be set/)
})

test('pressing Full asks once, with the words the owner gave', () => {
  const html = throttleLayerHtml({ now: 'crawl', line: 'Crawl' }, { confirming: true })
  assert.ok(html.includes(CONFIRM))
  assert.match(html, /data-act="load-full-yes"/)
  assert.doesNotMatch(throttleLayerHtml({ now: 'crawl', line: 'Crawl' }), /alertdialog/)
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
  const owner = await fetchFrom({}, at, post({ level: 'jog', scope: 'night' }))
  if (ownerIsHere) {
    assert.equal(owner.status, 200, JSON.stringify(owner))
    assert.equal(owner.body.configured, true)
    assert.deepEqual(f.sets(), ['jog --night|owner (page)'])
  } else {
    assert.equal(owner.status, 403)
  }
  // A bot's run, its pass, a script's key: refused before the tool runs.
  const before = f.sets().length
  for (const [vars, headers] of [[{ BOTYARD_RUN_ID: 'run-1' }, {}], [{ BOTYARD_API_KEY: 'stu_abc' }, {}], [{}, { Authorization: 'Bearer stu_abc' }], [{}, { 'X-Botyard-Script': 'x', 'X-Botyard-Key': 'k' }]]) {
    const refused = await fetchFrom(vars, at, post({ level: 'stop' }, headers))
    assert.equal(refused.status, 403, JSON.stringify({ vars, headers }))
    const read = await fetchFrom(vars, at, { headers })
    assert.equal(read.status, 403)
  }
  // Another site's page in the owner's browser is refused too.
  assert.equal((await fetchFrom({}, at, post({ level: 'stop' }, { Origin: 'https://evil.example' }))).status, 403)
  assert.equal(f.sets().length, before, 'the tool was not run for any of them')

  // The phone's door: the owner's paired phone sets it; no key, no way in; a bot's run with a key is refused.
  const pair = await fetchFrom({}, `http://127.0.0.1:${ports.PORT}/api/studio/pair`, post({ name: 'Test phone', host: '127.0.0.1' }))
  if (!ownerIsHere) return
  const key = new URL(pair.body.link.replace('botyard:', 'http:')).searchParams.get('token')
  const door = `http://127.0.0.1:${ports.BOTYARD_PHONE_PORT}/v1/throttle`
  assert.equal((await fetchFrom({}, door, post({ level: 'walk' }))).status, 401)
  const phone = await fetchFrom({}, door, post({ level: 'walk' }, { Authorization: `Bearer ${key}` }))
  assert.equal(phone.status, 200, JSON.stringify(phone))
  assert.equal((await fetchFrom({}, door, { headers: { Authorization: `Bearer ${key}` } })).body.line, 'Crawl')
  assert.equal((await fetchFrom({ BOTYARD_RUN_ID: 'run-2' }, door, post({ level: 'stop' }, { Authorization: `Bearer ${key}` }))).status, 403)
  assert.deepEqual(f.sets().slice(-1), ['walk|owner (phone)'])
})

test('a press on Resume or the day/night arrow acts as itself, not as the level the bar already shows', async () => {
  const { mountThrottle } = await import('../src/ui/throttle.js')
  const listeners = {}
  const box = { top: 0, bottom: 10, right: 10 }
  const make = () => ({
    dataset: {}, style: {}, innerHTML: '', offsetParent: null,
    addEventListener(type, fn) { listeners[type] = fn }, querySelector: () => null, getBoundingClientRect: () => box,
  })
  const host = make(); const layer = make()
  globalThis.document = { body: make() }
  const calls = []
  const call = async (url, payload) => { calls.push(payload); return { configured: true, now: 'stop', day: 'stop', night: 'stop', line: 'Stop' } }
  const m = mountThrottle(host, { call, layer, every: 3600_000 })
  await new Promise((r) => setTimeout(r, 5))
  // A target whose nearest [data-act] is `act`; the bar itself carries its state, as in the page.
  const press = (act) => ({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act } } : sel === '[data-level]' ? { dataset: { level: 'stop' } } : null) } })
  try {
    const before = calls.length
    listeners.click(press('load-more'))
    assert.equal(calls.length, before, 'the arrow opens the popover and sets nothing')
    assert.match(layer.innerHTML, /id="ld-pop" role="dialog" aria-label="Day and night load">/)
  } finally {
    m.destroy()
    delete globalThis.document
  }
})
