import * as THREE from 'three'
import { Kit, painted, lit } from './kit.js'
import { BUILDS, STATES, shade } from './look.js'

/**
 * The yard's robot, the "yardhand": a wide screen head on a sign-plate body, standing on one
 * square foot block, with a lamp mast at its back that says its state from across the yard and a
 * plate on its back carrying its initial, like the plates in the roster. Rigid parts only: a state
 * is a fixed pose, not a movement.
 *
 *   building  bent over a bench, both clamps on the work, lamp green
 *   checking  holding a board up to its screen, one eye narrowed, lamp blue
 *   waiting   arms down, head a little to one side, lamp grey
 *   stopped   arms hanging out, head down, mast folded flat behind it, lamp red, eyes crossed out
 *   free      arms down, a cable from its foot to the ground, lamp white
 *   paused    sunk down onto its foot, arms tucked, screen dark, lamp off
 *
 * The suit colour, build, hat and what it carries come from its look (see look.js).
 */

const FOOT = 0.22
const INK = '#15181d'
const STEEL = '#4a515c'
const STEEL_DARK = '#23272e'
const STEEL_LIGHT = '#9aa2ad'
const GOLD = '#e3b23c'
const HARD_HAT = '#f5c518'

/** How tall a robot stands, foot to lamp, in yard units: what the tags above it are placed by. */
export const ROBOT_HEIGHT = 2.3

const letters = new Map()
/** The initial for a back plate, drawn once per letter and ink. */
function letterTexture(initial, ink) {
  const key = `${initial}${ink}`
  if (letters.has(key)) return letters.get(key)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const g = canvas.getContext('2d')
  g.fillStyle = ink
  g.font = '800 52px "Big Shoulders Display", "Barlow Semi Condensed", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(initial, 32, 35)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  letters.set(key, texture)
  return texture
}

let shadowParts = null
/** A soft dark spot under every robot, so it stands on the ground even with shadows off. */
function groundSpot() {
  if (!shadowParts && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const g = canvas.getContext('2d')
    const fade = g.createRadialGradient(32, 32, 4, 32, 32, 32)
    fade.addColorStop(0, 'rgba(0,0,0,0.42)')
    fade.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = fade
    g.fillRect(0, 0, 64, 64)
    const geometry = new THREE.PlaneGeometry(1.7, 1.3)
    geometry.rotateX(-Math.PI / 2)
    shadowParts = { geometry, material: new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }) }
  }
  if (!shadowParts) return null
  const spot = new THREE.Mesh(shadowParts.geometry, shadowParts.material)
  spot.position.y = 0.012
  spot.renderOrder = -1
  return spot
}

/** Where the arms are held in each state: [right arm, left arm], each [forward, outward] in radians, then the clamp's own bend. */
const ARMS = {
  building: [[-1.15, 0.12, -0.7], [-1.15, 0.12, -0.7]],
  checking: [[-0.25, 0.18, 0], [-1.55, -0.05, -0.9]],
  waiting: [[0.05, 0.1, 0], [0.05, 0.1, 0]],
  stopped: [[0.25, 0.5, 0], [0.2, 0.45, 0]],
  free: [[0, 0.08, 0], [0, 0.08, 0]],
  paused: [[-0.35, -0.05, -1.4], [-0.35, -0.05, -1.4]],
}

/**
 * Build a robot.
 * @param {ReturnType<import('./look.js').specOf>} spec what it looks like
 * @param {keyof STATES} state what it is doing
 * @returns {THREE.Group} with `userData.top` (its head's top, robot-local) and `userData.dispose`
 */
