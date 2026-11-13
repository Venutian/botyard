/**
 * The timetable runs the crew's helpers inside the service. These pin the rules every job gets:
 * its times, never two of itself at once, a time limit, a log that is kept short, a failure that is
 * shown, and that a yard's own helpers are laid over the ones that came with Botyard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTimetable, findCommand, nextAt, parseAt, parseSpan, readEnvFile, readTimetable, spanWords, timetableAct, timetableState, trimLog, withOwn } from '../server/lib/timetable.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-timetable-'))
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 20)) }
  return false
}

/** A timetable over small Node scripts in a temp folder. */
function make(jobs, options = {}) {
  const dir = options.dir || temp()
  const file = path.join(dir, 'timetable.json')
  fs.writeFileSync(file, JSON.stringify({ jobs }))
  const lines = []
  const table = createTimetable({
    file, stateFile: path.join(dir, 'state.json'), logDir: path.join(dir, 'logs'), tickMs: 25,
    vars: { node: process.execPath, scripts: dir, repo: dir }, log: (line) => lines.push(line), ...options,
  })
  return { dir, table, lines, job: (name) => table.state().jobs.find((job) => job.name === name) }
}
const script = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), body); return `{scripts}/${name}` }

test('lengths of time and times of day are read as written', () => {
  assert.equal(parseSpan('30s'), 30_000)
  assert.equal(parseSpan('5m'), 300_000)
  assert.equal(parseSpan('1h'), 3_600_000)
  assert.throws(() => parseSpan('soon'), /not a length of time/)
  assert.throws(() => parseSpan('0m'), /not a length of time/)
  assert.equal(spanWords(60_000), '1 minute')
  assert.equal(spanWords(5_400_000), '90 minutes')
  assert.deepEqual(parseAt('Mon 08:00'), { day: 1, hour: 8, minutes: [0] })
  assert.deepEqual(parseAt('04:30'), { day: null, hour: 4, minutes: [30] })
  assert.deepEqual(parseAt('*:35,05'), { day: null, hour: null, minutes: [5, 35] })
  assert.throws(() => parseAt('25:00'), /not a time of day/)
  assert.throws(() => parseAt('noon'), /not a time/)
})

test('the next time comes round by this computer\'s clock', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()
  // 12 November 2026 is a Thursday.
  assert.equal(nextAt(parseAt('04:30'), at(2026, 11, 12, 4, 29)), at(2026, 11, 12, 4, 30))
  assert.equal(nextAt(parseAt('04:30'), at(2026, 11, 12, 4, 30)), at(2026, 11, 13, 4, 30))
  assert.equal(nextAt(parseAt('*:05,35'), at(2026, 11, 12, 22, 6)), at(2026, 11, 12, 22, 35))
  assert.equal(nextAt(parseAt('*:05,35'), at(2026, 11, 12, 23, 40)), at(2026, 11, 13, 0, 5))
  assert.equal(nextAt(parseAt('Mon 08:00'), at(2026, 11, 12, 9, 0)), at(2026, 11, 16, 8, 0))
  assert.equal(nextAt(parseAt('Mon 08:00'), at(2026, 11, 16, 8, 0)), at(2026, 11, 23, 8, 0))
})

test('a mistake in the data file is said with the job\'s name', () => {
  const dir = temp()
  const write = (jobs) => { fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ jobs })); return path.join(dir, 't.json') }
  assert.throws(() => readTimetable(write([{ name: 'Bad Name', command: ['x'], every: '1m' }])), /name must be lower-case/)
  assert.throws(() => readTimetable(write([{ name: 'a', command: ['x'], every: '1m' }, { name: 'a', command: ['x'], every: '1m' }])), /job a: the name is used twice/)
  assert.throws(() => readTimetable(write([{ name: 'a', command: 'x', every: '1m' }])), /job a: "command" must be a list/)
  assert.throws(() => readTimetable(write([{ name: 'a', command: ['x'] }])), /job a: needs one of "every" or "at"/)
  assert.throws(() => readTimetable(write([{ name: 'a', command: ['x'], every: '1m', at: '04:30' }])), /needs one of/)
  assert.throws(() => readTimetable(write([{ name: 'a', command: ['x'], every: 'often' }])), /job a: "often" is not a length of time/)
  assert.equal(readTimetable(write([{ name: 'k', kind: 'keeper', command: ['x'] }]))[0].restartMs, 5000)
})

