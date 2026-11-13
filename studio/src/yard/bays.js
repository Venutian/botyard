import * as THREE from 'three'
import { Kit, painted, lit } from '../robots/kit.js'
import { BAY_RADIUS, cornersOf } from './layout.js'

/**
 * A bay: a six-sided concrete pad with a broad stripe of its project's paint round the edge, a
 * short post at each corner, crates at two corners and a charging post in the middle where its
 * free bots would wait. The gate is drawn here too: two posts and a beam over a painted pad.
 */

/** Paints a project's bay may get, handed out in turn; the Depot is plain steel. */
export const BAY_PAINTS = ['#5a6fd6', '#d9534f', '#3aa676', '#e0902f', '#9b59b6', '#2aa6b8', '#d06a9b', '#8a9a3a', '#c7783f', '#4f86c6']
export const DEPOT_PAINT = '#69727e'

const DECK = 0.3
const INK = '#15181d'
const STEEL = '#4a515c'
const STEEL_DARK = '#23272e'
const CRATES = ['#2f6fb5', '#b5482f', '#3f8f5f', '#c9a227']

/** The bay's top face: what robots stand on. */
export const DECK_TOP = DECK

/**
 * @param {{ name: string, paint: string, concrete: string, depot?: boolean }} bay
 * @returns {THREE.Group} at the bay's middle, with `userData.dispose`
 */
export function buildBay({ paint, concrete, depot = false }) {
  const kit = new Kit()
  const glow = new Kit()
  glow.joint = kit.joint
  const flat = Math.PI / 6
  // The pad, and a slightly larger dark skirt under it so its edge reads against the asphalt.
  kit.rod(BAY_RADIUS + 0.25, BAY_RADIUS + 0.25, 0.06, INK, [0, 0.03, 0], [0, flat, 0], 6)
  kit.rod(BAY_RADIUS, BAY_RADIUS, DECK, concrete, [0, DECK / 2, 0], [0, flat, 0], 6)
  // The painted stripe: one bar along each side, just inside the edge.
  const corners = cornersOf({ x: 0, z: 0 }, BAY_RADIUS - 0.62)
  for (let k = 0; k < 6; k++) {
    const a = corners[k], b = corners[(k + 1) % 6]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    kit.box(len + 0.66, 0.02, 0.62, paint, [(a.x + b.x) / 2, DECK + 0.01, (a.z + b.z) / 2], [0, Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2, 0])
  }
  // Posts at the corners, banded in the bay's paint.
  for (const c of cornersOf({ x: 0, z: 0 }, BAY_RADIUS - 0.35)) {
    kit.rod(0.2, 0.24, 0.1, STEEL_DARK, [c.x, DECK + 0.05, c.z], null, 8)
    kit.rod(0.13, 0.13, 0.9, STEEL_DARK, [c.x, DECK + 0.5, c.z], null, 8)
    kit.rod(0.15, 0.15, 0.2, paint, [c.x, DECK + 0.8, c.z], null, 8)
  }
  // Crates at two corners.
  const store = cornersOf({ x: 0, z: 0 }, BAY_RADIUS - 1.7)
  for (const [k, n] of [[1, 0], [4, 1]]) {
    const { x, z } = store[k]
    kit.box(0.9, 0.6, 0.7, CRATES[(k + n) % CRATES.length], [x, DECK + 0.3, z], [0, k, 0])
    kit.box(0.55, 0.42, 0.5, n ? paint : CRATES[(k + 2) % CRATES.length], [x + 0.05, DECK + 0.81, z], [0, k + 0.4, 0])
  }
  // The middle: a charging post, its cap in the bay's paint.
  kit.rod(0.7, 0.76, 0.12, STEEL_DARK, [0, DECK + 0.06, 0], null, 16)
  kit.rod(0.22, 0.28, 1.5, STEEL, [0, DECK + 0.87, 0], null, 10)
  kit.box(0.5, 0.24, 0.5, INK, [0, DECK + 1.7, 0])
  kit.box(0.6, 0.08, 0.6, paint, [0, DECK + 1.86, 0])
  glow.box(0.38, 0.06, 0.04, depot ? '#f2f4f6' : paint, [0, DECK + 1.68, 0.26])
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(kit.weld(), painted())
  mesh.receiveShadow = mesh.castShadow = true
  group.add(mesh, new THREE.Mesh(glow.weld(), lit()))
  group.userData.dispose = () => group.traverse((o) => { if (o.isMesh) o.geometry.dispose() })
  return group
}

/** The gate the crew comes in by: two posts and a beam; the yard's name hangs from the beam (drawn on the page). */
export function buildGate(concrete) {
  const kit = new Kit()
  kit.rod(3, 3, 0.1, concrete, [0, 0.05, 0], [0, Math.PI / 6, 0], 6)
  kit.rod(2.3, 2.3, 0.02, STEEL, [0, 0.11, 0], [0, Math.PI / 6, 0], 6)
  for (const s of [-1, 1]) {
    kit.box(0.5, 0.16, 0.5, STEEL_DARK, [s * 3.2, 0.08, 0])
    kit.box(0.28, 3.8, 0.28, STEEL_DARK, [s * 3.2, 1.9, 0])
  }
  kit.box(6.9, 0.24, 0.24, STEEL_DARK, [0, 3.7, 0])
  const mesh = new THREE.Mesh(kit.weld(), painted())
  mesh.castShadow = mesh.receiveShadow = true
  const group = new THREE.Group()
  group.add(mesh)
  group.userData.plate = new THREE.Vector3(0, 3.2, 0)
  group.userData.dispose = () => mesh.geometry.dispose()
  return group
}
