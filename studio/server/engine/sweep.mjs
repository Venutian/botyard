#!/usr/bin/env node
/**
 * The sweep: every path the map, the crew's scripts and the bots call, called on the engine over a
 * throwaway copy of a store, to show that all of them answer. The store given is only read: it is
 * copied to a temp folder first, and the copy is thrown away.
 *
 *   node server/engine/sweep.mjs <folder with studio.db> [--all]
 *
 * Prints each path that did not answer. A refusal that is the right answer (cancelling a run that
 * has ended, approving an approval that does not exist) is listed apart as expected.
 * Ends with code 1 when a path that should answer did not.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from './main.mjs'
import { storeFile } from './names.mjs'
import { issueToken } from './runner.mjs'

const src = process.argv[2]
if (!src || !fs.existsSync(storeFile(src))) { console.error('Give the folder that holds the store to sweep a copy of'); process.exit(2) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-'))
// The store with what its write-ahead file still holds, as one consistent copy.
{
  const { DatabaseSync } = await import('node:sqlite')
  const from = new DatabaseSync(storeFile(src), { readOnly: true })
  from.exec(`VACUUM INTO '${storeFile(dir).replaceAll("'", "''")}'`)
  from.close()
}
const engine = await startEngine({ dataDir: dir, runs: false, log: () => {} })
const s = engine.store
const C = s.row('SELECT id FROM company').id
const bot = s.row("SELECT id FROM agents WHERE status = 'idle' AND adapter_type = 'claude_local' ORDER BY created_at LIMIT 1").id
const job = s.row("SELECT id, identifier FROM jobs WHERE conversation_agent_id IS NULL AND status = 'done' ORDER BY created_at DESC LIMIT 1")
const run = s.row('SELECT id FROM runs WHERE log_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1').id
const proj = s.row('SELECT id FROM projects LIMIT 1').id
const routine = s.row('SELECT id FROM routines LIMIT 1')?.id
const ws = s.row('SELECT id FROM workspaces LIMIT 1')?.id
const docRow = s.row('SELECT job_id, key, document_id FROM job_documents LIMIT 1')
const docRev = s.row('SELECT id FROM document_versions WHERE document_id = ? LIMIT 1', docRow.document_id).id
const att = s.row('SELECT id, job_id FROM attachments LIMIT 1')
const rev = s.row('SELECT id, agent_id FROM agent_revisions LIMIT 1')
const out = []
const call = async (method, url, body, headers = {}, raw = null) => {
  const r = await engine.handle({ method, url: `/api${url}`, body: body || {}, headers, raw })
  out.push([r.status, method, url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), r.status >= 400 ? JSON.stringify(r.body).slice(0, 90) : ''])
  return r.body
}
const G = (u) => call('GET', u), P = (u, b) => call('POST', u, b)
// agents
await G(`/companies/${C}/agents`); await G(`/agents/${bot}`); await G(`/companies/${C}/org`); await G(`/agents/${bot}/task-sessions`); await G(`/agents/${bot}/config-revisions`)
const made = await P(`/companies/${C}/agents`, { name: 'Sweep Bot', role: 'engineer', title: 't', capabilities: 'c', adapterType: 'claude_local', runtimeConfig: {}, adapterConfig: { model: 'm', env: { A: { type: 'plain', value: '1' } } }, replaceAdapterConfig: true })
await call('PATCH', `/agents/${made.id}`, { title: 'u', adapterConfig: { model: 'n' }, replaceAdapterConfig: true })
await P(`/agents/${made.id}/pause`); await P(`/agents/${made.id}/resume`)
await P(`/agents/${rev.agent_id}/config-revisions/${rev.id}/rollback`)
await P(`/agents/${made.id}/runtime-state/reset-session`)
// issues
await G(`/companies/${C}/issues?limit=20&status=todo,in_progress&assigneeAgentId=${bot}&projectId=${proj}&view=compact`); await G(`/companies/${C}/issues?q=test&parentId=${job.id}`); await G(`/companies/${C}/search?q=test`)
const j = await P(`/companies/${C}/issues`, { title: 'Sweep job', description: 'd', projectId: proj, assigneeAgentId: made.id, priority: 'low' })
await G(`/issues/${job.id}`); await G(`/issues/${job.identifier}`)
await call('PATCH', `/issues/${j.id}`, { status: 'in_progress', title: 't2', description: 'd2', priority: 'high', projectId: proj, assigneeAgentId: made.id, assigneeAdapterOverrides: { model: 'x' }, blockedByIssueIds: [], comment: 'note' })
await G(`/issues/${job.id}/runs`); await G(`/issues/${job.id}/live-runs`); await G(`/issues/${job.id}/cost-summary`); if (ws) await G(`/execution-workspaces/${ws}`)
// comments, chats
await G(`/issues/${job.id}/comments?limit=5`); await P(`/issues/${j.id}/comments`, { body: 'hello', clientRequestId: 'r1' })
await G(`/companies/${C}/chats`); await G(`/companies/${C}/chats/${made.id}`); await P(`/companies/${C}/chats/${made.id}`)
// runs
await G(`/companies/${C}/live-runs`); await G(`/companies/${C}/heartbeat-runs?agentId=${bot}&limit=5&summary=true`); await G(`/heartbeat-runs/${run}`); await G(`/heartbeat-runs/${run}/log?offset=0&limitBytes=1000`)
await P(`/heartbeat-runs/${run}/cancel`); await P(`/agents/${made.id}/wakeup`, { issueId: j.id, reason: 'heavy_job_done', forceFreshSession: true })
// cards (a bot asks; the owner answers)
s.put('runs', { id: '11111111-1111-4111-8111-111111111111', companyId: C, agentId: made.id, issueId: j.id, status: 'running', createdAt: new Date().toISOString() })
const pass = { authorization: `Bearer ${issueToken(s, '11111111-1111-4111-8111-111111111111', made.id)}` }
await call('GET', '/agents/me', null, pass)
await G(`/issues/${j.id}/interactions`)
const q = await call('POST', `/issues/${j.id}/interactions`, { kind: 'ask_user_questions', title: 'q', payload: { questions: [] } }, pass)
await P(`/issues/${j.id}/interactions/${q.id}/respond`, { answers: [{ questionId: 'a', optionIds: ['b'] }] })
const c1 = await call('POST', `/issues/${j.id}/interactions`, { kind: 'request_confirmation', title: 'c' }, pass); await P(`/issues/${j.id}/interactions/${c1.id}/accept`)
const c2 = await call('POST', `/issues/${j.id}/interactions`, { kind: 'request_confirmation', title: 'c' }, pass); await P(`/issues/${j.id}/interactions/${c2.id}/reject`, { reason: 'no' })
const c3 = await call('POST', `/issues/${j.id}/interactions`, { kind: 'request_confirmation', title: 'c' }, pass); await call('POST', `/issues/${j.id}/interactions/${c3.id}/withdraw`, {}, pass)
// approvals
await G(`/companies/${C}/approvals?status=pending`); await P(`/approvals/${C}/approve`); await P(`/approvals/${C}/reject`)
// documents, files
await G(`/issues/${docRow.job_id}/documents`); await G(`/issues/${docRow.job_id}/documents/${docRow.key}`); await call('PUT', `/issues/${j.id}/documents/plan`, { format: 'markdown', body: 'b', title: 'Plan', changeSummary: 's', baseRevisionId: null })
await G(`/issues/${docRow.job_id}/documents/${docRow.key}/revisions`); await P(`/issues/${docRow.job_id}/documents/${docRow.key}/revisions/${docRev}/restore`)
await G(`/issues/${att.job_id}/attachments`); await G(`/attachments/${att.id}/content`)
const form = Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n')
await call('POST', `/companies/${C}/issues/${j.id}/attachments`, {}, { 'content-type': 'multipart/form-data; boundary=B' }, form)
await G(`/companies/${C}/artifacts`); await P(`/issues/${j.id}/work-products`, { type: 'pull_request', title: 'PR', url: 'https://example.com/pr/1', status: 'open', provider: 'github' })
// projects
await G(`/companies/${C}/projects`); await G(`/projects/${proj}`); await call('PATCH', `/projects/${proj}`, { description: 'GOAL: x' })
// routines
await G(`/companies/${C}/routines`); const r = await P(`/companies/${C}/routines`, { title: 'Sweep routine', description: '', assigneeAgentId: made.id, projectId: proj })
await G(`/routines/${r.id}`); await call('PATCH', `/routines/${r.id}`, { status: 'paused' }); await call('PATCH', `/routines/${r.id}`, { status: 'active' }); await P(`/routines/${r.id}/run`)
const t = await P(`/routines/${r.id}/triggers`, { kind: 'schedule', cronExpression: '0 3 * * *', timezone: 'Europe/Stockholm' }); await call('PATCH', `/routine-triggers/${t.id}`, { cronExpression: '0 4 * * *' })
await G(`/routines/${routine || r.id}/runs`); await G(`/routines/${routine || r.id}/revisions`); await call('PATCH', `/routines/${r.id}`, { status: 'archived' })
// skills
await G(`/agents/${bot}/skills`); await G(`/companies/${C}/skills`); await G(`/companies/${C}/skills/${C}`); await G(`/companies/${C}/skills/${C}/files?path=SKILL.md`); await call('PATCH', `/companies/${C}/skills/${C}/files`, { path: 'SKILL.md', content: 'x' })
// instructions
const b = await G(`/agents/${made.id}/instructions-bundle`); const f1 = await call('PUT', `/agents/${made.id}/instructions-bundle/file`, { path: b.entryFile, content: 'one', baseRevisionId: null })
await G(`/agents/${made.id}/instructions-bundle/file?path=${b.entryFile}`); const f2 = await call('PUT', `/agents/${made.id}/instructions-bundle/file`, { path: b.entryFile, content: 'two', baseRevisionId: f1.revisionId })
await G(`/agents/${made.id}/instructions-bundle/history`); await G(`/agents/${made.id}/instructions-bundle/diff?from=${f1.revisionId}&to=${f2.revisionId}`); await P(`/agents/${made.id}/instructions-bundle/restore`, { path: b.entryFile, revisionId: f1.revisionId, baseRevisionId: f2.revisionId })
await G(`/agents/${bot}/instructions-bundle`); await G(`/agents/${bot}/instructions-bundle/file`)
// costs, activity
for (const p of ['dashboard', 'costs/window-spend', 'costs/by-agent', 'costs/by-agent-model', 'costs/by-provider', 'costs/by-project?from=2026-11-01T00:00:00Z&to=2026-11-12T00:00:00Z', 'costs/quota-windows', 'budgets/overview', 'timeline', 'attention', 'sidebar-badges']) await G(`/companies/${C}/${p}`)
// company
await G('/companies'); await G(`/companies/${C}`); await call('PATCH', `/companies/${C}`, { description: 'd' }); await G(`/companies/${C}/members`); await G(`/companies/${C}/invites`); await P(`/companies/${C}/invites`, { allowedJoinTypes: 'human' }); await P(`/invites/${C}/revoke`)
await G('/instance/settings/general'); await G('/instance/settings/experimental'); await call('PATCH', '/instance/settings/experimental', { enableApps: true }); await G(`/companies/${C}/secrets`)
// connectors: the card's "no"
await P(`/connection-intents/${q.id}/decline`, { reason: 'no' })
// what bots call by themselves, rarely
await call('GET', '/agents/me/secrets', null, pass); await call('GET', `/issues/${j.id}/heartbeat-context`, null, pass); await call('GET', `/issues/${j.id}/recovery-actions`, null, pass); await call('GET', `/issues/${j.id}/blockers`, null, pass)
await call('POST', `/issues/${j.id}/checkout`, { agentId: made.id, expectedStatuses: ['todo', 'in_progress'] }, pass); await call('POST', `/issues/${j.id}/release`, {}, pass); await call('GET', '/agents/me/inbox-lite', null, pass)
await engine.stop()
fs.rmSync(dir, { recursive: true, force: true })

/** Refusals that are the right answer on this store. */
const EXPECTED = [
  [409, /^POST \/heartbeat-runs\/:id\/cancel$/, 'the run had ended'],
  [404, /^POST \/approvals\/:id\/(approve|reject)$/, 'a Botyard has no approvals'],
  [404, /^(GET|PATCH) \/companies\/:id\/skills\/:id/, 'the skills are the ones on this computer'],
  [409, /^POST \/companies\/:id\/invites$/, 'a Botyard has one owner'],
  [404, /^POST \/invites\/:id\/revoke$/, 'a Botyard has no invites'],
  [409, /^POST \/connection-intents\/:id\/decline$/, 'the card was already answered'],
  [404, /^GET \/heartbeat-runs\/:id\/log/, 'the sweep copies the store, not the run logs'],
  [404, /^GET \/attachments\/:id\/content$/, 'the sweep copies the store, not the files folder'],
]
const expected = (o) => EXPECTED.find(([status, pattern]) => o[0] === status && pattern.test(`${o[1]} ${o[2]}`))
const refused = out.filter((o) => o[0] >= 400)
const gaps = refused.filter((o) => !expected(o))
console.log(`${out.length} calls: ${out.length - refused.length} answered, ${refused.length - gaps.length} refused as they should be, ${gaps.length} not answered`)
if (process.argv.includes('--all')) for (const o of out) console.log(o.slice(0, 3).join(' '))
for (const o of refused.filter(expected)) console.log(`expected ${o[0]} ${o[1]} ${o[2]} (${expected(o)[2]})`)
for (const o of gaps) console.log(`NOT ANSWERED ${o.join(' ')}`)
process.exit(gaps.length ? 1 : 0)