test('the timetable that comes with Botyard is valid, and every script it names is in the tree', () => {
  const jobs = readTimetable(path.join(repo, 'crew', 'timetable.json'))
  assert.ok(jobs.length > 0)
  assert.ok(jobs.some((job) => job.kind === 'timer'))
  for (const job of jobs) {
    assert.ok(job.what.length > 10, `${job.name} says what it is for`)
    // A new yard has no other copy of a script than the tree's, and nothing of one yard's own is in it.
    for (const part of job.command) {
      assert.doesNotMatch(part, /^\{own\}/, `${job.name} names a yard's own folder`)
      const named = /^\{(scripts|repo)\}\/(.+)$/.exec(part)
      if (named) assert.ok(fs.existsSync(path.join(repo, named[1] === 'scripts' ? 'crew' : '', named[2])), `${job.name}: ${part} is not in the tree`)
    }
  }
  // No path of one computer is written into it.
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'crew', 'timetable.json'), 'utf8'), /\/home\/|%h/)
})

test('a job run by hand leaves its output in its log and its result in the state', async () => {
  const dir = temp()
  const { table, job } = make([{ name: 'hello', what: 'Says hello', command: ['{node}', script(dir, 'hello.mjs', 'console.log("hello from the job", process.env.BOTYARD_API_URL)')], every: '1h' }], { dir, env: { BOTYARD_API_URL: 'http://127.0.0.1:1/api' } })
  assert.deepEqual(table.act({ action: 'run', name: 'hello' })[0], 200)
  assert.equal(job('hello').running, true)
  assert.ok(await until(() => !job('hello').running))
  const seen = job('hello')
  assert.equal(seen.lastOk, true)
  assert.equal(seen.lastError, '')
  assert.equal(seen.runs, 1)
  assert.equal(seen.when, 'every hour')
  assert.match(table.logOf('hello').log, /started\nhello from the job http:\/\/127\.0\.0\.1:1\/api\n--- .* finished/)
  assert.equal(fs.existsSync(path.join(dir, 'logs', 'hello.pid')), false)
})

test('a failure is shown with the run\'s last line, and written to the service\'s log', async () => {
  const dir = temp()
  const { table, job, lines } = make([{ name: 'broken', command: ['{node}', script(dir, 'broken.mjs', 'console.error("the engine did not answer"); process.exit(3)')], every: '1h' }], { dir })
  table.act({ action: 'run', name: 'broken' })
  assert.ok(await until(() => !job('broken').running))
  assert.equal(job('broken').lastOk, false)
  assert.equal(job('broken').lastError, 'Exit code 3: the engine did not answer')
  assert.equal(job('broken').failures, 1)
  assert.ok(lines.some((line) => line.includes('broken failed: Exit code 3')))
})

test('a job never overlaps itself', async () => {
  const dir = temp()
  const { table, job } = make([{ name: 'slow', command: ['{node}', script(dir, 'slow.mjs', 'setTimeout(() => {}, 600)')], every: '1s', first: '1s' }], { dir, force: 'on' })
  assert.equal(table.act({ action: 'run', name: 'slow' })[0], 200)
  const [status, body] = table.act({ action: 'run', name: 'slow' })
  assert.equal(status, 409)
  assert.match(body.error, /already running/)
  table.tick()
  assert.equal(job('slow').runs, 1)
  assert.ok(await until(() => !job('slow').running))
})

test('a run still going from before a restart is the run: a second is not started beside it', async () => {
  const dir = temp()
  const jobs = [{ name: 'long', command: ['{node}', script(dir, 'long.mjs', 'setTimeout(() => {}, 1500)')], every: '1h' }]
  const first = make(jobs, { dir })
  first.table.act({ action: 'run', name: 'long' })
  // The service is restarted: a new timetable over the same folders, the old run left going.
  const second = make(jobs, { dir })
  const [status, body] = second.table.act({ action: 'run', name: 'long' })
  assert.equal(status, 409)
  assert.match(body.error, /still running from before the service restarted/)
  assert.equal(second.job('long').running, true)
  assert.ok(await until(() => !first.job('long').running))
  second.table.tick()
  assert.equal(second.job('long').running, false)
})

test('a run over its time limit is stopped and says so', async () => {
  const dir = temp()
  const { table, job } = make([{ name: 'stuck', command: ['{node}', script(dir, 'stuck.mjs', 'setTimeout(() => {}, 60000)')], every: '1h', limit: '1s' }], { dir })
  table.act({ action: 'run', name: 'stuck' })
  assert.ok(await until(() => !job('stuck').running, 6000))
  assert.equal(job('stuck').lastOk, false)
  assert.equal(job('stuck').lastError, 'Stopped after 1 second: over its time limit')
})

