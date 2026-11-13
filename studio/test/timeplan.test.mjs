/** When a routine runs: the owner's plain choice to the engine's five fields and back, and in words. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanError, checkCron, cronOf, planOf, wordsOf } from '../server/lib/timeplan.mjs'
import { nextTime } from '../server/engine/routines.mjs'

test('each plain choice becomes a timetable the engine can read, and reads back as the same choice', () => {
  const plans = [
    [{ kind: 'minutes', n: 15 }, '*/15 * * * *', 'Every 15 minutes'],
    [{ kind: 'hours', n: 1 }, '0 * * * *', 'Every hour'],
    [{ kind: 'hours', n: 6 }, '0 */6 * * *', 'Every 6 hours'],
    [{ kind: 'daily', at: '07:30' }, '30 7 * * *', 'Every day at 07:30'],
    [{ kind: 'weekdays', at: '09:00' }, '0 9 * * 1-5', 'Weekdays at 09:00'],
    [{ kind: 'weekly', day: 1, at: '04:00' }, '0 4 * * 1', 'Mondays at 04:00'],
  ]
  for (const [plan, cron, words] of plans) {
    assert.equal(cronOf(plan), cron)
    assert.deepEqual(planOf(cron), plan)
    assert.equal(wordsOf(cron), words)
    assert.ok(nextTime(cron, Date.parse('2026-11-12T10:00:00Z'), 'Europe/Stockholm'), `the engine reads ${cron}`)
  }
})

test('the four old choices still work by name, and a time may be written 7:05', () => {
  assert.equal(cronOf('nightly'), '0 3 * * *')
  assert.equal(cronOf('weekdays'), '0 7 * * 1-5')
  assert.equal(cronOf({ kind: 'daily', at: '7:05' }), '5 7 * * *')
  assert.equal(wordsOf('0 3 * * *'), 'Every day at 03:00')
  assert.equal(wordsOf(''), 'Only when started by hand')
  // Sunday written as 7 is Sunday.
  assert.deepEqual(planOf('0 4 * * 7'), { kind: 'weekly', day: 0, at: '04:00' })
})

test('a timetable written by hand is kept as written when it is five readable parts, and refused otherwise', () => {
  assert.equal(cronOf({ kind: 'cron', cron: ' 5,35  *  * * 1-5 ' }), '5,35 * * * 1-5')
  assert.deepEqual(planOf('5,35 * * * 1-5'), { kind: 'cron', cron: '5,35 * * * 1-5' })
  assert.equal(wordsOf('5,35 * * * 1-5'), 'On its own timetable (5,35 * * * 1-5)')
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a b c d e', '1-0 * * * *', '* * * * * *', '']) assert.throws(() => checkCron(bad), PlanError, bad)
})

test('a plan that cannot be read says what is wrong in the owner\'s words', () => {
  assert.throws(() => cronOf({ kind: 'minutes', n: 2 }), /5 to 59 minutes/)
  assert.throws(() => cronOf({ kind: 'hours', n: 30 }), /1 to 23 hours/)
  assert.throws(() => cronOf({ kind: 'daily', at: '25:00' }), /like 07:30/)
  assert.throws(() => cronOf({ kind: 'weekly', day: 9, at: '04:00' }), /day of the week/)
  assert.throws(() => cronOf(null), /Choose when it runs/)
  assert.throws(() => cronOf('* * * * *'), /Choose when it runs/)
})
