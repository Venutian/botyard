import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalInput, goalNote, planOf, readGoal, writeGoal } from '../server/lib/goal.mjs'

// A project's goal lives in its description in the engine, where Lead reads it (setup-bots.py, GOALS).
const HARBOUR = 'Harbour, a medieval settlement game (three.js). GOAL (owner, 11 Nov 2026): production ready; the crew works on it until it is. OPEN NOW: M9 waits on the owner\'s ruling.'
const NIGHT = 'Being built by the free crew. GOAL: Quay story app. DONE WHEN Phase 1: 3 nights play. FIRST: story format. PARKED: Claude, shop.'

test('a goal is read out of a project description in its marked parts', () => {
  const g = readGoal(HARBOUR)
  assert.equal(g.about, 'Harbour, a medieval settlement game (three.js).')
  assert.equal(g.goal, 'production ready; the crew works on it until it is.')
  assert.equal(g.open, "M9 waits on the owner's ruling.")
  assert.equal(g.setBy, 'owner, 11 Nov 2026')
  const n = readGoal(NIGHT)
  assert.deepEqual([n.goal, n.doneWhen, n.first, n.parked], ['Quay story app.', 'Phase 1: 3 nights play.', 'story format.', 'Claude, shop.'])
})

test('a description with no marks is all about the project, with no goal', () => {
  assert.deepEqual(readGoal('Throwaway tests'), { about: 'Throwaway tests', goal: '', doneWhen: '', first: '', parked: '', open: '', setBy: '' })
  assert.equal(readGoal(null).goal, '')
})

test('the owner\'s edit is written the way Lead writes it, keeping his OPEN NOW line', () => {
  const was = readGoal(HARBOUR)
  const text = writeGoal({ ...was, goal: 'Ship M9 to M15', doneWhen: 'a fresh critic scores none below 6' }, { now: new Date('2026-11-12T12:00:00Z') })
  assert.equal(text, "Harbour, a medieval settlement game (three.js). GOAL (owner, 12 Nov 2026): Ship M9 to M15 DONE WHEN: a fresh critic scores none below 6 OPEN NOW: M9 waits on the owner's ruling.")
  const back = readGoal(text)
  assert.equal(back.goal, 'Ship M9 to M15')
  assert.equal(back.doneWhen, 'a fresh critic scores none below 6')
})

test('removing the goal leaves only what the project is', () => {
  assert.equal(writeGoal({ about: 'Throwaway tests', goal: '' }), 'Throwaway tests')
})

test('what the owner sends is plain text within each field\'s length', () => {
  assert.deepEqual(goalInput({ goal: '  two\n lines ', extra: 'x' }), { about: '', goal: 'two lines', doneWhen: '', first: '', parked: '' })
  assert.throws(() => goalInput({ goal: 'x'.repeat(1501) }), /limited to 1500/)
})

test('Lead is told the new goal in words he acts on', () => {
  const note = goalNote('Harbour', { goal: 'Ship it', doneWhen: 'tests pass' })
  assert.match(note, /changed the goal of Harbour/)
  assert.match(note, /GOAL: Ship it/)
  assert.match(note, /brief its next step/)
  assert.match(goalNote('Harbour', { goal: '' }), /no goal now/)
})

test('a plan is the Plan job\'s goal and Lead\'s last PLAN report', () => {
  const plan = planOf({ id: 'i', title: 'Plan: Lighthouse rows', status: 'done', updatedAt: '2026-11-11T22:46:38Z', description: '# Goal: x\n\nGOAL: rows 1 and 50 pass. DONE WHEN (by script): 90 or less.' },
    [{ body: 'PLAN: first one\n\nSTEPS:\n1. a' }, { body: 'thanks' }])
  assert.equal(plan.title, 'Lighthouse rows')
  assert.equal(plan.goal, 'rows 1 and 50 pass.')
  assert.match(plan.report, /^PLAN: first one/)
  assert.equal(planOf(null), null)
})