export function buildRobot(spec, state = 'free') {
  const body = new Kit()
  const glow = new Kit()
  // The lit parts hang from the same joints as the painted ones.
  glow.joint = body.joint
  const pose = Object.hasOwn(STATES, state) ? state : 'free'
  const build = BUILDS[spec.build] || BUILDS.standard
  const deep = build.deep
  const sunk = pose === 'paused'

  // ── the foot: one block, a stripe of the suit round its top edge ────────────────
  body.box(0.96, FOOT - 0.04, 0.64, STEEL_DARK, [0, (FOOT - 0.04) / 2, 0])
  body.box(1.0, 0.05, 0.68, spec.suit, [0, FOOT - 0.025, 0])
  body.box(0.98, 0.06, 0.02, INK, [0, 0.05, 0.33])

  // ── the body: the build's plates, one on another ────────────────────────────────
  let y = FOOT
  let top = 0.6
  for (const [w0, w1, h] of build.plates) {
    const tall = sunk ? h * 0.22 : h
    body.slab(w0, w1, tall, deep, spec.suit, [0, y, 0])
    y += tall
    top = w1
  }
  const shoulders = y
  // A dark seam where the head sits, so head and body read as two plates.
  body.box(top * 0.9, 0.05, deep * 0.9, spec.trim, [0, shoulders + 0.025, 0])

  // ── the head: wider than the body, chamfered, its screen wrapping over the brow ─
  const hw = Math.min(1.08, Math.max(0.8, top * 1.3))
  const hh = 0.6
  const hd = 0.6
  const headBase = shoulders + 0.05
  const tilt = pose === 'waiting' ? [0, 0, 0.12] : pose === 'stopped' ? [0.32, 0, 0] : pose === 'checking' ? [0.12, -0.15, 0] : pose === 'building' ? [0.28, 0, 0] : [0, 0, 0]
  let headTop = 0
  body.from([0, headBase, 0], tilt, () => {
    body.box(hw, hh - 0.08, hd, spec.suit, [0, (hh - 0.08) / 2, 0])
    body.box(hw - 0.14, 0.08, hd - 0.14, spec.suit, [0, hh - 0.04, 0])
    body.box(hw - 0.16, hh - 0.24, 0.05, spec.screen, [0, hh / 2 - 0.03, hd / 2 + 0.015])
    body.box(hw - 0.16, 0.04, 0.2, spec.screen, [0, hh - 0.05, hd / 2 - 0.08])
    // Ears: square bolts on each side.
    body.box(0.06, 0.18, 0.18, spec.trim, [hw / 2 + 0.03, hh / 2, 0])
    body.box(0.06, 0.18, 0.18, spec.trim, [-hw / 2 - 0.03, hh / 2, 0])
    // Eyes, lit, on the screen and over the brow so they show from above.
    const ex = Math.min(0.2, hw * 0.2)
    const ez = hd / 2 + 0.045
    const eye = (x, h, lower = 0) => {
      glow.box(0.13, h, 0.02, spec.eyes, [x, hh / 2 - 0.02 - lower, ez])
      glow.box(0.13, 0.015, 0.09, spec.eyes, [x, hh - 0.025, hd / 2 - 0.05])
    }
    if (pose === 'stopped') {
      for (const x of [-ex, ex]) {
        glow.box(0.17, 0.035, 0.02, STATES.stopped.lamp, [x, hh / 2 - 0.02, ez], [0, 0, 0.78])
        glow.box(0.17, 0.035, 0.02, STATES.stopped.lamp, [x, hh / 2 - 0.02, ez], [0, 0, -0.78])
      }
    } else if (pose === 'paused') {
      body.box(0.13, 0.025, 0.02, STEEL, [-ex, hh / 2 - 0.06, ez])
      body.box(0.13, 0.025, 0.02, STEEL, [ex, hh / 2 - 0.06, ez])
    } else if (pose === 'checking') {
      eye(-ex, 0.06, -0.03)
      eye(ex, 0.17)
    } else if (pose === 'waiting') {
      eye(-ex, 0.1, 0.05)
      eye(ex, 0.1, 0.05)
    } else {
      eye(-ex, 0.17)
      eye(ex, 0.17)
    }
    headTop = hh
    hat(body, glow, spec, hw, hh, hd)
    if (spec.gear.includes('ponytail')) {
      body.from([0, hh * 0.7, -hd / 2], [0.5, 0, 0], () => {
        for (let k = 0; k < 4; k++) body.box(0.1 - k * 0.012, 0.13, 0.1 - k * 0.012, k % 2 ? spec.trim : STEEL, [0, -0.07 - k * 0.13, -0.02])
      })
    }
  })
  headTop += headBase

  // ── the arms: a rod from each shoulder, a square clamp at its end ───────────────
  const reach = sunk ? 0.32 : 0.55
  ARMS[pose].forEach(([forward, out, bend], k) => {
    const side = k === 0 ? 1 : -1
    body.from([side * (top / 2 + 0.07), shoulders - 0.12, 0], [forward, 0, side * out], () => {
      body.box(0.14, 0.14, 0.14, spec.trim, [0, 0, 0])
      body.box(0.08, reach, 0.08, STEEL, [0, -reach / 2, 0])
      body.from([0, -reach, 0], [bend, 0, 0], () => {
        body.box(0.18, 0.06, 0.16, spec.trim, [0, -0.03, 0])
        body.box(0.04, 0.14, 0.14, spec.trim, [0.07, -0.12, 0])
        body.box(0.04, 0.14, 0.14, spec.trim, [-0.07, -0.12, 0])
        held(body, glow, spec, pose, side)
      })
    })
  })

  // ── what it wears on the body ───────────────────────────────────────────────────
  worn(body, spec, { top, deep, shoulders, base: FOOT })

  // ── the back plate with its initial, tilted up so it reads from above ───────────
  let plateAt = null
  body.from([0, shoulders - 0.08, -deep / 2 - 0.02], [0.95, 0, 0], () => {
    body.box(0.66, 0.5, 0.05, INK, [0, 0.24, -0.03])
    body.box(0.58, 0.42, 0.03, spec.suit, [0, 0.24, -0.065])
    plateAt = body.joint.clone()
  })

  // ── the mast: its lamp is the state, from across the yard ───────────────────────
  const fold = pose === 'stopped' ? [-1.45, 0, 0] : [0, 0, 0]
  const lamp = STATES[pose].lamp
  body.from([-(top / 2) + 0.06, FOOT + 0.25, -deep / 2 - 0.06], fold, () => {
    const tall = sunk ? 1.25 : ROBOT_HEIGHT - FOOT - 0.42
    body.rod(0.035, 0.035, tall, STEEL, [0, tall / 2, 0], null, 6)
    body.box(0.22, 0.17, 0.22, INK, [0, tall + 0.06, 0])
    if (pose === 'paused') body.box(0.15, 0.08, 0.15, STEEL, [0, tall + 0.18, 0])
    else glow.box(0.15, 0.1, 0.15, lamp, [0, tall + 0.19, 0])
  })

  // ── what stands with it: the bench it works at, or the cable it charges on ──────
  if (pose === 'building') bench(body, spec)
  if (pose === 'free') {
    for (let k = 0; k < 5; k++) body.box(0.06, 0.06, 0.22, INK, [0.3 + k * 0.06, 0.03, -0.42 - k * 0.2], [0, 0.3 - k * 0.12, 0])
  }

  const group = new THREE.Group()
  group.name = 'robot'
  const solid = new THREE.Mesh(body.weld(), painted())
  solid.castShadow = true
  solid.receiveShadow = true
  group.add(solid)
  const own = [solid.geometry]
  if (!glow.empty) {
    const bright = new THREE.Mesh(glow.weld(), lit())
    group.add(bright)
    own.push(bright.geometry)
  }
  if (typeof document !== 'undefined' && plateAt) {
    const letter = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.38), new THREE.MeshBasicMaterial({ map: letterTexture(spec.initial, spec.ink), transparent: true, depthWrite: false }))
    letter.geometry.rotateY(Math.PI)
    letter.geometry.translate(0, 0.24, -0.083)
    letter.geometry.applyMatrix4(plateAt)
    group.add(letter)
    own.push(letter.geometry)
    group.userData.letter = letter.material
  }
  const spot = groundSpot()
  if (spot) group.add(spot)
  group.userData.top = new THREE.Vector3(0, Math.max(headTop + 0.25, sunk ? 1.4 : ROBOT_HEIGHT), 0)
  group.userData.dispose = () => {
    for (const g of own) g.dispose()
    group.userData.letter?.dispose()
  }
  return group
}

