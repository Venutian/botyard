/**
 * Shelved projects on the map: the shelved flag changes how a bay is drawn (dimmed to about 55
 * percent, a tarpaulin and shuttered door over it, lamps off) and keeps bots out of it.
 * The yard is run in node with a stand-in stage: it draws nothing, it only holds the scene.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildBay } from '../src/yard/bays.js'
import { SHELF_LIGHT, dim } from '../src/yard/shelf.js'
import { Yard } from '../src/yard/yard.js'

const lightOf = (mesh) => {
  const c = mesh.geometry.attributes.color
  const out = new THREE.Color()
  let sum = 0
  for (let i = 0; i < c.count; i++) { out.setRGB(c.getX(i), c.getY(i), c.getZ(i), THREE.LinearSRGBColorSpace); sum += out.getHSL({}, THREE.SRGBColorSpace).l }
  return sum / c.count
}
const args = { name: 'Lantern', paint: '#d9534f', concrete: '#dcd8cc' }

test('a shelved bay is dimmed to about 55 percent, covered and shuttered, with its lamp off', () => {
  const live = buildBay(args)
  const shelved = buildBay({ ...args, shelved: true })
  assert.equal(live.userData.shelved, false)
  assert.equal(shelved.userData.shelved, true)
  const ratio = lightOf(shelved.children[0]) / lightOf(live.children[0])
  assert.ok(ratio > 0.5 && ratio < 0.6, `ground and walls keep about 55 percent of their light, got ${ratio.toFixed(2)}`)
  assert.ok(live.children.some((m) => m.material.isMeshBasicMaterial), 'a live bay has a lit lamp')
  assert.ok(!shelved.children.some((m) => m.material.isMeshBasicMaterial), 'a shelved bay has no lamp lit')
  assert.ok(shelved.children[1].geometry.attributes.position.count > 0, 'the tarpaulin, shutters and padlock are there')
  assert.equal(dim('#ffffff').length, 7)
  assert.ok(parseInt(dim('#ffffff').slice(1, 3), 16) / 255 <= SHELF_LIGHT + 0.01)
  for (const g of [live, shelved]) g.userData.dispose()
})

const stage = () => ({ scene: new THREE.Scene(), renderer: { toneMappingExposure: 1 }, redraw() {} })
const bot = (id, project) => ({ id, project, crew: { id, name: id, status: 'running', job: { stage: 'build' } } })

test('the yard redraws a bay when it is shelved or taken off the shelf, and nobody stands in a shelved bay', () => {
  const yard = new Yard(stage())
  const view = { projects: ['Quarry', 'Lantern'], depot: 'Depot', crew: [bot('a', 'Quarry'), bot('b', 'Lantern')], shelved: [] }
  yard.show(view)
  assert.equal(yard.bays.get('Lantern').shelved, false)
  const live = yard.bays.get('Lantern').group
  const depot = yard.bays.get('Depot').middle
  assert.ok(Math.hypot(yard.robots.get('b').pos.x - yard.bays.get('Lantern').middle.x, yard.robots.get('b').pos.z - yard.bays.get('Lantern').middle.z) < 8)

  yard.show({ ...view, shelved: ['Lantern'] })
  const bay = yard.bays.get('Lantern')
  assert.equal(bay.shelved, true)
  assert.notEqual(bay.group, live, 'the bay was drawn again, shelved')
  assert.equal(bay.group.userData.shelved, true)
  assert.equal(yard.bays.get('Quarry').shelved, false, 'only the shelved project changes')
  assert.ok(Math.hypot(yard.robots.get('b').pos.x - depot.x, yard.robots.get('b').pos.z - depot.z) < 8, 'a bot with a job in a shelved bay waits at the Depot')

  const same = bay.group
  yard.show({ ...view, shelved: ['Lantern'] })
  assert.equal(yard.bays.get('Lantern').group, same, 'an unchanged shelf draws nothing again')
  yard.show(view)
  assert.equal(yard.bays.get('Lantern').shelved, false)
  assert.equal(yard.bays.get('Lantern').at, bay.at, 'a project keeps its place on and off the shelf')
})
