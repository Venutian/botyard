import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RADIUS, brainDust, fieldLayout } from './brain-layout.js'

/**
 * Engram's field: the notes as neurons in a brain of dust. A note glows in its area's colour; a decision burns
 * brighter than a preference; the newest decisions are white-hot; a superseded note is ash with a grey fibre
 * to what replaced it; a link is a fibre bent through the brain. Drawn only when something changes or while
 * the owner moves it (and once, for a short glide in): never in a loop while nobody looks.
 */

/** Light inks on the dark field, one per area, in the order the areas come. */
export const INKS = ['#6ea8ff', '#46f0cc', '#b98cff', '#ff9a5c', '#ff6fcf', '#9be564', '#ffd166', '#ff7a7a', '#6fd8ff', '#e7c99a']
const ASH = new THREE.Color('#5d6676')
const WHITE = new THREE.Color('#ffffff')

const NODE_VERT = `
attribute float size;
attribute float glow;
attribute float ring;
attribute vec3 color;
varying vec3 vColor;
varying float vGlow;
varying float vRing;
uniform float scale;
void main() {
  vColor = color; vGlow = glow; vRing = ring;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`
const NODE_FRAG = `
varying vec3 vColor;
varying float vGlow;
varying float vRing;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.30, 0.0, d);
  float halo = exp(-d * d * 5.0) * 0.55;
  float ring = vRing * smoothstep(0.08, 0.0, abs(d - 0.78)) * 0.7;
  vec3 c = mix(vColor, vec3(1.0), core * 0.55);
  gl_FragColor = vec4(c * (core + halo + ring) * vGlow, 1.0);
}`
const DUST_FRAG = `
varying vec3 vTint;
uniform float strength;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vTint * (1.0 - d) * strength, 1.0);
}`

/** A fibre between two neurons: bent towards the brain's middle, as nerve tracts are. */
function fibre(a, b, steps = 18) {
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
  const pull = Math.min(1, a.distanceTo(b) / (RADIUS * 1.2))
  const ctrl = mid.clone().multiplyScalar(1 - 0.55 * pull)
  const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b)
  return curve.getPoints(steps)
}