/** The hat on the roof of the head; the roof is `hw` by `hd` at height `hh`, head-local. */
function hat(body, glow, spec, hw, hh, hd) {
  const on = hh
  const dark = shade(spec.suit, -0.45)
  switch (spec.hat) {
    case 'crown':
      body.box(hw * 0.7, 0.1, hd * 0.7, GOLD, [0, on + 0.05, 0])
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1]]) body.box(0.09, 0.16, 0.09, GOLD, [x * hw * 0.3, on + 0.18, z * hd * 0.3])
      break
    case 'wizard':
      body.box(hw * 0.95, 0.04, hd * 0.95, dark, [0, on + 0.02, 0])
      body.rod(hw * 0.32, 0.02, 0.75, dark, [0.04, on + 0.4, 0], [0, 0, -0.12], 8)
      glow.box(0.06, 0.06, 0.06, GOLD, [-0.02, on + 0.66, 0.08])
      break
    case 'beret':
      body.rod(hw * 0.42, hw * 0.36, 0.1, dark, [0.06, on + 0.06, 0], [0, 0, -0.1], 12)
      body.box(0.04, 0.08, 0.04, dark, [0.06, on + 0.14, 0])
      break
    case 'cog':
      body.rod(0.2, 0.2, 0.1, STEEL_LIGHT, [0, on + 0.06, 0], null, 12)
      for (let k = 0; k < 8; k++) body.box(0.1, 0.1, 0.07, STEEL_LIGHT, [Math.sin((k * Math.PI) / 4) * 0.24, on + 0.06, Math.cos((k * Math.PI) / 4) * 0.24], [0, (k * Math.PI) / 4, 0])
      body.rod(0.07, 0.07, 0.12, STEEL_DARK, [0, on + 0.07, 0], null, 8)
      break
    case 'hardhat':
      body.box(hw + 0.12, 0.04, hd + 0.16, HARD_HAT, [0, on + 0.02, 0.03])
      body.dome(Math.min(hw, hd) * 0.48, HARD_HAT, [0, on + 0.03, 0])
      body.box(0.06, 0.05, hd * 0.9, shade(HARD_HAT, -0.25), [0, on + 0.26, 0])
      break
    case 'headphones':
      body.box(0.07, 0.07, 0.07, INK, [0, on + 0.16, 0])
      body.box(hw * 0.6, 0.06, 0.08, INK, [0, on + 0.15, 0])
      for (const s of [-1, 1]) {
        body.box(0.06, 0.2, 0.08, INK, [s * (hw * 0.3 + 0.04), on + 0.06, 0])
        body.box(0.1, 0.24, 0.24, INK, [s * (hw / 2 + 0.08), hh / 2 + 0.05, 0])
      }
      break
    case 'feelers':
      for (const s of [-1, 1]) {
        body.box(0.04, 0.42, 0.04, STEEL, [s * 0.18, on + 0.2, 0.05], [0, 0, s * -0.32])
        glow.box(0.09, 0.09, 0.09, spec.eyes, [s * 0.25, on + 0.4, 0.05])
      }
      break
    case 'tophat':
      body.box(hw * 0.85, 0.04, hd * 0.85, INK, [0, on + 0.02, 0])
      body.box(hw * 0.52, 0.44, hd * 0.52, INK, [0, on + 0.26, 0])
      body.box(hw * 0.53, 0.07, hd * 0.53, spec.suit, [0, on + 0.08, 0])
      break
    case 'cap':
      body.box(hw * 0.78, 0.12, hd * 0.78, dark, [0, on + 0.06, 0])
      body.box(hw * 0.7, 0.03, 0.26, dark, [0, on + 0.03, hd / 2 + 0.06])
      break
    case 'antenna':
      body.box(0.04, 0.32, 0.04, STEEL, [0.2, on + 0.16, 0])
      glow.box(0.09, 0.09, 0.09, spec.eyes, [0.2, on + 0.34, 0])
      break
    default:
      break
  }
}

