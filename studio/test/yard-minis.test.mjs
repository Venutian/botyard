/**
 * Minis: a bot that works in two or more projects has a small copy in each of its other bays.
 * A bot with one project has none, a shelved bay gets none, one bot has at most three.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { MAX_MINIS, MINI_SCALE, planMinis } from '../src/yard/minis.js'
import { Yard } from '../src/yard/yard.js'
import { alsoIn } from '../server/lib/manager.mjs'
import { studioRoster } from '../server/lib/studio.mjs'

const bot = (id, project, alsoInList = []) => ({ id, project, crew: { id, name: id, status: 'running', job: project === 'Depot' ? null : { stage: 'build' }, alsoIn: alsoInList } })
const where = { depot: 'Depot', bays: ['Depot', 'Baltis', 'Ballotta', 'Aldis', 'Fasten', 'Night Rules'], shelved: ['Fasten'] }

test('a bot in three projects has a mini in each of the two other bays', () => {
  const plan = planMinis([bot('a', 'Baltis', ['Ballotta', 'Aldis'])], where)
  assert.deepEqual(plan.map((m) => m.project).sort(), ['Aldis', 'Ballotta'])
})

test('a bot with one project has no mini, nor has a bot that only waits at the Depot with one project behind it', () => {
  assert.deepEqual(planMinis([bot('a', 'Baltis'), bot('b', 'Depot', ['Aldis']), bot('c', 'Baltis', ['Baltis'])], where), [])
})

test('a shelved bay, a bay that is gone and the Depot get no mini; the main bay gets none of its own bot', () => {
  const plan = planMinis([bot('a', 'Baltis', ['Fasten', 'Gone', 'Depot', 'Aldis'])], where)
  assert.deepEqual(plan.map((m) => m.project), ['Aldis'])
})

test('one bot has at most three minis', () => {
  const plan = planMinis([bot('a', 'Baltis', ['Ballotta', 'Aldis', 'Night Rules', 'Fasten', 'Extra'])], { ...where, bays: [...where.bays, 'Extra'] })
  assert.equal(plan.length, MAX_MINIS)
})

test('minis of two bots in one bay take different spots', () => {
  const plan = planMinis([bot('a', 'Baltis', ['Aldis']), bot('b', 'Ballotta', ['Aldis'])], where)
  assert.deepEqual(plan.filter((m) => m.project === 'Aldis').map((m) => m.n), [0, 1])
})

const stage = () => ({ scene: new THREE.Scene(), renderer: { toneMappingExposure: 1 }, redraw() {} })

test('the yard draws a bot in three projects once and its minis small, ringed, in the other two bays, and only when something changes', () => {
  const yard = new Yard(stage())
  const view = { projects: ['Baltis', 'Ballotta', 'Aldis', 'Fasten'], depot: 'Depot', shelved: ['Fasten'], crew: [bot('a', 'Baltis', ['Ballotta', 'Aldis', 'Fasten']), bot('b', 'Aldis')] }
  yard.show(view)
  assert.equal(yard.robots.size, 2, 'the main bots are unchanged')
  assert.deepEqual([...yard.minis.keys()].sort(), ['a@Aldis', 'a@Ballotta'])
  const main = yard.robots.get('a')
  assert.ok(Math.hypot(main.pos.x - yard.bays.get('Baltis').middle.x, main.pos.z - yard.bays.get('Baltis').middle.z) < 8, 'the main bot stays in its own bay')
  const mini = yard.minis.get('a@Aldis')
  assert.ok(Math.hypot(mini.group.position.x - yard.bays.get('Aldis').middle.x, mini.group.position.z - yard.bays.get('Aldis').middle.z) < 8)
  assert.equal(mini.group.children.length, 2, 'the small robot and its ring')
  assert.ok(Math.abs(mini.group.children[0].scale.x / main.group.scale.x - MINI_SCALE) < 1e-9)
  const same = mini.group
  yard.show(view)
  assert.equal(yard.minis.get('a@Aldis').group, same, 'an unchanged yard builds nothing again')
  yard.show({ ...view, crew: [bot('a', 'Baltis', ['Ballotta']), bot('b', 'Aldis')] })
  assert.deepEqual([...yard.minis.keys()], ['a@Ballotta'], 'a bot that leaves a project loses its mini there')
  yard.show({ ...view, crew: [bot('a', 'Baltis'), bot('b', 'Aldis')] })
  assert.equal(yard.minis.size, 0, 'a bot back to one project has none')
})

test('the server lists the other projects a bot has jobs in: running now or touched in the last six hours', () => {
  const now = Date.UTC(2026, 10, 16, 12)
  const names = new Map([['p1', 'Baltis'], ['p2', 'Ballotta'], ['p3', 'Aldis'], ['p4', 'Old']])
  const at = (h) => new Date(now - h * 3600_000).toISOString()
  const issues = [
    { assigneeAgentId: 'a', projectId: 'p1', status: 'in_progress', updatedAt: at(0.1) },
    { assigneeAgentId: 'a', projectId: 'p2', status: 'done', updatedAt: at(2), completedAt: at(2) },
    { assigneeAgentId: 'a', projectId: 'p3', status: 'in_progress', updatedAt: at(10) },
    { assigneeAgentId: 'a', projectId: 'p4', status: 'done', updatedAt: at(9), completedAt: at(9) },
    { assigneeAgentId: 'b', projectId: 'p4', status: 'in_progress', updatedAt: at(0) },
  ]
  assert.deepEqual(alsoIn({ issues, botId: 'a', projectNames: names, home: 'p1', now }), ['Ballotta', 'Aldis'])
  assert.deepEqual(alsoIn({ issues, botId: 'nobody', projectNames: names, home: '', now }), [])
})

test('the map gets alsoIn on every crew thread', () => {
  const manager = { bots: [{ id: 'a', name: 'A', projectId: 'p1', job: { stage: 'build', title: 't' }, alsoIn: ['Aldis'] }, { id: 'b', name: 'B', projectId: '', job: null }] }
  const threads = studioRoster({ manager, records: { projects: [{ id: 'p1', name: 'Baltis' }], issues: [] }, now: 1 })
  assert.deepEqual(threads.map((t) => t.crew.alsoIn), [['Aldis'], []])
})