export class BrainField {
  /**
   * @param {HTMLElement} host the stage the canvas fills
   * @param {{ pick: (id: string) => void, hover: (id: string, x: number, y: number) => void }} acts
   */
  constructor(host, acts) {
    this.host = host
    this.acts = acts
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    // Given in linear light: the composer passes the clear colour through as it is, and sRGB #020309 would show as #161c35.
    this.renderer.setClearColor(new THREE.Color().setRGB(0.0006, 0.0009, 0.0028, THREE.LinearSRGBColorSpace), 1)
    this.renderer.domElement.className = 'bf-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    host.prepend(this.renderer.domElement)
    this.labels = document.createElement('div')
    this.labels.className = 'bf-labels'
    host.append(this.labels)
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#020309')
    this.scene.fog = new THREE.FogExp2('#020309', 0.0009)
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 4000)
    this.camera.position.set(560, 130, 170)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.09
    this.controls.minDistance = 140
    this.controls.maxDistance = 1300
    this.controls.rotateSpeed = 0.6
    this.controls.addEventListener('change', () => this.request())
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.32, 0.42)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    this._dust()
    this.group = new THREE.Group()
    this.scene.add(this.group)
    this.ray = new THREE.Raycaster()
    this.mouse = new THREE.Vector2()
    this.state = { dim: () => false, chosen: '', near: null }
    const el = this.renderer.domElement
    let down = null
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY] })
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) { const id = this._hit(e); if (id) this.acts.pick(id) }
      down = null
    })
    el.addEventListener('pointermove', (e) => { if (e.buttons) return; const id = this._hit(e); el.style.cursor = id ? 'pointer' : 'grab'; this.acts.hover(id, e.offsetX, e.offsetY) })
    el.addEventListener('pointerleave', () => this.acts.hover('', 0, 0))
    new ResizeObserver(() => this.resize()).observe(host)
    this.on = false
  }

  _dust() {
    const geo = new THREE.BufferGeometry()
    const dust = brainDust(10000)
    geo.setAttribute('position', new THREE.BufferAttribute(dust, 3))
    // Blue at the front of the brain, violet at the back.
    const tint = new Float32Array(dust.length)
    const front = new THREE.Color('#4f8dff')
    const back = new THREE.Color('#9a6bff')
    const c = new THREE.Color()
    for (let i = 0; i < dust.length; i += 3) {
      c.lerpColors(back, front, Math.min(1, Math.max(0, dust[i + 2] / (RADIUS * 2.2) + 0.5)))
      tint.set([c.r, c.g, c.b], i)
    }
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3))
    const mat = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0.5 }, scale: { value: 300 } },
      vertexShader: 'attribute vec3 tint; varying vec3 vTint; uniform float scale; void main(){ vTint = tint; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = 1.7 * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: DUST_FRAG, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    })
    this.dust = new THREE.Points(geo, mat)
    this.scene.add(this.dust)
  }

  show(on) {
    this.on = on
    if (on) { this.resize(); this.request() }
  }

  resize() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.resolution.set(w / 2, h / 2)
    this.camera.aspect = w / h
    // A narrow window steps back so the whole brain fits.
    this.camera.updateProjectionMatrix()
    const scale = h * this.renderer.getPixelRatio() * 0.9
    this.nodes && (this.nodes.material.uniforms.scale.value = scale)
    this.dust.material.uniforms.scale.value = scale
    this.request()
  }

  /** Build the neurons and fibres for a vault. Called only when the notes change. */
  setBrain(brain) {
    this.brain = brain
    for (const child of [...this.group.children]) { this.group.remove(child); child.geometry?.dispose(); child.material?.dispose() }
    const { at, centres } = fieldLayout(brain)
    this.at = new Map([...at].map(([id, p]) => [id, new THREE.Vector3(p.x, p.y, p.z)]))
    this.slot = new Map(brain.areas.map((a, i) => [a.id, i % INKS.length]))
    const notes = brain.notes
    this.order = notes.map((n) => n.id)
    const pos = new Float32Array(notes.length * 3)
    notes.forEach((n, i) => { const p = this.at.get(n.id); pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(notes.length * 3), 3))
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    geo.setAttribute('ring', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    this.nodes = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 } }, vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }))
    this.group.add(this.nodes)
    // Fibres: one LineSegments for links, one for "replaced by"; colour is brightness (they add up).
    this.links = []
    this.replaced = []
    for (const n of notes) {
      for (const t of n.links) if (this.at.has(t)) this.links.push([n.id, t])
      for (const t of n.supersededBy) if (this.at.has(t)) this.replaced.push([n.id, t])
    }
    this.linkLines = this._lines(this.links, 0.9)
    this.replacedLines = this._lines(this.replaced, 1, true)
    this.group.add(this.linkLines, this.replacedLines)
    this.centres = centres
    this.labels.innerHTML = brain.areas.map((a) => `<button type="button" class="bf-label" data-area="${a.id}" style="--ink:${INKS[this.slot.get(a.id)]}">${a.name.replace(/[<>&]/g, '')}<span>${a.count}</span></button>`).join('')
    this.paint()
    if (!this._glided) this._glide()
  }

  _lines(pairs, segments, dashed = false) {
    const pts = []
    this._steps = 18
    for (const [a, b] of pairs) {
      const curve = fibre(this.at.get(a), this.at.get(b), this._steps)
      for (let i = 0; i < curve.length - 1; i += 1) pts.push(curve[i], curve[i + 1])
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3))
    const mat = dashed
      ? new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 5, gapSize: 4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const line = new THREE.LineSegments(geo, mat)
    if (dashed) line.computeLineDistances()
    void segments
    return line
  }

  /**
   * Colour, size and brightness from the state: `dim(id)` says a note is out of the search, the scrub or the
   * chosen area; `chosen` and `near` light one note and its neighbours.
   */
  paint(state = this.state) {
    this.state = state
    if (!this.brain) return
    const notes = this.brain.notes
    const col = this.nodes.geometry.attributes.color
    const size = this.nodes.geometry.attributes.size
    const glow = this.nodes.geometry.attributes.glow
    const ring = this.nodes.geometry.attributes.ring
    const newest = Date.parse(`${this.brain.to}T12:00:00Z`) - 3 * 86400000
    const c = new THREE.Color()
    this.light = new Map()
    notes.forEach((n, i) => {
      const old = n.status === 'superseded'
      const fresh = n.kind === 'decision' && !old && Date.parse(`${n.date}T12:00:00Z`) >= newest
      c.set(INKS[this.slot.get(n.area) ?? 0])
      if (old) c.copy(ASH)
      if (fresh) c.lerp(WHITE, 0.3)
      const base = (n.kind === 'decision' ? 21 : n.kind === 'preference' ? 16 : 12) + (n.pinned ? 6 : 0) + Math.min(6, n.links.length * 1.5) + (fresh ? 6 : 0)
      let g = old ? 0.5 : n.kind === 'decision' ? 1.1 : 0.9
      if (fresh) g = 1.45
      const out = state.dim(n.id) || (state.near && !state.near.has(n.id))
      if (out) g *= 0.12
      if (n.id === state.chosen) g = Math.max(g, 1.8)
      this.light.set(n.id, out ? 0.12 : 1)
      col.setXYZ(i, c.r, c.g, c.b)
      size.setX(i, (n.id === state.chosen ? base * 1.6 : base) * (old ? 0.75 : 1))
      glow.setX(i, g)
      ring.setX(i, n.imported ? 1 : 0)
    })
    col.needsUpdate = size.needsUpdate = glow.needsUpdate = ring.needsUpdate = true
    this._paintLines(this.linkLines, this.links, 0.7)
    this._paintLines(this.replacedLines, this.replaced, 0.75, true)
    for (const el of this.labels.children) el.classList.toggle('dim', Boolean(state.area) && el.dataset.area !== state.area)
    this.request()
  }

  _paintLines(line, pairs, strength, ash = false) {
    const col = line.geometry.attributes.color
    const per = this._steps * 2
    const a = new THREE.Color()
    const b = new THREE.Color()
    const byId = new Map(this.brain.notes.map((n) => [n.id, n]))
    pairs.forEach(([from, to], k) => {
      a.set(INKS[this.slot.get(byId.get(from)?.area) ?? 0])
      b.set(INKS[this.slot.get(byId.get(to)?.area) ?? 0])
      if (ash) { a.copy(ASH); b.set('#c9d2e0') }
      const touched = this.state.chosen && (from === this.state.chosen || to === this.state.chosen)
      const s = strength * Math.min(this.light.get(from), this.light.get(to)) * (this.state.chosen ? (touched ? 2.4 : 0.25) : 1)
      for (let i = 0; i < per; i += 1) {
        const t = Math.floor(i / 2 + (i % 2)) / this._steps
        // Brightest in the middle of the fibre: it reads as light travelling, not a wire.
        const lift = s * (0.55 + Math.sin(t * Math.PI) * 0.6)
        col.setXYZ(k * per + i, (a.r + (b.r - a.r) * t) * lift, (a.g + (b.g - a.g) * t) * lift, (a.b + (b.b - a.b) * t) * lift)
      }
    })
    col.needsUpdate = true
  }

  /** Turn to a note: the camera moves round so it is in front, then everything stands still. */
  focus(id) {
    const p = this.at?.get(id)
    if (!p) return
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const dist = Math.min(this.camera.position.distanceTo(this.controls.target), 420)
    this._tween(p.clone().multiplyScalar(0.6), p.clone().multiplyScalar(0.6).add(dir.multiplyScalar(dist)))
  }

  /** The one entrance: from far off, gliding in. Skipped when the owner asks for less motion. */
  _glide() {
    this._glided = true
    const end = new THREE.Vector3(560, 130, 170)
    if (this.reduced) { this.camera.position.copy(end); return this.request() }
    this.camera.position.set(1500, 520, -300)
    this._tween(new THREE.Vector3(), end, 1600)
  }

  _tween(target, position, ms = 700) {
    if (this.reduced) { this.controls.target.copy(target); this.camera.position.copy(position); this.controls.update(); return this.request() }
    const t0 = performance.now()
    const fromT = this.controls.target.clone()
    const fromP = this.camera.position.clone()
    this._moving = (now) => {
      const k = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      this.controls.target.lerpVectors(fromT, target, e)
      this.camera.position.lerpVectors(fromP, position, e)
      if (k >= 1) this._moving = null
      return k < 1
    }
    this.request()
  }

  /** One frame now, and more only while the camera is still moving. */
  request() {
    if (this._frame || !this.on) return
    this._frame = requestAnimationFrame((now) => {
      this._frame = 0
      const tweening = this._moving ? this._moving(now) : false
      const damping = this.controls.update()
      this.composer.render()
      this._place()
      if (tweening || damping) this.request()
    })
  }

  /** Area names float over their lobes, smaller the further away. */
  _place() {
    if (!this.centres) return
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    const v = new THREE.Vector3()
    const placed = []
    for (const el of this.labels.children) {
      const c = this.centres.get(el.dataset.area)
      if (!c) continue
      v.set(c.x, c.y + 46, c.z).project(this.camera)
      const behind = v.z > 1
      // A label that would cover another steps down below it.
      const x = ((v.x + 1) / 2) * w
      let y = ((1 - v.y) / 2) * h
      const half = (el.offsetWidth || 80) / 2
      for (let tries = 0; tries < 6; tries += 1) {
        const hit = placed.find((p) => Math.abs(p.x - x) < p.half + half + 4 && Math.abs(p.y - y) < 24)
        if (!hit) break
        y = hit.y + 26
      }
      if (!behind) placed.push({ x, y, half })
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
      el.style.opacity = behind ? '0' : '1'
    }
  }

  /** Which note is under the pointer, if any. */
  _hit(e) {
    if (!this.nodes) return ''
    const r = this.renderer.domElement.getBoundingClientRect()
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.mouse, this.camera)
    this.ray.params.Points.threshold = 7 * (this.camera.position.distanceTo(this.controls.target) / 520)
    const hits = this.ray.intersectObject(this.nodes).filter((h) => (this.light?.get(this.order[h.index]) ?? 1) > 0.5)
    return hits.length ? this.order[hits[0].index] : ''
  }

  /** Where a note is on the screen, for the label beside the pointer. */
  screenOf(id) {
    const p = this.at?.get(id)
    if (!p) return null
    const v = p.clone().project(this.camera)
    return { x: ((v.x + 1) / 2) * this.host.clientWidth, y: ((1 - v.y) / 2) * this.host.clientHeight }
  }
}
