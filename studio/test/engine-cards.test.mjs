/**
 * A question card always has something to answer: one with no questions is refused with what to send,
 * the shapes bots have sent are kept as the one shape the owner's pages read, and a card stored in
 * an older shape is shown with its questions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { cardAsRead, questionsOf } from '../server/engine/write.mjs'

async function yard() {
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cards-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body) => engine.handle({ method, url, body })
  const id = (await call('GET', '/api/companies')).body[0].id
  const job = (await call('POST', `/api/companies/${id}/issues`, { title: 'Pick a size' })).body
  return { engine, call, job, ask: (payload, more = {}) => call('POST', `/api/issues/${job.id}/interactions`, { kind: 'ask_user_questions', title: 'Which size?', payload, ...more }) }
}

const QUESTION = { id: 'size', prompt: 'Which size ships first?', options: [{ id: 's', label: 'Small (recommended)', description: 'A day.' }, { id: 'l', label: 'Large', description: 'A week.' }] }

test('a question card with nothing to answer is refused, saying what to send, and nothing reaches the owner', async () => {
  const s = await yard()
  for (const payload of [undefined, {}, { questions: [] }, { questionSet: { questions: [] } }, { questions: [{ id: 'q', prompt: '', options: [{ label: 'A' }] }] },
    { questions: [{ id: 'q', prompt: 'Which?', options: [] }] }, { questions: [{ id: 'q', prompt: 'Which?' }] }, { questions: ['not a question'] }]) {
    const out = await s.ask(payload)
    assert.equal(out.status, 400, JSON.stringify(payload))
    assert.match(out.body.error, /needs its questions, each with a prompt and at least one option/)
    assert.match(out.body.error, /"questions": \[\{"id": "choice", "prompt"/, 'the words show the shape to send')
    assert.match(out.body.error, /comment on the job instead/)
  }
  assert.deepEqual((await s.call('GET', `/api/issues/${s.job.id}/interactions`)).body, [])
  assert.equal((await s.call('GET', `/api/companies/${s.job.companyId}/attention`)).body.totalCount, 0)
  // A yes-or-no card has no questions and is not refused for that.
  assert.equal((await s.call('POST', `/api/issues/${s.job.id}/interactions`, { kind: 'request_confirmation', title: 'Ship it?' })).status, 201)
  await s.engine.stop()
})

test('the questions are kept as the one shape the pages read, whichever of the shapes bots use they came in', async () => {
  const s = await yard()
  const plain = (await s.ask({ questions: [QUESTION] }, { idempotencyKey: 'a' })).body
  assert.deepEqual(plain.payload.questions.map((q) => [q.id, q.prompt, q.selectionMode, q.required, q.options.map((o) => o.label)]), [['size', 'Which size ships first?', 'single', true, ['Small (recommended)', 'Large']]])
  // As the bots' skill used to say: under questionSet, with answerMode.
  const nested = (await s.ask({ version: 1, questionSet: { schema: 'botyard.question_set.v1', questions: [{ ...QUESTION, answerMode: 'multi_select' }] } }, { idempotencyKey: 'b' })).body
  assert.equal(nested.payload.questionSet, undefined)
  assert.equal(nested.payload.questions[0].selectionMode, 'multi')
  assert.deepEqual(nested.payload.questions[0].options.map((o) => o.id), ['s', 'l'])
  // Options as plain words, and ids left out, are given ids.
  const loose = questionsOf({ questions: [{ question: 'Which colour?', options: ['Red', 'Blue'] }] })
  assert.deepEqual(loose.map((q) => [q.id, q.prompt, q.options.map((o) => [o.id, o.label])]), [['question-1', 'Which colour?', [['option-1', 'Red'], ['option-2', 'Blue']]]])
  // The owner answers it the way the pages answer.
  const answered = await s.call('POST', `/api/issues/${s.job.id}/interactions/${nested.id}/respond`, { answers: [{ questionId: 'size', optionIds: ['s', 'l'] }] })
  assert.equal(answered.status, 200)
  assert.equal(answered.body.status, 'answered')
  await s.engine.stop()
})

test('a card stored before this rule, its questions under questionSet, is shown with them and is not rewritten', async () => {
  const s = await yard()
  s.engine.store.put('cards', { id: 'old-card', companyId: s.job.companyId, issueId: s.job.id, kind: 'ask_user_questions', status: 'pending', title: 'Which size?',
    payload: { version: 1, questionSet: { schema: 'botyard.question_set.v1', questions: [{ ...QUESTION, answerMode: 'single_select' }] } }, createdAt: new Date().toISOString() }, { position: 0 })
  const shown = (await s.call('GET', `/api/issues/${s.job.id}/interactions`)).body
  assert.deepEqual(shown[0].payload.questions.map((q) => [q.prompt, q.options.length]), [['Which size ships first?', 2]])
  assert.ok(s.engine.store.object("SELECT raw FROM cards WHERE id = 'old-card'").payload.questionSet, 'the stored row is as it was')
  // A card that really holds no question is shown as it is (the pages give it a box to write in).
  const empty = { kind: 'ask_user_questions', payload: { questions: [] } }
  assert.equal(cardAsRead(empty), empty)
  await s.engine.stop()
})

test('the bots\' own skill shows a card the engine takes', async () => {
  const skill = fs.readFileSync(new URL('../../crew/skills/botyard/SKILL.md', import.meta.url), 'utf8')
  const shape = /the shape is `(\{.*?\})`;/s.exec(skill)
  assert.ok(shape, 'the skill says the shape')
  const card = JSON.parse(shape[1].replace(/\n/g, ' ').replace(/"\.\.\."/g, '"Something"'))
  assert.ok(questionsOf(card.payload), 'and that shape is one the engine keeps')
  assert.equal(/questionSet/.test(skill), false, 'the older shape is not taught')
})
