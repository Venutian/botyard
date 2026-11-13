/**
 * How far back the eye must be for a set of points to fit: plain numbers, no browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { distanceToFit } from '../src/yard/view.js'

const aim = { x: 0, z: 0 }
const how = { side: Math.PI / 4, lean: (38 * Math.PI) / 180, fov: 40, w: 1200, h: 800 }
const NEAR = 14
const FAR = 260
const ring = (r) => [{ x: r, z: 0 }, { x: -r, z: 0 }, { x: 0, z: r }, { x: 0, z: -r }]

test('a single point at the aim gives the near limit', () => {
  assert.equal(distanceToFit([{ x: 0, z: 0 }], aim, how), NEAR)
  assert.equal(distanceToFit([], aim, how), NEAR)
})

test('points farther apart need more distance', () => {
  const small = distanceToFit(ring(20), aim, how)
  const big = distanceToFit(ring(60), aim, how)
  const bigger = distanceToFit(ring(120), aim, how)
  assert.ok(big > small, `${big} vs ${small}`)
  assert.ok(bigger > big, `${bigger} vs ${big}`)
})

test('covered edges need more distance', () => {
  const points = ring(60)
  const free = distanceToFit(points, aim, how)
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    assert.ok(distanceToFit(points, aim, { ...how, [edge]: 200 }) > free, `${edge} covered`)
  }
})

test('the answer stays between the near and far limits', () => {
  const answers = [ring(1), ring(30), ring(500), ring(1e6)].map((p) => distanceToFit(p, aim, how))
  for (const a of answers) assert.ok(a >= NEAR && a <= FAR, `${a}`)
  assert.equal(answers[0], NEAR)
  assert.equal(answers[3], FAR)
  assert.equal(distanceToFit(ring(60), aim, { ...how, left: 1000, right: 100 }), FAR, 'almost everything covered')
})
