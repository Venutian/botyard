/**
 * How the yard's sheet metal is packed for the graphics card and painted: welded pieces keep
 * their paint and their faces' directions in small numbers, each face knows where its edges are,
 * and the day and night lights say how the paint is drawn. Run in node: nothing is drawn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Kit, painted, PAINT } from '../src/robots/kit.js'
import { LIGHTS } from '../src/yard/ground.js'

test('a weld packs directions in bytes and paint in 16-bit steps, and keeps the paint exact enough', () => {
  const kit = new Kit().box(1, 1, 1, '#d9534f', [0, 0.5, 0])
  const g = kit.weld()
  assert.ok(g.attributes.normal.array instanceof Int8Array && g.attributes.normal.normalized)
  assert.ok(g.attributes.color.array instanceof Uint16Array && g.attributes.color.normalized)
  assert.ok(g.attributes.position.array instanceof Float32Array)
  const want = new THREE.Color('#d9534f')
  assert.ok(Math.abs(g.attributes.color.getX(0) - want.r) < 1e-4, 'the paint comes back as it went in')
  assert.ok(Math.abs(g.attributes.normal.getY(0)) + Math.abs(g.attributes.normal.getX(0)) + Math.abs(g.attributes.normal.getZ(0)) > 0.99, 'each face still has a direction')
  // Less memory than plain floats: 12 for the place, 3 for the direction, 6 for the paint, 2 for the edge.
  const bytes = Object.values(g.attributes).reduce((sum, a) => sum + a.array.byteLength, 0)
  assert.equal(bytes / g.attributes.position.count, 23)
})

test('a box face runs 0 to 1 to its edges; a rod has edges at its rims only; a ring has none', () => {
  const edgesOf = (kit) => {
    const e = kit.weld().attributes.edge
    return Array.from({ length: e.count }, (_, i) => [e.getX(i), e.getY(i)])
  }
  const box = edgesOf(new Kit().box(1, 1, 1, '#ffffff', [0, 0, 0]))
  assert.ok(box.some(([u]) => u === 0) && box.some(([u]) => u === 1), 'a box face reaches both of its edges')
  const rod = edgesOf(new Kit().rod(1, 1, 1, '#ffffff', [0, 0, 0]))
  assert.ok(rod.every(([u]) => Math.abs(u - 128 / 255) < 1e-6), 'nothing runs round a rod, so no seam is drawn down its side')
  assert.ok(rod.some(([, v]) => v === 0) && rod.some(([, v]) => v === 1), 'its side reaches its rims')
  const ring = edgesOf(new Kit().ring(1, 0.1, '#ffffff', [0, 0, 0]))
  assert.ok(ring.every(([u, v]) => u === v && Math.abs(u - 128 / 255) < 1e-6), 'a ring has no edge')
})

test('one paint for the whole yard, drawn by the hour', () => {
  assert.equal(painted(), painted(), 'every piece shares one material, so one program')
  assert.ok(painted().isMeshLambertMaterial)
  for (const hour of ['day', 'night']) {
    const l = LIGHTS[hour]
    assert.match(l.rim[0], /^#[0-9a-f]{6}$/)
    assert.ok(l.rim[1] > 0 && l.rim[1] < 1, `${hour}: the sky caught on an edge stays a touch`)
    assert.ok(l.wear >= 0 && l.wear <= 1)
  }
  assert.equal(LIGHTS.day.bayGlow, 0, 'the bays glow in their own paint at night only')
  assert.ok(LIGHTS.night.bayGlow > 0)
  assert.ok(PAINT.uRim.value.isColor && 'value' in PAINT.uWear)
})