test('timers run on their times while the timetable is on, and not while it is off', async () => {
  const dir = temp()
  const counter = path.join(dir, 'count')
  const jobs = [{ name: 'tick', command: ['{node}', script(dir, 'tick.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'x')`)], every: '1s', first: '1s' }]
  const { table, job } = make(jobs, { dir })
  assert.equal(table.state().state, 'on')
  table.start()
  assert.ok(job('tick').nextAt > Date.now())
  assert.ok(await until(() => fs.existsSync(counter) && fs.readFileSync(counter, 'utf8').length >= 2, 6000), 'ran twice')
  assert.equal(table.act({ action: 'off' })[1].state, 'off')
  await until(() => !job('tick').running)
  const before = fs.readFileSync(counter, 'utf8').length
  await new Promise((resolve) => setTimeout(resolve, 1300))
  assert.equal(fs.readFileSync(counter, 'utf8').length, before)
  await table.stop()
  // The choice is kept: the next start of the service finds it off.
  assert.equal(make(jobs, { dir }).table.state().state, 'off')
})

test('a yard\'s own jobs are laid over the tree\'s: the same name replaces, a new name is added', () => {
  const tree = [{ name: 'health', what: 'tree' }, { name: 'fetch', what: 'tree' }]
  const own = [{ name: 'report', what: 'mine' }, { name: 'fetch', what: 'mine' }]
  assert.deepEqual(withOwn(tree, own), [
    { name: 'health', what: 'tree', own: false }, { name: 'fetch', what: 'mine', own: true }, { name: 'report', what: 'mine', own: true },
  ])
  assert.deepEqual(withOwn(tree, []).map((job) => job.own), [false, false])
})

test('own helpers run from the yard\'s own folder, and are shown as its own', async () => {
  const dir = temp()
  const ownDir = path.join(dir, 'own')
  fs.mkdirSync(ownDir)
  fs.writeFileSync(path.join(ownDir, 'mine.mjs'), 'console.log("from my own folder")')
  fs.writeFileSync(path.join(ownDir, 'timetable.json'), JSON.stringify({ jobs: [
    { name: 'mine', what: 'A helper of this yard alone', command: ['{node}', '{own}/mine.mjs'], every: '1h' },
    { name: 'shared', what: 'This yard does it another way', command: ['{node}', '-e', 'console.log("own way")'], every: '2h' },
  ] }))
  const { table, job } = make([{ name: 'shared', what: 'The way that came with Botyard', command: ['{node}', '-e', '0'], every: '1h' }, { name: 'plain', command: ['{node}', '-e', '0'], every: '1h' }],
    { dir, ownFile: path.join(ownDir, 'timetable.json'), vars: { node: process.execPath, scripts: dir, repo: dir, own: ownDir } })
  assert.deepEqual(table.state().jobs.map((j) => [j.name, j.own]), [['shared', true], ['plain', false], ['mine', true]])
  assert.equal(job('shared').when, 'every 2 hours')
  assert.equal(job('mine').ready, true)
  table.act({ action: 'run', name: 'mine' })
  assert.ok(await until(() => !job('mine').running))
  assert.match(table.logOf('mine').log, /from my own folder/)
  fs.rmSync(path.join(ownDir, 'mine.mjs'))
  assert.equal(job('mine').notReady, 'mine.mjs is not there')
})

test('a mistake in a yard\'s own timetable is said, and the helpers that came with Botyard still run', () => {
  const dir = temp()
  const ownFile = path.join(dir, 'own.json')
  fs.writeFileSync(ownFile, JSON.stringify({ jobs: [{ name: 'Bad Name', command: ['x'], every: '1m' }] }))
  const { table } = make([{ name: 'plain', command: ['{node}', '-e', '0'], every: '1h' }], { dir, ownFile })
  assert.equal(table.state().state, 'on')
  assert.match(table.state().why, /Your own timetable .* could not be read, so only the helpers that came with Botyard are listed: .*name must be lower-case/)
  assert.deepEqual(table.state().jobs.map((j) => j.name), ['plain'])
  // No own file at all is the usual case and nothing to say.
  assert.equal(make([{ name: 'plain', command: ['{node}', '-e', '0'], every: '1h' }], { dir: temp(), ownFile: path.join(dir, 'none.json') }).table.state().why, '')
  // The service's own flag beats the saved state of the whole timetable.
  assert.equal(make([{ name: 'plain', command: ['{node}', '-e', '0'], every: '1h' }], { dir: temp(), force: 'off' }).table.state().state, 'off')
})

test('one job can be turned off and on, and that is kept', () => {
  const dir = temp()
  const jobs = [{ name: 'a', command: ['{node}', '-e', '0'], every: '1m' }, { name: 'b', command: ['{node}', '-e', '0'], every: '1m', on: false }]
  const { table, job } = make(jobs, { dir })
  assert.equal(job('a').on, true)
  assert.equal(job('b').on, false)
  table.act({ action: 'off', name: 'a' })
  table.act({ action: 'on', name: 'b' })
  const again = make(jobs, { dir })
  assert.equal(again.job('a').on, false)
  assert.equal(again.job('b').on, true)
  assert.equal(table.act({ action: 'on', name: 'nobody' })[0], 404)
  assert.equal(table.act({ action: 'dance' })[0], 400)
  assert.equal(table.act({ action: 'run' })[0], 400)
})

test('a job whose script is not on this computer is shown as not ready and is not started', () => {
  const dir = temp()
  const { table, job } = make([
    { name: 'gone', command: ['{node}', '{scripts}/nowhere.py'], every: '1m' },
    { name: 'no-tool', command: ['a-tool-nobody-has', 'run'], every: '1m' },
    { name: 'no-keys', kind: 'keeper', command: ['{node}', '-e', '0'], envFile: '{repo}/tunnel.env' },
  ], { dir })
  assert.equal(job('gone').ready, false)
  assert.equal(job('gone').notReady, 'nowhere.py is not there')
  assert.equal(job('no-tool').notReady, 'a-tool-nobody-has is not installed')
  assert.equal(job('no-keys').notReady, 'Not set up on this computer yet')
  const [status, body] = table.act({ action: 'run', name: 'gone' })
  assert.equal(status, 409)
  assert.match(body.error, /gone was not started\. nowhere\.py is not there/)
})

test('a keeper is kept running: started again when it stops, and stopped with the service', async () => {
  const dir = temp()
  const starts = path.join(dir, 'starts')
  const { table, job } = make([{ name: 'server', kind: 'keeper', restart: '1s', command: ['{node}', script(dir, 'server.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(starts)}, 'x'); setTimeout(() => process.exit(fs.readFileSync(${JSON.stringify(starts)}, 'utf8').length === 1 ? 2 : 0), fs.readFileSync(${JSON.stringify(starts)}, 'utf8').length === 1 ? 50 : 60000)`)] }], { dir })
  table.start()
  assert.equal(job('server').when, 'always on')
  assert.ok(await until(() => fs.existsSync(starts) && fs.readFileSync(starts, 'utf8').length === 2, 8000), 'started again after it stopped')
  assert.equal(job('server').running, true)
  assert.equal(job('server').failures, 1)
  await table.stop()
  assert.equal(job('server').running, false)
  assert.equal(job('server').lastOk, true)
})

test('a time of day missed while the service was off is run at the next start, where the job asks', async () => {
  const dir = temp()
  const ran = path.join(dir, 'ran')
  const body = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ran)}, 'x')`
  const jobs = [
    { name: 'weekly', command: ['{node}', script(dir, 'weekly.mjs', body)], at: 'Mon 08:00', catchUp: true },
    { name: 'plain', command: ['{node}', script(dir, 'plain.mjs', 'process.exit(1)')], at: 'Mon 08:00' },
  ]
  const longAgo = Date.now() - 15 * 86_400_000
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ last: { weekly: { lastStart: longAgo }, plain: { lastStart: longAgo } } }))
  const { table, job } = make(jobs, { dir })
  table.start()
  assert.ok(await until(() => fs.existsSync(ran)), 'the missed run was made')
  assert.equal(job('plain').runs, 0)
  assert.ok(job('plain').nextAt > Date.now())
  await table.stop()
})

test('a log is kept short, cut at a line', () => {
  const file = path.join(temp(), 'a.log')
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n')
  trimLog(file, 4000, 1000)
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.length <= 1100)
  assert.match(text, /^\(earlier output trimmed\)\nline \d+\n/)
  assert.match(text, /line 1999\n$/)
})

test('an environment file gives names and values, and a command is found the way a shell finds it', () => {
  const file = path.join(temp(), 'x.env')
  fs.writeFileSync(file, '# a note\nTUNNEL_TOKEN=abc=def\nexport NAME="two words"\n\nbad line\n')
  assert.deepEqual(readEnvFile(file), { TUNNEL_TOKEN: 'abc=def', NAME: 'two words' })
  assert.equal(findCommand(process.execPath), process.execPath)
  assert.equal(findCommand('a-tool-nobody-has'), null)
  assert.ok(findCommand('node', { PATH: path.dirname(process.execPath) }))
})

test('with no timetable in this process, the page is told so', () => {
  assert.equal(timetableState().state, 'off')
  assert.deepEqual(timetableState().jobs, [])
  assert.equal(timetableAct({ action: 'on' })[0], 409)
})
