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
