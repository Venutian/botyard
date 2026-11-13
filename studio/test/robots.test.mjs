/**
 * The yard robot: what a look means, which state a bot is drawn in, and that every robot builds.
 * Runs in node: the builder guards `document`, so the letter plate and ground spot are skipped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { BUILDS, GEAR, HATS, STATES, lightness, shade, specOf, stateOf } from '../src/robots/look.js'
import { ROBOT_HEIGHT, buildRobot } from '../src/robots/robot.js'

// ── what a look means ───────────────────────────────────────────────────────────

test('a full look gives its colour, build, hat, gear and face', () => {
  const spec = specOf({ name: 'Bob', look: { colour: '#E3B23C', build: 'heavy', hat: 'crown', gear: ['wrench', 'cape'], face: 'light' } })
  assert.equal(spec.suit, '#e3b23c')
  assert.equal(spec.build, 'heavy')
  assert.equal(spec.hat, 'crown')
  assert.deepEqual(spec.gear, ['wrench', 'cape'])
  assert.equal(spec.screen, '#dfe3e8')
  assert.equal(spec.eyes, '#15181d')
  assert.equal(spec.initial, 'B')
})

test('an empty look is a grey standard robot with no hat and no gear', () => {
  for (const bot of [{}, { name: 'x' }, { name: 'x', look: {} }, { name: 'x', look: null }, undefined]) {
    const spec = specOf(bot)
    assert.equal(spec.suit, '#7d8590')
    assert.equal(spec.build, 'standard')
    assert.equal(spec.hat, 'none')
    assert.deepEqual(spec.gear, [])
    assert.equal(spec.screen, '#15181d', 'a dark screen unless the face is light')
    assert.equal(spec.eyes, '#f2f4f6')
  }
})

test('old words still give a whole robot', () => {
  assert.deepEqual(specOf({ look: { gear: ['kritik'] } }).gear, ['clipboard'])
  assert.deepEqual(specOf({ look: { gear: 'belt' } }).gear, ['toolbelt'])
  assert.deepEqual(specOf({ look: { gear: ['kritik', 'clipboard', 'nonsense'] } }).gear, ['clipboard'], 'doubles and unknown words go')
  assert.equal(specOf({ look: { hat: 'helmet' } }).hat, 'hardhat')
  assert.equal(specOf({ look: { build: 'enormous' } }).build, 'standard')
  assert.equal(specOf({ look: { hat: 'sombrero' } }).hat, 'none')
  assert.equal(specOf({ look: { colour: 'MixedCase' } }).suit, '#7d8590')
  assert.equal(specOf({ look: { colour: '#ABCDEF' } }).suit, '#abcdef', 'a mixed-case colour is lower-cased')
  assert.equal(specOf({ look: { color: '#ABCDEF' } }).suit, '#abcdef', 'the US spelling is read too')
  for (const bad of ['red', '#fff', '#12345g', 12, '']) assert.equal(specOf({ look: { colour: bad } }).suit, '#7d8590', `${bad} is grey`)
})

test('the initial comes from the name', () => {
  assert.equal(specOf({ name: 'kestrel' }).initial, 'K')
  assert.equal(specOf({ name: '  garnet' }).initial, 'G')
  assert.equal(specOf({ name: '#7 bot' }).initial, '7')
  assert.equal(specOf({ name: '***' }).initial, '?')
  assert.equal(specOf({}).initial, '?')
})

test('the ink is dark on a light suit and light on a dark one', () => {
  assert.equal(specOf({ look: { colour: '#f5f0e0' } }).ink, '#15181d')
  assert.equal(specOf({ look: { colour: '#12202f' } }).ink, '#f2f4f6')
  assert.ok(lightness('#ffffff') > lightness('#808080') && lightness('#808080') > lightness('#000000'))
})

test('shade takes a paint toward black or white', () => {
  assert.equal(shade('#808080', -1), '#000000')
  assert.equal(shade('#808080', 1), '#ffffff')
  assert.equal(shade('#336699', 0), '#336699')
  assert.ok(lightness(shade('#336699', -0.5)) < lightness('#336699'))
})

// ── which state ─────────────────────────────────────────────────────────────────

test('a bot is drawn in the state its status and job give', () => {
  assert.equal(stateOf({ status: 'paused', job: { stage: 'build' } }), 'paused')
  assert.equal(stateOf({ status: 'error' }), 'stopped')
  assert.equal(stateOf({ status: 'running', job: { stage: 'check' } }), 'checking')
  assert.equal(stateOf({ status: 'running', job: { stage: 'Checking' } }), 'checking')
  assert.equal(stateOf({ status: 'running', job: { stage: 'ruling' } }), 'checking')
  assert.equal(stateOf({ status: 'running', job: { stage: 'build' } }), 'building')
  assert.equal(stateOf({ status: 'running' }), 'building')
  assert.equal(stateOf({ status: 'idle', job: { stage: 'build' } }), 'waiting')
  assert.equal(stateOf({ status: 'idle', job: null }), 'free')
  assert.equal(stateOf({}), 'free')
  assert.equal(stateOf(), 'free')
})

// ── building ────────────────────────────────────────────────────────────────────

const meshes = (group) => { const out = []; group.traverse((o) => { if (o.isMesh) out.push(o) }); return out }
const box = (group) => new THREE.Box3().setFromObject(group)
const spec = (look = {}) => specOf({ name: 'Test', look })
const positions = (group) => meshes(group).map((m) => Array.from(m.geometry.attributes.position.array))

test('every state in every build gives a robot of a believable height', () => {
  for (const build of Object.keys(BUILDS)) {
    for (const state of Object.keys(STATES)) {
      const robot = buildRobot(spec({ build }), state)
      assert.ok(robot instanceof THREE.Group, `${build}/${state}`)
      const all = meshes(robot)
      assert.ok(all.length >= 1)
      assert.ok(all[0].geometry.attributes.position.count > 0, `${build}/${state} has a painted body`)
      const height = box(robot).max.y - box(robot).min.y
      assert.ok(height >= 1.2 && height <= ROBOT_HEIGHT + 0.6, `${build}/${state} is ${height} high`)
      assert.ok(robot.userData.top.y > 1)
      robot.userData.dispose()
    }
  }
})

test('the stopped robot has its lamp mast folded flat, so it stands lower than a free one', () => {
  const free = box(buildRobot(spec(), 'free'))
  const stopped = box(buildRobot(spec(), 'stopped'))
  assert.ok(stopped.max.y < free.max.y, `${stopped.max.y} vs ${free.max.y}`)
})

test('a paused robot is lower than a free one', () => {
  const free = box(buildRobot(spec(), 'free'))
  const paused = box(buildRobot(spec(), 'paused'))
  assert.ok(paused.max.y < free.max.y, `${paused.max.y} vs ${free.max.y}`)
})

test('every hat and every piece of gear builds', () => {
  for (const hat of HATS) {
    for (const state of Object.keys(STATES)) assert.doesNotThrow(() => buildRobot(spec({ hat }), state), `${hat}/${state}`)
  }
  for (const gear of GEAR) {
    for (const state of Object.keys(STATES)) assert.doesNotThrow(() => buildRobot(spec({ gear: [gear] }), state), `${gear}/${state}`)
  }
  assert.doesNotThrow(() => buildRobot(spec({ gear: GEAR, hat: 'crown' }), 'checking'))
})

test('a hat adds to the robot, and an unknown state is drawn as free', () => {
  const bare = meshes(buildRobot(spec({ hat: 'none' }), 'free'))[0].geometry.attributes.position.count
  const crowned = meshes(buildRobot(spec({ hat: 'crown' }), 'free'))[0].geometry.attributes.position.count
  assert.ok(crowned > bare)
  assert.deepEqual(positions(buildRobot(spec(), 'nonsense')), positions(buildRobot(spec(), 'free')))
})

test('two robots of one spec and state have identical geometry', () => {
  for (const state of Object.keys(STATES)) {
    const s = spec({ colour: '#3366aa', build: 'barrel', hat: 'wizard', gear: ['cape', 'satchel'] })
    const a = buildRobot(s, state)
    const b = buildRobot(s, state)
    assert.deepEqual(meshes(a).map((m) => m.geometry.attributes.position.count), meshes(b).map((m) => m.geometry.attributes.position.count))
    assert.deepEqual(positions(a), positions(b), state)
  }
})
