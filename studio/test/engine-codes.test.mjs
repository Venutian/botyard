/**
 * A job is shown by its project's letters with the same number (BAL-326), a job with no project as
 * CREW-326, and the engine's own code (NGE-326) keeps working everywhere as the same job. Nothing is
 * renumbered; changing a project's letters changes only what is shown.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { CODES, plan } from '../tools/set-project-codes.mjs'
import { refOf, withRefs } from '../server/lib/engine.mjs'

async function yard() {
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-codes-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body) => engine.handle({ method, url, body })
  const company = (await call('GET', '/api/companies')).body[0]
  const project = (await call('POST', `/api/companies/${company.id}/projects`, { name: 'Baltis', code: 'bal' })).body
  const mine = (await call('POST', `/api/companies/${company.id}/issues`, { title: 'In a project', projectId: project.id })).body
  const loose = (await call('POST', `/api/companies/${company.id}/issues`, { title: 'No project' })).body
  return { engine, call, company, project, mine, loose }
}

test('every job answer carries displayIdentifier beside identifier; the number is the same', async () => {
  const s = await yard()
  assert.equal(s.project.code, 'BAL')
  const n = s.mine.identifier.split('-')[1]
  assert.match(s.mine.identifier, /^[A-Z]+-\d+$/)
  assert.equal(s.mine.displayIdentifier, `BAL-${n}`)
  assert.equal(s.loose.displayIdentifier, `CREW-${s.loose.identifier.split('-')[1]}`)
  const one = (await s.call('GET', `/api/issues/${s.mine.id}`)).body
  assert.equal(one.identifier, s.mine.identifier)
  assert.equal(one.displayIdentifier, `BAL-${n}`)
  const list = (await s.call('GET', `/api/companies/${s.company.id}/issues`)).body
  assert.deepEqual(list.map((i) => [i.identifier.split('-')[1] === i.displayIdentifier.split('-')[1], i.displayIdentifier.split('-')[0]]).sort(), [[true, 'BAL'], [true, 'CREW']])
  await s.engine.stop()
})

test('both forms of a code name the same job, in any case, in a path and in a body', async () => {
  const s = await yard()
  const n = s.mine.identifier.split('-')[1]
  for (const ref of [s.mine.identifier, `BAL-${n}`, `bal-${n}`]) {
    const out = await s.call('GET', `/api/issues/${ref}`)
    assert.equal(out.status, 200, ref)
    assert.equal(out.body.id, s.mine.id)
  }
  assert.equal((await s.call('GET', `/api/issues/ZZZ-${n}`)).status, 404, 'letters nobody owns are not guessed')
  assert.equal((await s.call('GET', `/api/issues/CREW-${s.loose.identifier.split('-')[1]}`)).body.id, s.loose.id)
  assert.equal((await s.call('POST', `/api/issues/BAL-${n}/comments`, { body: 'hello' })).status, 201)
  assert.equal((await s.call('GET', `/api/issues/${s.mine.identifier}/comments`)).body.length, 1)
  const child = (await s.call('POST', `/api/companies/${s.company.id}/issues`, { title: 'Child', parentId: `BAL-${n}` })).body
  assert.equal(child.parentId, s.mine.id)
  await s.engine.stop()
})

test('changing a project\'s code changes the display and nothing else', async () => {
  const s = await yard()
  const before = (await s.call('GET', `/api/issues/${s.mine.id}`)).body
  const changed = await s.call('PATCH', `/api/projects/${s.project.id}`, { code: 'BLT' })
  assert.equal(changed.body.code, 'BLT')
  const after = (await s.call('GET', `/api/issues/${s.mine.id}`)).body
  assert.equal(after.identifier, before.identifier)
  assert.equal(after.issueNumber, before.issueNumber)
  assert.equal(after.displayIdentifier, `BLT-${before.issueNumber}`)
  assert.equal((await s.call('GET', `/api/issues/BLT-${before.issueNumber}`)).body.id, s.mine.id)
  assert.equal((await s.call('GET', `/api/issues/BAL-${before.issueNumber}`)).status, 404, 'the old letters are no longer a name')
  assert.equal((await s.call('GET', `/api/companies/${s.company.id}`)).body.issuePrefix, s.company.issuePrefix)
  await s.engine.stop()
})

test('a project\'s code is checked: letters, not taken, not the studio\'s own, not CREW', async () => {
  const s = await yard()
  const other = (await s.call('POST', `/api/companies/${s.company.id}/projects`, { name: 'Aldis' })).body
  for (const code of ['A', 'toolongcode', 'B-1', 'BAL', 'CREW', s.company.issuePrefix]) assert.ok((await s.call('PATCH', `/api/projects/${other.id}`, { code })).status >= 400, code)
  assert.equal((await s.call('PATCH', `/api/projects/${other.id}`, { code: 'ald' })).body.code, 'ALD')
  assert.equal((await s.call('PATCH', `/api/projects/${other.id}`, { code: null })).body.code, null)
  await s.engine.stop()
})

test('cards and the needs-you feed show the project letters', async () => {
  const s = await yard()
  const card = (await s.call('POST', `/api/issues/${s.mine.id}/interactions`, { kind: 'request_confirmation', title: 'Ship it?' })).body
  assert.equal(card.id.length > 0, true)
  const feed = (await s.call('GET', `/api/companies/${s.company.id}/attention`)).body
  const item = feed.items[0]
  assert.equal(item.subject.identifier, s.mine.identifier)
  assert.equal(item.subject.displayIdentifier, s.mine.displayIdentifier)
  assert.ok(item.whyNow.startsWith(s.mine.displayIdentifier))
  const hit = (await s.call('GET', `/api/companies/${s.company.id}/search?q=${s.mine.displayIdentifier}`)).body
  assert.equal(hit.results.length, 1)
  assert.ok(hit.results[0].title.startsWith(s.mine.displayIdentifier))
  await s.engine.stop()
})

test('the screens read the displayed code; the engine code stays in the text only as a lookup', () => {
  const job = { identifier: 'NGE-326', displayIdentifier: 'BAL-326' }
  assert.equal(refOf(job), 'BAL-326')
  assert.equal(refOf({ identifier: 'NGE-9' }), 'NGE-9')
  assert.equal(withRefs('Check NGE-326: fix it, then NGE-777 and ZZZ-1'), 'Check BAL-326: fix it, then NGE-777 and ZZZ-1')
})

test('the script that sets the letters: every listed project, both halves of the Baltis split, safe to repeat', () => {
  const p = (name, code = null) => ({ id: name, name, code })
  const names = Object.fromEntries(plan([p('Baltis'), p('Ballotta'), p('Aldis'), p('Fasten'), p('UnTired'), p('nGen website'), p('Night Rules'), p('nGen Studio'), p('Sprint Delta'), p('Sandbox')]).map(([x, c]) => [x.name, c]))
  assert.deepEqual(names, { Baltis: 'BAL', Ballotta: 'BLT', Aldis: 'ALD', Fasten: 'FAS', UnTired: 'UNT', 'nGen website': 'WEB', 'Night Rules': 'NR', 'nGen Studio': 'STU', 'Sprint Delta': 'SPD', Sandbox: 'BOX' })
  assert.equal(plan([p('Baltis and Ballotta')])[0][1], 'BAL', 'before the split the combined project holds BAL')
  assert.equal(plan([p('Baltis and Ballotta'), p('Baltis'), p('Ballotta')]).find(([x]) => x.name === 'Baltis and Ballotta')[1], null, 'after it, the combined one lets go')
  assert.ok(CODES.size >= 10)
})

test('the owner\'s screens render the project code in the list, the detail and a card, with the engine code only small in the detail', async () => {
  const { jobList, jobPage } = await import('../server/lib/work.mjs')
  const { jobsScreen, jobScreen } = await import('../src/ui/studio-work.js')
  const { jobLink } = await import('../src/ui/studio-crew.js')
  const s = await yard()
  await s.call('POST', `/api/issues/${s.mine.id}/interactions`, { kind: 'request_confirmation', title: 'Ship it?' })
  const fetcher = async (url, init = {}) => {
    const out = await s.engine.handle({ method: init.method || 'GET', url: new URL(url).pathname + new URL(url).search, body: init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify(out.body), { status: out.status })
  }
  const n = s.mine.identifier.split('-')[1]
  const list = await jobList({ pile: '', fetcher })
  const html = jobsScreen({ filter: { pile: '', project: '', bot: '', q: '' }, data: list })
  assert.ok(html.includes(`<b>BAL-${n}</b>`), 'the list row reads BAL')
  assert.ok(html.includes(`<b>CREW-${s.loose.identifier.split('-')[1]}</b>`), 'a job with no project reads CREW')
  assert.ok(!html.includes(s.mine.identifier), 'the list never shows the engine code')
  const detail = await jobPage(`BAL-${n}`, { fetcher, previews: os.tmpdir() })
  assert.equal(detail.ref, `BAL-${n}`)
  const page = jobScreen(detail, { line: null, steps: [], crew: [], projects: [] })
  assert.ok(page.includes(`<small>${s.mine.identifier}</small>`), 'the detail keeps the engine code as small text')
  assert.ok(!page.replace(`<small>${s.mine.identifier}</small>`, '').includes(s.mine.identifier), 'and nowhere else')
  assert.ok(jobLink({ id: detail.id, ref: detail.ref, title: 'Ship it?' }).includes(`<b>BAL-${n}</b>`), 'a card or link reads BAL')
  await s.engine.stop()
})

test('a new project that is given no code gets letters from its name, and no two projects share them', async () => {
  const s = await yard()
  const make = async (name) => (await s.call('POST', `/api/companies/${s.company.id}/projects`, { name })).body.code
  assert.equal(await make('Tide Tables'), 'TID')
  assert.equal(await make('Tidy Tools'), 'TIDY')
  assert.equal(await make('Tid'), 'TIA', 'a taken start steps its last letter')
  const codes = (await s.call('GET', `/api/companies/${s.company.id}/projects`)).body.map((p) => p.code)
  assert.equal(new Set(codes).size, codes.length)
  await s.engine.stop()
})
