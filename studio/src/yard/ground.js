import * as THREE from 'three'
import { Kit, painted, lit, PAINT, wearTexture } from '../robots/kit.js'

/**
 * The yard's ground and light: asphalt laid in slabs, a sky the ground fades into, the sun or the
 * floodlights, and what stands about between the bays (containers, pallets, cable reels, masts).
 * Day and night are the same yard in two lights; nothing here moves.
 */

export const LIGHTS = {
  // A clear morning: a warm low sun from one side, the cool sky filling the shade, warm light
  // thrown back up off the ground. Shade reads blue-grey, sunlit faces cream.
  day: {
    sky: '#c3cfdc', fog: [170, 430],
    ground: '#7e8288', groundFar: '#5b6068', joint: '#696e76',
    hemi: ['#cfdcf0', '#6a5e50', 1.2], sun: ['#ffe4c2', 3.0], sunFrom: [-0.7, 0.8, 0.42],
    concrete: '#cbc5b6', lampPool: 0.07, bayGlow: 0,
    rim: ['#bcd2f0', 0.22], wear: 1,
  },
  // Moonlight from the other side, the floodlights warm on the ground and each bay lit in its own paint.
  night: {
    sky: '#0b0f17', fog: [120, 380],
    ground: '#3a404a', groundFar: '#161a21', joint: '#30343c',
    hemi: ['#6578a3', '#0c0e13', 1.0], sun: ['#b9cbff', 0.95], sunFrom: [0.4, 1, 0.55],
    concrete: '#8a8e96', lampPool: 0.55, bayGlow: 0.34,
    rim: ['#7d97d6', 0.42], wear: 0.8,
  },
}

/** Paints of what stands about the yard. */
const CRATES = ['#2f6fb5', '#b5482f', '#3f8f5f', '#c9a227', '#6d7884']
const WOOD = '#a98558'
const STEEL = '#4a515c'
const STEEL_DARK = '#23272e'

const SIZE = 700

/** Asphalt, drawn once: two shades of slab, grit, and the joints between slabs. */
function asphalt() {
  const n = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, n, n)
  g.fillStyle = '#f1f1f1'
  g.fillRect(n / 2, 0, n / 2, n / 2)
  g.fillRect(0, n / 2, n / 2, n / 2)
  let seed = 7
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647)
  for (let k = 0; k < 7000; k++) {
    g.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${0.25 * rnd()})` : `rgba(0,0,0,${0.12 * rnd()})`
    g.fillRect(rnd() * n, rnd() * n, 1 + rnd(), 1 + rnd())
  }
  g.fillStyle = 'rgba(0,0,0,0.28)'
  for (const at of [0, n / 2]) {
    g.fillRect(at, 0, 3, n)
    g.fillRect(0, at, n, 3)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(SIZE / 30, SIZE / 30)
  texture.anisotropy = 8
  return texture
}

/**
 * The asphalt's material: the slab texture, laid over with soft stains at three sizes that never
 * repeat, so the ground does not show the slab texture tiling across the whole yard.
 */
function asphaltMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: typeof document === 'undefined' ? null : asphalt() })
  const speckle = wearTexture()
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSpeckle = { value: speckle }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGround = position.xz / 97.0;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uSpeckle;\nvarying vec2 vGround;')
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= 0.88 + 0.22 * dot(texture2D(uSpeckle, vGround).rgb, vec3(0.55, 0.3, 0.15));`)
  }
  return material
}

let pool = null
/** A soft round of light on the ground, shared by every floodlight. */
function poolTexture() {
  if (pool) return pool
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const g = canvas.getContext('2d')
  const fade = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  fade.addColorStop(0, 'rgba(255,255,255,1)')
  fade.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = fade
  g.fillRect(0, 0, 64, 64)
  pool = new THREE.CanvasTexture(canvas)
  return pool
}

export class Ground {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'ground'
    scene.add(this.group)

    const plane = new THREE.PlaneGeometry(SIZE, SIZE, 48, 48)
    plane.rotateX(-Math.PI / 2)
    plane.setAttribute('color', new THREE.BufferAttribute(new Float32Array(plane.attributes.position.count * 3), 3))
    this.floor = new THREE.Mesh(plane, asphaltMaterial())
    this.floor.receiveShadow = true
    // The ground is drawn after everything standing on it, so the card never shades asphalt that a
    // bay or a container then covers.
    this.floor.renderOrder = 1
    this.group.add(this.floor)