/** What a clamp holds: a tool from its gear, or what its state calls for. */
function held(body, glow, spec, pose, side) {
  const right = side === 1
  if (pose === 'checking' && !right) {
    // The board it checks against: a plate with a lit list on it.
    body.box(0.42, 0.04, 0.32, INK, [0, -0.22, 0.12])
    glow.box(0.32, 0.01, 0.06, '#6ea8ff', [0, -0.19, 0.04])
    glow.box(0.26, 0.01, 0.04, '#6ea8ff', [0, -0.19, 0.14])
    return
  }
  if (spec.gear.includes('wrench') && right && pose !== 'paused') {
    body.box(0.05, 0.36, 0.05, STEEL_LIGHT, [0, -0.32, 0.03])
    body.box(0.16, 0.06, 0.05, STEEL_LIGHT, [0, -0.5, 0.03])
    body.box(0.04, 0.08, 0.05, STEEL_LIGHT, [0.06, -0.56, 0.03])
    body.box(0.04, 0.08, 0.05, STEEL_LIGHT, [-0.06, -0.56, 0.03])
  }
  if (spec.gear.includes('magnifier') && !right && pose !== 'paused') {
    body.box(0.05, 0.22, 0.05, INK, [0, -0.24, 0.03])
    body.ring(0.12, 0.025, INK, [0, -0.42, 0.03], [Math.PI / 2, 0, 0])
    glow.box(0.17, 0.17, 0.01, '#cfe3ff', [0, -0.42, 0.03])
  }
  if (spec.gear.includes('clipboard') && !right && pose !== 'paused' && pose !== 'checking') {
    body.box(0.3, 0.38, 0.04, '#a98558', [0, -0.3, 0.06])
    body.box(0.24, 0.26, 0.01, '#f2f4f6', [0, -0.32, 0.085])
  }
}

