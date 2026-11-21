/**
 * What runs on this computer now (server/lib/heavy.mjs, src/ui/running.js): the crew's processes grouped by run and
 * helper from their tags or a parent's, named in plain words, the other heavy programs apart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, group, readProcess, sample } from '../server/lib/heavy.mjs'
import { chipLevel, chipText, runningHtml } from '../src/ui/running.js'

const GB = 1024 * 1024 * 1024
const p = (pid, ppid, cmd, { cpu = 0, rss = 0, env = {}, crew = null } = {}) => ({ pid, ppid, cmd, cpu, rss, ageS: 120, env, crew })

test('a command line is named by the script an interpreter runs, or the program, or the model a coding tool was given', () => {
  assert.equal(describe(['/venv/bin/python', '/tools/voices/voices.py', '--lines', 'x.json']).what, 'voices.py (voices)')
  assert.equal(describe(['/usr/bin/python3', '-I', '/crew/fallback.py']).what, 'fallback.py (crew)')
  assert.equal(describe(['node', '--input-type=module', '-e', 'code']).what, 'node (inline code)')
  assert.equal(describe(['/bin/opencode', 'run', '-m', 'openrouter/x:free', 'hi']).what, 'opencode on openrouter/x:free')
  assert.equal(describe(['/opt/godot/godot', '--headless']).what, 'godot')
  assert.equal(describe(['/usr/lib/app/electron --type=renderer --lang=en']).what, 'electron')
})

test('the crew\'s work is grouped by run, a child without tags belongs to its tagged parent, the rest is other programs', () => {
  const run = { BOTYARD_RUN_ID: 'r1', BOTYARD_JOB_ID: 'j1', BOTYARD_BOT_ID: 'b1' }
  const list = [
    p(10, 1, ['python3', '/t/voices.py'], { cpu: 130, rss: 7 * GB, crew: run }),
    p(11, 10, ['python3', '/t/judge.py'], { cpu: 40, rss: 0.2 * GB, crew: run }),
    p(12, 10, ['python3', '/t/judge.py'], { cpu: 50, rss: 0.2 * GB, crew: run }),
    p(20, 1, ['python3', '/crew/scan.py'], { cpu: 2, rss: 0.03 * GB, crew: { BOTYARD_HELPER: 'waiting-scan' } }),
    p(30, 1, ['/opt/brave/brave'], { cpu: 60, rss: 0.5 * GB }),
    p(31, 1, ['/usr/bin/sleep', '9'], { cpu: 0, rss: 0 }),
  ]
  const out = group(list, { names: { bot: (id) => (id === 'b1' ? 'Bob' : ''), job: (id) => (id === 'j1' ? { identifier: 'TRY-9', title: 'Voice the speaker' } : null) }, cores: 12, totalMB: 32768 })
  assert.equal(out.work.length, 2)
  const [first, second] = out.work
  assert.deepEqual([first.bot, first.job.ref, first.cpu, first.count, first.heavy], ['Bob', 'TRY-9', 220, 3, true])
  assert.deepEqual(first.top.map((t) => [t.what, t.count]), [['voices.py (t)', 1], ['judge.py (t)', 2]])
  assert.deepEqual([second.kind, second.helper, second.heavy], ['helper', 'waiting-scan', false])
  assert.deepEqual(out.others.map((o) => o.what), ['brave'], 'only heavy programs that are not the crew\'s')
  assert.equal(out.crew.heavy, 1)
})

test('a process is read from /proc, its tags from its environment, and its processor share from two readings', async () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-proc-'))
  const put = (pid, ppid, ticks, env) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true })
    // pid (comm) state ppid ... utime(14) stime(15) ... starttime(22) vsize rss(24)
    const fields = ['S', ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, ticks, 0, 0, 0, 0, 0, 0, 0, 500, 0, 1000]
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (python (x)) ${fields.join(' ')}`)
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), 'python3\0/t/voices.py\0')
    fs.writeFileSync(path.join(proc, String(pid), 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0'))
  }
  fs.writeFileSync(path.join(proc, 'uptime'), '100.0 50.0')
  put(7, 1, 100, { BOTYARD_RUN_ID: 'r7', HOME: '/home/x', BOTYARD_API_KEY: 'never-read' })
  const one = readProcess(7, proc)
  assert.deepEqual([one.ppid, one.ticks, one.rss, one.cmd[1]], [1, 100, 1000 * 4096, '/t/voices.py'])
  assert.deepEqual(one.env, { BOTYARD_RUN_ID: 'r7' }, 'only the tags are kept, never a key')
  let n = 0
  const read = () => { n += 1; if (n === 2) put(7, 1, 150, { BOTYARD_RUN_ID: 'r7' }); const m = new Map(); m.set(7, readProcess(7, proc)); return m }
  const [s] = await sample({ proc, windowMs: 500, read })
  assert.ok(s.cpu > 80 && s.cpu < 110, `50 ticks in about half a second is about one core (${s.cpu})`)
  assert.equal(s.crew.BOTYARD_RUN_ID, 'r7')
  assert.equal(s.ageS, 95)
  fs.rmSync(proc, { recursive: true, force: true })
})

test('the chip says what the crew takes of the PC and colours it; the list names bot, job and programs', () => {
  const data = { readable: true, at: 0, cores: 12, totalMB: 32768, crew: { cpu: 840, memMB: 21000, heavy: 2, count: 3 }, work: [{ kind: 'run', runId: '11111111-2222-3333-4444-555555555555', bot: 'Bob', job: { ref: 'TRY-9', title: 'Voice the <speaker>' }, cpu: 392, memMB: 7232, ageS: 3700, count: 31, heavy: true, top: [{ what: 'judge.ts (design)', count: 31, cpu: 269, memMB: 7000 }] }], others: [{ what: 'brave', cpu: 60, memMB: 500 }, { what: 'studio.mjs (server)', self: true, cpu: 40, memMB: 300 }] }
  assert.equal(chipText(data), 'PC: 70% · 20.5 GB')
  assert.equal(chipLevel(data), 'hot')
  assert.equal(chipText({ readable: true, cores: 12, crew: { count: 0 } }), 'PC: quiet')
  const html = runningHtml(data)
  assert.match(html, /Bob/)
  assert.match(html, /TRY-9<\/span> Voice the &lt;speaker&gt;/)
  assert.match(html, /judge\.ts \(design\) <b>×31<\/b>/)
  assert.match(html, /1 h 2 min/)
  assert.match(html, /data-run="11111111-2222-3333-4444-555555555555"/)
  assert.match(html, /brave/)
  assert.doesNotMatch(html, /studio\.mjs/, 'Botyard itself is not listed as another program')
  assert.match(runningHtml({ readable: false, why: 'Only a Linux computer' }), /Only a Linux computer/)
})