    this.hemi = new THREE.HemisphereLight()
    this.sun = new THREE.DirectionalLight()
    this.sun.castShadow = true
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    // A wide soft edge costs nothing more: the same taps, spread further.
    this.sun.shadow.radius = 2.5
    scene.add(this.hemi, this.sun, this.sun.target)
    this.props = null
    this.spread = 60
  }

  /** Dress the ground for day or night. */
  light(hour) {
    const l = LIGHTS[hour] || LIGHTS.day
    this.hour = hour
    this.scene.background = new THREE.Color(l.sky)
    this.scene.fog = new THREE.Fog(l.sky, l.fog[0], l.fog[1])
    this.hemi.color.set(l.hemi[0])
    this.hemi.groundColor.set(l.hemi[1])
    this.hemi.intensity = l.hemi[2]
    this.sun.color.set(l.sun[0])
    this.sun.intensity = l.sun[1]
    this._paintGround(l)
    if (this.poolMaterial) this.poolMaterial.opacity = l.lampPool
    if (this.lensMaterial) this.lensMaterial.color.setScalar(hour === 'night' ? 1.6 : 0.85)
    if (this.glowMaterial) {
      this.glowMaterial.opacity = l.bayGlow
      this.glowMesh.visible = l.bayGlow > 0
    }
    PAINT.uRim.value.set(l.rim[0]).multiplyScalar(l.rim[1])
    PAINT.uWear.value = l.wear
    this._aimSun()
  }

  /** The ground's paint fades from the middle of the yard out to the edge of what is seen. */
  _paintGround(l) {
    const near = new THREE.Color(l.ground)
    const far = new THREE.Color(l.groundFar)
    const c = new THREE.Color()
    const p = this.floor.geometry.attributes.position
    const out = this.floor.geometry.attributes.color
    for (let i = 0; i < p.count; i++) {
      const t = THREE.MathUtils.smoothstep(Math.hypot(p.getX(i), p.getZ(i)), this.spread * 0.7, this.spread * 2.4)
      c.copy(near).lerp(far, t).toArray(out.array, i * 3)
    }
    out.needsUpdate = true
  }

  /** The sun is placed so its shadows cover exactly the yard in use. */
  _aimSun() {
    const l = LIGHTS[this.hour] || LIGHTS.day
    const r = this.spread
    const [x, y, z] = l.sunFrom
    this.sun.position.set(x * r * 1.6, y * r * 1.6, z * r * 1.6)
    this.sun.target.position.set(0, 0, 0)
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -r
    cam.right = cam.top = r
    cam.near = 1
    cam.far = r * 4.5
    cam.updateProjectionMatrix()
  }

  /**
   * A soft pool of each bay's own paint round its charging post, seen at night only. One drawing
   * for every bay together.
   * @param {{x:number,z:number,paint:string}[]} bays
   */
  glows(bays) {
    if (typeof document === 'undefined') return
    if (this.glowMesh) {
      this.group.remove(this.glowMesh)
      this.glowMesh.dispose()
      this.glowMesh = null
    }
    if (!bays.length) return
    this.glowMaterial ||= new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.glowQuad ||= new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2)
    const mesh = new THREE.InstancedMesh(this.glowQuad, this.glowMaterial, bays.length)
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    bays.forEach((b, i) => {
      mesh.setMatrixAt(i, m.makeTranslation(b.x, 0.33, b.z))
      mesh.setColorAt(i, c.set(b.paint))
    })
    mesh.renderOrder = -1
    this.glowMesh = mesh
    this.group.add(mesh)
    if (this.hour) this.light(this.hour)
  }

  /** How fine the sun's shadows are; 0 for none. */
  shadows(size) {
    this.sun.castShadow = size > 0
    if (size > 0 && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
  }

  /**
   * Stand things about the yard on the free spots given, each spot's thing chosen by its place so
   * it is the same on every visit. Returns the circles the crew is kept out of.
   * @param {{x:number,z:number,key:string}[]} spots
   * @param {number} spread how far the yard reaches from its middle
   */
  dress(spots, spread) {
    this.spread = spread
    if (this.props) {
      this.group.remove(this.props)
      this.props.traverse((o) => { if (o.isMesh) o.geometry.dispose() })
    }
    const solid = new Kit()
    const lenses = new Kit()
    lenses.joint = solid.joint
    const pools = []
    for (const spot of spots) {
      const pick = hashOf(spot.key)
      solid.from([spot.x, 0, spot.z], [0, ((pick >> 4) % 6) * (Math.PI / 6), 0], () => {
        const kind = pick % 7
        if (kind <= 1) container(solid, pick)
        else if (kind <= 3) { mast(solid, lenses); pools.push(spot) }
        else if (kind <= 5) pallets(solid, pick)
        else reel(solid)
      })
    }
    this.props = new THREE.Group()
    this.props.name = 'yard-things'
    if (!solid.empty) {
      const mesh = new THREE.Mesh(solid.weld(), painted())
      mesh.castShadow = mesh.receiveShadow = true
      this.props.add(mesh)
    }
    if (!lenses.empty) {
      this.lensMaterial ||= lit().clone()
      this.props.add(new THREE.Mesh(lenses.weld(), this.lensMaterial))
    }
    if (pools.length && typeof document !== 'undefined') {
      this.poolMaterial ||= new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#ffe2a6', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
      const quad = new THREE.PlaneGeometry(11, 11)
      quad.rotateX(-Math.PI / 2)
      const lamps = new THREE.InstancedMesh(quad, this.poolMaterial, pools.length)
      const m = new THREE.Matrix4()
      pools.forEach((p, i) => lamps.setMatrixAt(i, m.makeTranslation(p.x, 0.02, p.z)))
      lamps.renderOrder = -2
      this.props.add(lamps)
    }
    this.group.add(this.props)
    if (this.hour) this.light(this.hour)
  }
}