/** What it wears: across the body, round the waist, on the back. */
function worn(body, spec, { top, deep, shoulders, base }) {
  const tall = shoulders - base
  const front = deep / 2 + 0.012
  if (spec.gear.includes('sash')) body.box(0.12, Math.hypot(top, tall) * 0.92, 0.02, GOLD, [0, base + tall / 2, front], [0, 0, -Math.atan2(top, tall) * 0.85])
  if (spec.gear.includes('bowtie')) {
    body.slab(0.02, 0.12, 0.11, 0.05, '#c0271b', [0.065, shoulders - 0.16, front + 0.01], [0, 0, Math.PI / 2])
    body.slab(0.02, 0.12, 0.11, 0.05, '#c0271b', [-0.065, shoulders - 0.16, front + 0.01], [0, 0, -Math.PI / 2])
    body.box(0.05, 0.05, 0.05, '#8a1a12', [0, shoulders - 0.1, front + 0.02])
  }
  if (spec.gear.includes('toolbelt')) {
    const waist = base + Math.min(0.24, tall * 0.3)
    body.box(top * 1.06, 0.09, deep + 0.05, '#7a5a35', [0, waist, 0])
    body.box(0.16, 0.18, 0.08, '#a98558', [top * 0.3, waist - 0.07, front + 0.04])
    body.box(0.13, 0.15, 0.08, '#a98558', [-top * 0.32, waist - 0.06, front + 0.04])
  }
  if (spec.gear.includes('satchel')) {
    body.box(0.06, Math.hypot(top, tall) * 0.9, 0.02, '#7a5a35', [0, base + tall / 2, front], [0, 0, Math.atan2(top, tall) * 0.85])
    body.box(0.3, 0.24, 0.14, '#a98558', [-(top / 2 + 0.12), base + 0.22, 0.04])
  }
  if (spec.gear.includes('cape')) body.slab(top * 1.4, top * 0.95, tall + 0.02, 0.03, shade(spec.suit, -0.35), [0, base - 0.02, -deep / 2 - 0.05], [-0.1, 0, 0])
}

/** The bench a building robot works at, with the piece in hand on it in the robot's own colour. */
function bench(body, spec) {
  const z = 0.92
  body.box(1.2, 0.08, 0.56, '#a98558', [0, 0.82, z])
  for (const [x, dz] of [[-0.52, -0.22], [0.52, -0.22], [-0.52, 0.22], [0.52, 0.22]]) body.box(0.07, 0.78, 0.07, STEEL_DARK, [x, 0.39, z + dz])
  body.box(1.1, 0.05, 0.46, STEEL_DARK, [0, 0.24, z])
  body.box(0.36, 0.2, 0.26, spec.suit, [0.05, 0.96, z + 0.02])
  body.box(0.18, 0.06, 0.12, INK, [0.05, 1.09, z + 0.02])
}
