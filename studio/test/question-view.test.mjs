import test from 'node:test'
import assert from 'node:assert/strict'
import { questionView } from '../server/lib/engine.mjs'

test('a question asked with no choice still has a place for the owner to answer in their own words', () => {
  for (const payload of [{ questions: [] }, {}, undefined]) {
    const view = questionView({ id: 'q1', kind: 'ask_user_questions', title: 'Crew fix: free bots keep retrying models that are gone', payload })
    assert.equal(view.kind, 'choice')
    assert.deepEqual(view.items, [{ id: 'answer', prompt: '', multiple: false, required: true, options: [] }])
  }
})

test('a question with choices is read as it was asked', () => {
  const view = questionView({ id: 'q2', kind: 'ask_user_questions', title: 'Which map?', payload: { questions: [{ id: 'size', prompt: 'Size?', selectionMode: 'multi', required: true, options: [{ id: 's', label: 'Small', description: 'Fast' }, { id: 'o', label: 'Other', freeText: true }] }] } })
  assert.deepEqual(view.items, [{ id: 'size', prompt: 'Size?', multiple: true, required: true, options: [{ id: 's', label: 'Small', hint: 'Fast' }] }])
})
