// The Improvements page: one plain file the crew writes (own/improvements.py), one read-only view, the same list on the PC and the phone.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { improvementsView } from '../server/lib/crew.mjs'
import { improvementsScreen } from '../src/ui/studio-crew.js'

const folderWith = (content) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'improvements-'))
  if (content !== undefined) fs.writeFileSync(path.join(folder, 'improvements.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return folder
}
const ITEMS = [
  { id: 'IMP-1', title: 'Old briefs stay', path: 'briefs/tony', evidence: '212 files', fix: 'Move them', who: 'Freya', status: 'done', job: 'NGE-955', added: 100 },
  { id: 'IMP-2', title: 'Reports <b>name</b> no commit', path: 'own/review-guard.py', evidence: 'NGE-931', fix: 'Refuse it', who: 'Tony', status: 'new', job: '', added: 200 },
  { id: 'IMP-3', title: 'Second new one', path: 'x', evidence: '', fix: '', who: 'Freya', status: 'new', job: '', added: 300 },
  { id: 'IMP-4', title: 'Not worth it', path: 'y', status: 'rejected', added: 50 },
  { id: 'IMP-5', title: 'Odd state', path: 'z', status: 'sideways', added: 10 },
  { title: '' },
  'junk',
]

test('the view lists findings by state then newest, counts each state, and unknown states read as new', () => {
  const view = improvementsView({ folder: folderWith(ITEMS) })
  assert.deepEqual(view.items.map((i) => i.id), ['IMP-3', 'IMP-2', 'IMP-5', 'IMP-1', 'IMP-4'])
  assert.deepEqual(view.counts, { new: 3, accepted: 0, done: 1, rejected: 1 })
  assert.deepEqual(Object.keys(view.items[0]).sort(), ['added', 'evidence', 'fix', 'id', 'job', 'path', 'status', 'title', 'who'])
})

test('a missing, empty or broken file is an empty list, never an error', () => {
  for (const folder of [folderWith(), folderWith('{not json'), folderWith({ not: 'a list' })]) {
    assert.deepEqual(improvementsView({ folder }), { items: [], counts: { new: 0, accepted: 0, done: 0, rejected: 0 } })
  }
})

test('the PC page shows every field, escapes text, and filters by state', () => {
  const data = improvementsView({ folder: folderWith(ITEMS) })
  const all = improvementsScreen(data, '')
  for (const word of ['Finding', 'Where', 'Evidence', 'Smallest fix', 'Who', 'Status', 'Job', 'own/review-guard.py', 'NGE-955', 'None yet']) assert.ok(all.includes(word), word)
  assert.ok(all.includes('Reports &lt;b&gt;name&lt;/b&gt; no commit') && !all.includes('<b>name</b>'))
  for (const name of ['All 5', 'New 3', 'Accepted 0', 'Done 1', 'Rejected 1']) assert.ok(all.includes(name), name)
  const done = improvementsScreen(data, 'done')
  assert.ok(done.includes('Old briefs stay') && !done.includes('Second new one'))
  assert.ok(improvementsScreen(data, 'accepted').includes('Nothing in this state.'))
  assert.ok(improvementsScreen({ items: [], counts: {} }, '').includes('No improvements listed yet.'))
})
