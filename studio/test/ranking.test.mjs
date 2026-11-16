/**
 * The owner ranks the projects in Botyard: the order is kept beside the shelf, and the panel lists
 * the projects in it, with any the ranking does not name after the ranked ones.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGuard, writeGuard } from '../server/lib/guard.mjs'

test('the ranking is saved and read back, cleaned, without touching the shelf', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-'))
  writeGuard(folder, { shelved: ['Tidewater'] })
  const saved = writeGuard(folder, { ranked: ['Lighthouse', ' Harbour ', 'Lighthouse', 7, ''] })
  assert.deepEqual(saved.ranked, ['Lighthouse', 'Harbour'])
  assert.deepEqual(saved.shelved, ['Tidewater'])
  // A later write of something else keeps the order.
  assert.deepEqual(writeGuard(folder, { limit: 5 }).ranked, ['Lighthouse', 'Harbour'])
  assert.deepEqual(readGuard(folder).ranked, ['Lighthouse', 'Harbour'])
})

test('projects come in the ranked order, unranked ones after in their own order', async () => {
  const { rankProjects } = await import('../src/ui/rank.js')
  const projects = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]
  assert.deepEqual(rankProjects(projects, ['C', 'A']).map((p) => p.name), ['C', 'A', 'B', 'D'])
  assert.deepEqual(rankProjects(projects, []).map((p) => p.name), ['A', 'B', 'C', 'D'])
  // A ranked name with no project is simply skipped.
  assert.deepEqual(rankProjects(projects, ['Gone', 'D']).map((p) => p.name), ['D', 'A', 'B', 'C'])
})

test('a save keeps the keys it does not own, such as capFloor, in their place', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-'))
  fs.writeFileSync(path.join(folder, 'guard.json'), JSON.stringify({ enabled: false, capFloor: 4, limit: 9, extra: { a: 1 } }))
  writeGuard(folder, { ranked: ['A'] })
  let file = JSON.parse(fs.readFileSync(path.join(folder, 'guard.json'), 'utf8'))
  assert.equal(file.capFloor, 4)
  assert.deepEqual(file.extra, { a: 1 })
  assert.deepEqual(file.ranked, ['A'])
  writeGuard(folder, { enabled: true, limit: 5, weekCeiling: 0.8, leadCeiling: 0.9, shelved: ['S'], ranked: ['B'], retired: ['R'] })
  file = JSON.parse(fs.readFileSync(path.join(folder, 'guard.json'), 'utf8'))
  assert.equal(file.capFloor, 4)
  assert.deepEqual(file.extra, { a: 1 })
  assert.deepEqual(Object.keys(file).slice(0, 4), ['enabled', 'capFloor', 'limit', 'extra'])
  assert.equal(file.limit, 5)
})
