/**
 * One wake per job: a script's result posted with `wake: false` is kept on the job without waking its
 * bot, so a job with several arms wakes its session once, on the last arm's result.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'

test('a comment with wake: false wakes nobody; an ordinary one wakes the job\'s bot', async () => {
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-quiet-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body) => engine.handle({ method, url, body })
  const id = (await call('GET', '/api/companies')).body[0].id
  const bot = (await call('POST', `/api/companies/${id}/agents`, { name: 'Ada', adapterType: 'claude_local' })).body
  const job = (await call('POST', `/api/companies/${id}/issues`, { title: 'Two sim arms', assigneeAgentId: bot.id, status: 'in_progress' })).body
  // The job's own first wake is taken, as a run would take it, so each comment's wake can be seen.
  for (const w of engine.store.objects("SELECT raw FROM wakes WHERE status = 'queued'")) engine.store.put('wakes', { ...w, status: 'finished' })
  const wakes = () => engine.store.objects("SELECT raw FROM wakes WHERE status = 'queued'").length
  const before = wakes()
  const quiet = await call('POST', `/api/issues/${job.id}/comments`, { body: 'Arm 1 of 2 finished.', wake: false })
  assert.equal(quiet.status, 201)
  assert.equal(wakes(), before)
  await call('POST', `/api/issues/${job.id}/comments`, { body: 'Arm 2 of 2 finished.' })
  assert.equal(wakes(), before + 1)
  await engine.stop()
})
