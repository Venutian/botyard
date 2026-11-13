/**
 * The phone's short list of coding sessions that are live on this computer. Pinned: only records
 * written in the last two minutes count, only the folder and the first request are passed on, and
 * a sample yard or a person who asked not to be looked at gets nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { liveSessions, readStart } from '../server/lib/sessions.mjs'

const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime()
function computer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'))
  const put = (file, lines, minutesAgo) => {
    const full = path.join(home, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n')
    const at = new Date(NOW - minutesAgo * 60_000)
    fs.utimesSync(full, at, at)
  }
  return { home, env: { HOME: home }, put }
}

test('a record written to in the last two minutes is a live session: its tool, its project and what it was asked', async () => {
  const pc = computer()
  pc.put('.claude/projects/-home-someone-shop/aaaa.jsonl', [
    { type: 'summary', summary: 'earlier' },
    { type: 'user', cwd: '/home/someone/shop', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', cwd: '/home/someone/shop', message: { role: 'user', content: [{ type: 'text', text: 'Make the checkout\n  one page' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
  ], 0.5)
  pc.put('.codex/sessions/2026/11/13/rollout-2026-11-13T14-58-00-bbbb.jsonl', [
    { type: 'session_meta', payload: { id: 'bbbb', cwd: '/home/someone/tides' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Low water to the minute' }] } },
  ], 1.5)
  pc.put('.claude/projects/-home-someone-old/cccc.jsonl', [{ type: 'user', cwd: '/home/someone/old', message: { role: 'user', content: 'Long finished' } }], 30)
  const list = await liveSessions({ env: pc.env, now: NOW })
  assert.deepEqual(list.map(({ title, harness, project }) => ({ title, harness, project })), [
    { title: 'Make the checkout one page', harness: 'claude-code', project: 'shop' },
    { title: 'Low water to the minute', harness: 'codex', project: 'tides' },
  ])
  assert.ok(list[0].at > list[1].at, 'newest first')
})

test('a session in a job\'s own folder is known by its project; a long request is cut; a record that says nothing is still listed', async () => {
  const pc = computer()
  pc.put('.claude/projects/x/job.jsonl', [{ type: 'user', cwd: '/home/someone/shop/.botyard/worktrees/LH-12-checkout', message: { role: 'user', content: 'x'.repeat(200) } }], 0)
  pc.put('.claude/projects/y/blank.jsonl', ['not json at all', ''], 1)
  const [job, blank] = await liveSessions({ env: pc.env, now: NOW })
  assert.equal(job.project, 'shop')
  assert.equal(job.title.length, 80)
  assert.ok(job.title.endsWith('…'))
  assert.deepEqual([blank.title, blank.project], ['Session', ''])
})

test('the list is short, and the tools\' own folders can be somewhere else', async () => {
  const pc = computer()
  for (let i = 0; i < 20; i++) pc.put(`elsewhere/projects/p/s${i}.jsonl`, [{ type: 'user', cwd: `/w/p${i}`, message: { role: 'user', content: `job ${i}` } }], i / 60)
  pc.put('.codex/sessions/2026/11/12/rollout-late.jsonl', [{ type: 'session_meta', payload: { cwd: '/w/night' } }], 1)
  pc.put('.codex/sessions/2026/11/10/rollout-old-but-touched.jsonl', [{ type: 'session_meta', payload: { cwd: '/w/never' } }], 1)
  const list = await liveSessions({ env: { ...pc.env, CLAUDE_CONFIG_DIR: path.join(pc.home, 'elsewhere') }, now: NOW, limit: 5 })
  assert.equal(list.length, 5)
  assert.equal(list[0].title, 'job 0')
  const all = await liveSessions({ env: { ...pc.env, CLAUDE_CONFIG_DIR: path.join(pc.home, 'elsewhere') }, now: NOW, limit: 50 })
  assert.ok(all.some((s) => s.project === 'night'), 'a session that began yesterday and is still going')
  assert.ok(!all.some((s) => s.project === 'never'), 'days further back are not searched')
})

test('a sample yard, a person who asked not to be looked at, and a computer with no tools get an empty list', async () => {
  const pc = computer()
  pc.put('.claude/projects/p/s.jsonl', [{ type: 'user', cwd: '/w/p', message: { role: 'user', content: 'private work' } }], 0)
  assert.deepEqual(await liveSessions({ env: { ...pc.env, BOTYARD_DEMO: '1' }, now: NOW }), [])
  assert.deepEqual(await liveSessions({ env: { ...pc.env, BOTYARD_SCAN: 'off' }, now: NOW }), [])
  assert.deepEqual(await liveSessions({ env: { HOME: path.join(pc.home, 'nobody') }, now: NOW }), [])
})

test('only the folder and the first request are read out of a record', () => {
  assert.deepEqual(readStart('{"type":"user","cwd":"/a/b","message":{"role":"user","content":"first"}}\n{"type":"user","message":{"role":"user","content":"second"}}'), { cwd: '/a/b', asked: 'first' })
  assert.deepEqual(readStart('{"type":"assistant","message":{"role":"assistant","content":"I said this"}}'), { cwd: '', asked: '' })
  assert.deepEqual(readStart('{"cut off in the mid'), { cwd: '', asked: '' })
})