/** A stable number from a word, so a spot's thing does not change between visits. */
function hashOf(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

function container(kit, pick) {
  const paint = CRATES[pick % CRATES.length]
  const box = (y, turn, colour) => kit.from([0, y, 0], [0, turn, 0], () => {
    kit.box(6, 2.4, 2.4, colour, [0, 1.2, 0])
    for (let k = -2; k <= 2; k++) kit.box(0.08, 2.2, 2.44, STEEL_DARK, [k * 1.2, 1.2, 0])
    for (const z of [-1.17, 1.17]) kit.box(6.04, 0.12, 0.1, STEEL_DARK, [0, 2.36, z])
  })
  box(0, 0, paint)
  if ((pick >> 8) % 3 === 0) box(2.42, (pick >> 9) % 2 ? 0 : 0.5, CRATES[(pick >> 10) % CRATES.length])
}

function mast(kit, lenses) {
  kit.rod(0.5, 0.56, 0.3, STEEL_DARK, [0, 0.15, 0], null, 8)
  kit.rod(0.1, 0.14, 5, STEEL, [0, 2.8, 0], null, 8)
  kit.box(1.7, 0.1, 0.16, STEEL_DARK, [0, 5.3, 0])
  for (const s of [-1, 1]) {
    kit.box(0.5, 0.32, 0.42, STEEL_DARK, [s * 0.66, 5.12, 0])
    lenses.box(0.4, 0.04, 0.32, '#fff2cc', [s * 0.66, 4.95, 0])
  }
}

function pallets(kit, pick) {
  for (const [x, layers] of [[-1, 1 + (pick % 2)], [1, 1 + ((pick >> 3) % 2)]]) {
    kit.box(1.5, 0.14, 1.3, WOOD, [x, 0.07, 0])
    for (let k = 0; k < layers; k++) kit.box(1.28 - k * 0.24, 0.62, 1.08 - k * 0.2, CRATES[(pick + x + k + 5) % CRATES.length], [x, 0.45 + k * 0.62, 0], [0, k * 0.2, 0])
  }
  kit.rod(0.3, 0.3, 0.84, CRATES[(pick >> 5) % CRATES.length], [0, 0.42, 1.25], null, 12)
}

function reel(kit) {
  for (const s of [-1, 1]) kit.rod(0.9, 0.9, 0.12, WOOD, [-1, 0.9, s * 0.4], [Math.PI / 2, 0, 0], 16)
  kit.rod(0.44, 0.44, 0.7, STEEL_DARK, [-1, 0.9, 0], [Math.PI / 2, 0, 0], 12)
  for (const s of [-1, 1]) kit.box(0.1, 1.5, 0.1, STEEL, [1.1, 0.75, s * 0.7])
  kit.box(0.1, 0.1, 1.5, STEEL, [1.1, 1.45, 0])
  for (let k = 0; k < 3; k++) kit.box(0.06, 1.2, 1.2, k === 1 ? CRATES[2] : '#9aa2ad', [0.85 + k * 0.16, 0.62, 0])
}
