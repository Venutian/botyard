import { DESCRIBE } from './describe.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { RADIUS, brainDust, fieldLayout } from './brain-layout.js'

/**
 * Engram's field: the notes as neurons in a brain of dust. A note glows in its area's colour; a decision burns
 * brighter than a preference; the newest decisions are white-hot; a superseded note is ash with a grey fibre
 * to what replaced it; a link is a fibre bent through the brain. While it is open it turns slowly, its neurons
 * breathe and signals run along the fibres (the owner's choice, 18 Nov 2026); hidden, in a background tab or with
 * reduced motion asked for, it draws nothing until something changes.
 */

/** Light inks on the dark field, one per area, in the order the areas come. */
export const INKS = ['#6ea8ff', '#46f0cc', '#b98cff', '#ff9a5c', '#ff6fcf', '#9be564', '#ffd166', '#ff7a7a', '#6fd8ff', '#e7c99a']
/** Ink on the pale day window: the same hues, deep enough to read on it (at least 3:1). */
/** Ink on the mid-tone day window (#b9c2ce): each mark at least 3:1 on it. */
export const DAY_INKS = ['#0d3f8f', '#05543f', '#4d1f9e', '#7e2c06', '#7a0a5a', '#2e4f05', '#5c3f00', '#8a130a', '#0b4766', '#463620']
const DAY_VOID = '#b9c2ce'
const AMBER = new THREE.Color('#e08a00')
const ASH = new THREE.Color('#5d6676')
const WHITE = new THREE.Color('#ffffff')
/** How close the camera is: 0 far off, 1 right inside the brain. */
export function zoomFactor(dist) { return Math.max(0, Math.min(1, (ZOOM_START - dist) / (ZOOM_START - ZOOM_FULL))) }

/** The nearest note to the camera, skipping notes dimmed by search or area; when `seen` is given, the nearest one it
 * says is on the stage, and the nearest of all only when none is. */
export function nearestNote(at, order, cam, light, seen) {
  if (seen) { const on = nearestNote(at, order.filter(seen), cam, light); if (on) return on }
  let best = ''
  let bestD = Infinity
  for (const id of order) {
    if ((light?.get(id) ?? 1) <= 0.5) continue
    const p = at.get(id)
    if (!p) continue
    const d = p.distanceTo(cam)
    if (d < bestD) { bestD = d; best = id }
  }
  return best
}

/** Where a title plate's anchor goes when its neuron is off the stage: on the stage's edge, `m` in from it, along
 * the line from the middle of the stage towards the neuron (dx, dy in pixels from the middle). */
export function edgePoint(dx, dy, w, h, m = 8) {
  const hw = Math.max(1, w / 2 - m)
  const hh = Math.max(1, h / 2 - m)
  if (!dx && !dy) return { x: w / 2, y: h - m }
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  return { x: w / 2 + dx * t, y: h / 2 + dy * t }
}

/** A box of size bw x bh centred on (x, y), moved the least it takes to sit fully inside w x h with `pad` to spare. */
export function clampBox(x, y, bw, bh, w, h, pad = 6) {
  const left = Math.min(Math.max(pad, x - bw / 2), Math.max(pad, w - pad - bw))
  const top = Math.min(Math.max(pad, y - bh / 2), Math.max(pad, h - pad - bh))
  return { left, top, right: left + bw, bottom: top + bh }
}

const hits = (a, b, gap = 0) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top

/**
 * Which neuron titles to draw and where, all inside the w x h stage and none over another or over `avoid`.
 * `cands` are { id, x, y, d, inFrame, w, h }: the plate's anchor in stage pixels (already on the edge for a neuron
 * off the stage), its distance from the camera and its plate size. Neurons in frame come first, nearest first, up
 * to `max`; neurons off the stage, nearest first, only make up the count to `least`, pinned to the edge.
 * A plate that would cover another steps down, then up, a row at a time; one with no room left is skipped.
 */
export function layoutTitles(cands, { w, h, max = 12, least = 6, pad = 6, avoid = [] }) {
  const inFrame = cands.filter((c) => c.inFrame).sort((a, b) => a.d - b.d)
  const off = cands.filter((c) => !c.inFrame).sort((a, b) => a.d - b.d)
  const taken = [...avoid]
  const shown = []
  const put = (c) => {
    // Rows down and up first, as far as the stage goes; then the same rows half a plate to either side.
    const rows = 2 * Math.ceil(h / (c.h + 4)) + 1
    for (const dx of [0, -0.6 * c.w, 0.6 * c.w]) for (let k = 0; k < rows; k += 1) {
      const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (c.h + 4)
      const box = clampBox(c.x + dx, c.y + step, c.w, c.h, w, h, pad)
      if (!taken.some((t) => hits(t, box, 2))) { taken.push(box); shown.push({ ...c, box }); return }
    }
  }
  for (const c of inFrame) { if (shown.length >= max) break; put(c) }
  for (const c of off) { if (shown.length >= Math.min(max, least)) break; put(c) }
  return shown
}

/**
 * Which neuron titles are drawn with the camera `dist` from the orbit target: none until the zoom begins (zoomFactor),
 * then layoutTitles over the neurons still lit (`light` above half: search and area dimming drop the rest), so the
 * nearest ones, at most `max`, none overlapping. The live frame calls this; the tests call it with plain numbers.
 */
export function titlesAt(dist, cands, opts) {
  if (zoomFactor(dist) <= 0) return []
  return layoutTitles(cands.filter((c) => (c.light ?? 1) > 0.5), opts)
}

/** The excerpt plate beside its neuron: below right, flipped left or up where the stage runs out, then kept inside. */
export function placeExcerpt(x, y, bw, bh, w, h, pad = 6) {
  let left = x + 16
  let top = y + 14
  if (left + bw > w - pad) left = x - 16 - bw
  if (top + bh > h - pad) top = y - 14 - bh
  left = Math.min(Math.max(pad, left), Math.max(pad, w - pad - bw))
  top = Math.min(Math.max(pad, top), Math.max(pad, h - pad - bh))
  return { left, top, right: left + bw, bottom: top + bh }
}

/** Under this camera distance the brain turns immersive: labels, depth and eased aim. */
const ZOOM_IN = 300
/** Labels begin to fade in at this distance, full at ZOOM_FULL. */
const ZOOM_START = 360
const ZOOM_FULL = 140
/** At most this many neuron labels are drawn at once, nearest first. */
const LABEL_MAX = 12
/** At least this many titles while zoomed in: neurons off the stage make up the count, pinned to its edge. */
const LABEL_LEAST = 6
/** A title plate's size: its text, plus the bar, the gap, padding and border (brain-map.css), and the arrow on the edge. */
const PLATE_EXTRA = 28
const PLATE_EDGE = 13
const PLATE_H = 23
const PLATE_MAX = 220
/** How much faster the nearest note's signals run, and how much brighter its links. */
const NEAR_SPEED = 2.2
const NEAR_BRIGHT = 1.5

const NODE_VERT = `
attribute float size;
attribute float glow;
attribute float ring;
attribute float phase;
attribute vec3 color;
varying vec3 vColor;
varying float vGlow;
varying float vRing;
uniform float scale;
uniform float time;
uniform float day;
uniform float nodeZoom;
void main() {
  float breath = 1.0 + 0.12 * sin(time * 1.3 + phase * 6.2831);
  vColor = color; vGlow = glow * (0.9 + 0.1 * breath); vRing = ring;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * breath * (1.0 + 0.45 * day) * (1.0 + 1.5 * nodeZoom) * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`
const NODE_FRAG = `
varying vec3 vColor;
varying float vGlow;
varying float vRing;
uniform float day;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.30, 0.0, d);
  float halo = exp(-d * d * 5.0) * 0.55;
  float ring = vRing * smoothstep(0.08, 0.0, abs(d - 0.78)) * 0.7;
  if (day > 0.5) {
    // By day a neuron is ink with a soft halo of its own colour, laid over the pale window.
    float dot = smoothstep(0.40, 0.30, d);
    float glow = exp(-d * d * 4.0) * 0.30;
    float a = clamp((dot + glow + ring) * min(vGlow, 1.2), 0.0, 1.0);
    gl_FragColor = vec4(vColor, a);
  } else {
    vec3 c = mix(vColor, vec3(1.0), core * 0.55);
    gl_FragColor = vec4(c * (core + halo + ring) * vGlow, 1.0);
  }
}`
const DUST_FRAG = `
varying vec3 vTint;
varying float vKeep;
uniform float strength;
uniform float day;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  if (day > 0.5) { if (vKeep > 0.22) discard; gl_FragColor = vec4(vec3(0.20, 0.25, 0.36), (1.0 - d * d) * 0.38); }
  else gl_FragColor = vec4(vTint * (1.0 - d) * strength, 1.0);
}`

const FIBRE_VERT = `
attribute vec3 color;
attribute float along;
attribute float lane;
attribute float speed;
varying vec3 vColor;
varying float vAlong;
varying float vLane;
varying float vSpeed;
void main() { vColor = color; vAlong = along; vLane = lane; vSpeed = speed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const FIBRE_FRAG = `
varying vec3 vColor;
varying float vAlong;
varying float vLane;
varying float vSpeed;
uniform float time;
uniform float signals;
uniform float day;
void main() {
  // A signal: a short bright pulse that travels the fibre, each fibre at its own time.
  float head = fract(time * 0.22 * vSpeed + vLane);
  float pulse = smoothstep(0.09, 0.0, abs(vAlong - head)) * signals;
  if (day > 0.5) {
    float m = max(max(vColor.r, vColor.g), vColor.b);
    gl_FragColor = vec4(vColor / max(m, 0.001) * 0.85, clamp(m * 1.9 + pulse * 0.8, 0.0, 1.0));
  } else {
    gl_FragColor = vec4(vColor * (1.0 + pulse * 3.2), 1.0);
  }
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
    // The stage knows its field, so a headless check can read the camera and the labels it placed.
    host.brainField = this
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    // Given in linear light: the composer passes the clear colour through as it is, and sRGB #020309 would show as #161c35.
    this.renderer.setClearColor(new THREE.Color().setRGB(0.0006, 0.0009, 0.0028, THREE.LinearSRGBColorSpace), 1)
    this.renderer.domElement.className = 'bf-canvas'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    host.prepend(this.renderer.domElement)
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
    // Depth of field: focus on the orbit target, mild and night-only while zoomed in.
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 300, aperture: 0.02, maxblur: 0.008, width: 1, height: 1 })
    this.bokeh.enabled = false
    this.composer.addPass(this.bokeh)
    this.composer.addPass(new OutputPass())
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    this.time = { value: 0 }
    this.day = { value: 0 }
    this.inks = INKS
    this.signals = { value: this.reduced ? 0 : 1 }
    this.zoom = 0
    this.nearNote = ''
    this._easeT = 0
    this.labels = document.createElement('div')
    this.labels.className = 'bf-labels'
    host.append(this.labels)
    this.overlays = document.createElement('div')
    this.overlays.className = 'bf-overlays'
    this.overlays.style.position = 'absolute'
    this.overlays.style.inset = '0'
    this.overlays.style.pointerEvents = 'none'
    host.append(this.overlays)
    this.labelPool = []
    for (let i = 0; i < LABEL_MAX; i += 1) {
      const el = document.createElement('div')
      el.className = 'bf-node-label'
      el.append(document.createElement('span'))
      el.hidden = true
      this.overlays.append(el)
      this.labelPool.push(el)
    }
    this.excerptPlate = document.createElement('div')
    this.excerptPlate.className = 'bf-excerpt'
    this.excerptPlate.hidden = true
    this.overlays.append(this.excerptPlate)
    this.controls.autoRotate = !this.reduced
    this.controls.autoRotateSpeed = 0.45
    // A hand on the brain stops the turning for a while; it starts again on its own.
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(this._resume) })
    this.controls.addEventListener('end', () => { clearTimeout(this._resume); this._resume = setTimeout(() => { this.controls.autoRotate = !this.reduced; this.request() }, 6000) })
    document.addEventListener('visibilitychange', () => this.request())
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
    geo.setAttribute('keep', new THREE.BufferAttribute(Float32Array.from({ length: dust.length / 3 }, (_, i) => ((i * 0.6180339887) % 1)), 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0.5 }, scale: { value: 300 }, day: this.day },
      vertexShader: 'attribute vec3 tint; attribute float keep; varying vec3 vTint; varying float vKeep; uniform float scale; uniform float day; void main(){ vTint = tint; vKeep = keep; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = (1.7 + day * 1.6) * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: DUST_FRAG, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    })
    this.dust = new THREE.Points(geo, mat)
    this.scene.add(this.dust)
  }

  /**
   * Day or night, from the page's plates. Night: light on black, added up, with bloom. Day: ink on a pale window,
   * laid over, no bloom, so it reads like the rest of the page.
   */
  setTheme(night) {
    const day = !night
    if (this.day.value === (day ? 1 : 0) && this._themed) return
    this._themed = true
    this.day.value = day ? 1 : 0
    this.inks = day ? DAY_INKS : INKS
    const ground = new THREE.Color(day ? DAY_VOID : '#020309')
    this.scene.background = ground
    this.scene.fog.color = ground
    this.bloom.enabled = !day
    const blend = day ? THREE.NormalBlending : THREE.AdditiveBlending
    for (const m of [this.dust.material, this.nodes?.material, this.linkLines?.material, this.replacedLines?.material]) if (m) { m.blending = blend; m.needsUpdate = true }
    for (const el of this.labels.children) el.style.setProperty('--ink', this.inks[this.slot?.get(el.dataset.area) ?? 0])
    this.paint()
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
    this.bokeh && this.bokeh.setSize(w, h)
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
    this.byId = new Map(notes.map((n) => [n.id, n]))
    const pos = new Float32Array(notes.length * 3)
    notes.forEach((n, i) => { const p = this.at.get(n.id); pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(notes.length * 3), 3))
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    geo.setAttribute('ring', new THREE.BufferAttribute(new Float32Array(notes.length), 1))
    geo.setAttribute('phase', new THREE.BufferAttribute(Float32Array.from(notes, (n) => (n.id.length * 0.137 + n.date.charCodeAt(9) * 0.071) % 1), 1))
    this.nodes = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 }, time: this.time, day: this.day, nodeZoom: { value: 0 } }, vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
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
    this.labels.innerHTML = brain.areas.map((a) => `<button type="button" class="bf-label" data-area="${a.id}" title="${DESCRIBE.brain.area}" style="--ink:${this.inks[this.slot.get(a.id)]}">${a.name.replace(/[<>&]/g, '')}<span>${a.count}</span></button>`).join('')
    if (this.day.value) { this._themed = false; this.setTheme(false) } else this.paint()
    if (!this._glided) this._glide()
  }

  _lines(pairs, segments, dashed = false) {
    const pts = []
    const along = []
    const lane = []
    this._steps = 18
    pairs.forEach(([a, b], k) => {
      const curve = fibre(this.at.get(a), this.at.get(b), this._steps)
      const offset = (k * 0.618034) % 1
      for (let i = 0; i < curve.length - 1; i += 1) { pts.push(curve[i], curve[i + 1]); along.push(i / this._steps, (i + 1) / this._steps); lane.push(offset, offset) }
    })
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3))
    geo.setAttribute('along', new THREE.BufferAttribute(Float32Array.from(along), 1))
    geo.setAttribute('lane', new THREE.BufferAttribute(Float32Array.from(lane), 1))
    geo.setAttribute('speed', new THREE.BufferAttribute(new Float32Array(pts.length).fill(1), 1))
    const mat = dashed
      ? new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 5, gapSize: 4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      : new THREE.ShaderMaterial({ uniforms: { time: this.time, signals: this.signals, day: this.day }, vertexShader: FIBRE_VERT, fragmentShader: FIBRE_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const line = new THREE.LineSegments(geo, mat)
    if (dashed) line.computeLineDistances()
    void segments
    return line
  }

  /**
   * Colour, size and brightness from the state: `dim(id)` says a note is out of the search, the scrub or the
   * chosen area; `chosen` and `near` light one note and its neighbours. `zoom` and `nearNote` come from the
   * frame loop while the camera is close; they are merged in so a repaint from the map never clears them.
   */
  paint(state = this.state) {
    this.state = { ...this.state, ...state }
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
      c.set(this.inks[this.slot.get(n.area) ?? 0])
      if (old) c.copy(ASH)
      if (fresh) c.lerp(this.day.value ? AMBER : WHITE, 0.3)
      const base = (n.kind === 'decision' ? 21 : n.kind === 'preference' ? 16 : 12) + (n.pinned ? 6 : 0) + Math.min(6, n.links.length * 1.5) + (fresh ? 6 : 0)
      let g = old ? 0.5 : n.kind === 'decision' ? 1.1 : 0.9
      if (fresh) g = 1.45
      const out = this.state.dim(n.id) || (this.state.near && !this.state.near.has(n.id))
      if (out) g *= 0.12
      if (n.id === this.state.chosen) g = Math.max(g, 1.8)
      this.light.set(n.id, out ? 0.12 : 1)
      col.setXYZ(i, c.r, c.g, c.b)
      size.setX(i, (n.id === this.state.chosen ? base * 1.6 : base) * (old ? 0.75 : 1))
      glow.setX(i, g)
      ring.setX(i, n.imported ? 1 : 0)
    })
    col.needsUpdate = size.needsUpdate = glow.needsUpdate = ring.needsUpdate = true
    this._paintLines(this.linkLines, this.links, 0.7)
    this._paintLines(this.replacedLines, this.replaced, 0.75, true)
    for (const el of this.labels.children) el.classList.toggle('dim', Boolean(this.state.area) && el.dataset.area !== this.state.area)
    this.request()
  }

  _paintLines(line, pairs, strength, ash = false) {
    const col = line.geometry.attributes.color
    const speed = line.geometry.attributes.speed
    const per = this._steps * 2
    const a = new THREE.Color()
    const b = new THREE.Color()
    const byId = new Map(this.brain.notes.map((n) => [n.id, n]))
    const near = this.state.nearNote
    const isLinks = line === this.linkLines
    pairs.forEach(([from, to], k) => {
      a.set(this.inks[this.slot.get(byId.get(from)?.area) ?? 0])
      b.set(this.inks[this.slot.get(byId.get(to)?.area) ?? 0])
      if (ash) { a.copy(ASH); b.set('#c9d2e0') }
      const touched = this.state.chosen && (from === this.state.chosen || to === this.state.chosen)
      const nearTouch = isLinks && near && (from === near || to === near)
      const s = strength * Math.min(this.light.get(from), this.light.get(to)) * (this.state.chosen ? (touched ? 2.4 : 0.25) : 1) * (nearTouch ? NEAR_BRIGHT : 1)
      for (let i = 0; i < per; i += 1) {
        const t = Math.floor(i / 2 + (i % 2)) / this._steps
        // Brightest in the middle of the fibre: it reads as light travelling, not a wire.
        const lift = s * (0.55 + Math.sin(t * Math.PI) * 0.6)
        col.setXYZ(k * per + i, (a.r + (b.r - a.r) * t) * lift, (a.g + (b.g - a.g) * t) * lift, (a.b + (b.b - a.b) * t) * lift)
        if (isLinks) speed.setX(k * per + i, nearTouch ? NEAR_SPEED : 1)
      }
    })
    col.needsUpdate = true
    if (isLinks) speed.needsUpdate = true
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

  /** Alive: open, in a visible tab, with motion allowed. Asleep otherwise: not one frame is drawn. */
  alive() {
    return this.on && !document.hidden && !this.reduced
  }

  _zoom(dist) { return zoomFactor(dist) }

  /** The nearest note, preferring one in view: its excerpt is shown and its links brighten. */
  _nearestNote() {
    if (!this.at || !this.order) return ''
    this.camera.updateMatrixWorld()
    this._frustum ||= new THREE.Frustum()
    this._frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse))
    return nearestNote(this.at, this.order, this.camera.position, this.light, (id) => this._frustum.containsPoint(this.at.get(id)))
  }

  /** While the camera is close and idle, ease the orbit target into the nearest lobe with an exponential ease-out. */
  _easeTarget(now) {
    if (!this._easeT) this._easeT = now
    const dt = Math.min(0.05, (now - this._easeT) / 1000)
    this._easeT = now
    let nearest = null
    let bestD = Infinity
    const target = this.controls.target
    for (const c of this.centres.values()) {
      const d = target.distanceTo(c)
      if (d < bestD) { bestD = d; nearest = c }
    }
    if (!nearest) return
    const k = 1 - Math.exp(-3 * dt)
    target.lerpVectors(target, nearest, k)
  }

  /** One frame now, and more while the camera moves or the brain is alive. */
  request() {
    if (this._frame || !this.on) return
    this._frame = requestAnimationFrame((now) => {
      this._frame = 0
      const tweening = this._moving ? this._moving(now) : false
      const live = this.alive()
      if (live) this.time.value = now / 1000
      const damping = this.controls.update()
      const dist = this.camera.position.distanceTo(this.controls.target)
      this.dist = dist
      this.zoom = this._zoom(dist)
      const nearNote = this._nearestNote()
      if (nearNote !== this.nearNote) this.nearNote = nearNote
      this.paint({ zoom: this.zoom, nearNote: this.nearNote })
      if (live && dist < ZOOM_IN && this.controls.state === -1 && this.centres) this._easeTarget(now)
      if (this.bokeh) {
        this.bokeh.enabled = !this.day.value && this.zoom > 0.25
        this.bokeh.uniforms.focus.value = dist
      }
      this.nodes && (this.nodes.material.uniforms.nodeZoom.value = this.zoom)
      this.composer.render()
      this._place()
      this._placeNodes()
      if (tweening || damping || live) this.request()
    })
  }

  /** Area names float over their lobes, smaller the further away. */
  _place() {
    if (!this.centres) return
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    const v = new THREE.Vector3()
    const placed = []
    this._areaBoxes = []
    for (const el of this.labels.children) {
      const c = this.centres.get(el.dataset.area)
      if (!c) continue
      v.set(c.x, c.y + 46, c.z).project(this.camera)
      const behind = v.z > 1
      // A label that would cover another steps down below it.
      const half = (el.offsetWidth || 80) / 2
      const hh = (el.offsetHeight || 28) / 2
      // Kept inside the stage, as the neuron titles are: a name cut off at the edge reads as a fault.
      const x = Math.min(Math.max(half + 6, ((v.x + 1) / 2) * w), Math.max(half + 6, w - half - 6))
      let y = Math.min(Math.max(hh + 6, ((1 - v.y) / 2) * h), Math.max(hh + 6, h - hh - 6))
      for (let tries = 0; tries < 6; tries += 1) {
        const hit = placed.find((p) => Math.abs(p.x - x) < p.half + half + 4 && Math.abs(p.y - y) < 24)
        if (!hit) break
        y = hit.y + 26
      }
      if (!behind) {
        placed.push({ x, y, half })
        // The neuron titles keep clear of the area names.
        this._areaBoxes.push({ left: x - half, right: x + half, top: y - hh, bottom: y + hh })
      }
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
      el.style.opacity = behind ? '0' : '1'
    }
  }

  /** Hide the pooled node labels and the excerpt plate. */
  _dropLabels() {
    for (const el of this.labelPool) el.hidden = true
    this.excerptPlate.hidden = true
  }

  /** Where a neuron is on the stage: its pixel, whether that is on the stage, and if not, its place on the edge. */
  _onStage(p, w, h) {
    const cam = this.camera
    const v = this._v.copy(p).applyMatrix4(cam.matrixWorldInverse)
    const P = cam.projectionMatrix.elements
    if (v.z < -cam.near) {
      const x = ((P[0] * v.x) / -v.z + 1) / 2 * w
      const y = (1 - (P[5] * v.y) / -v.z) / 2 * h
      if (x >= 0 && x <= w && y >= 0 && y <= h) return { x, y, inFrame: true, turn: 0 }
    }
    // Off the stage, or behind the camera: the way to it from the middle of the stage.
    const dx = P[0] * v.x * w / 2
    const dy = -P[5] * v.y * h / 2
    const e = edgePoint(dx, dy, w, h, 12)
    return { x: e.x, y: e.y, inFrame: false, turn: Math.round(Math.atan2(dy, dx) * 180 / Math.PI) }
  }

  /** How wide a title's text is, in the plate's own font. */
  _textWidth(text) {
    this._widths ||= new Map()
    let wd = this._widths.get(text)
    if (wd === undefined) {
      this._ctx ||= document.createElement('canvas').getContext('2d')
      const cs = getComputedStyle(this.labelPool[0])
      this._ctx.font = cs.font || '700 11px sans-serif'
      this._ctx.letterSpacing = cs.letterSpacing || '0px'
      wd = Math.ceil(this._ctx.measureText(text).width)
      this._widths.set(text, wd)
    }
    return wd
  }

  /** The nearest neuron's excerpt in a small plate beside it, kept inside the stage. Gives the plate's box. */
  _placeExcerpt(w, h) {
    const e = this.excerptPlate
    const near = this.nearNote
    const n = near && this.byId.get(near)
    const p = near && this.at?.get(near)
    if (!n || !p) { e.hidden = true; return null }
    if (e.dataset.note !== near) { e.textContent = n.excerpt || n.title; e.dataset.note = near }
    e.style.setProperty('--ink', this.inks[(this.slot?.get(n.area) ?? 0) % this.inks.length])
    e.hidden = false
    const at = this._onStage(p, w, h)
    const box = placeExcerpt(at.x, at.y, e.offsetWidth, e.offsetHeight, w, h)
    e.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`
    return box
  }

  /**
   * Pooled title plates for the nearest neurons on the stage, nearest first, at most LABEL_MAX, none overlapping and
   * all inside the stage; when fewer than LABEL_LEAST neurons are in view, the nearest ones out of it make up the
   * count on the stage's edge, with an arrow the way they lie.
   */
  _placeNodes() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h || this.zoom <= 0 || !this.order) { this._dropLabels(); return }
    this.camera.updateMatrixWorld()
    this._v ||= new THREE.Vector3()
    const avoid = [...(this._areaBoxes || [])]
    const excerpt = this._placeExcerpt(w, h)
    if (excerpt) avoid.push(excerpt)
    const cands = []
    for (const id of this.order) {
      const light = this.light?.get(id) ?? 1
      if (light <= 0.5) continue
      const p = this.at.get(id)
      const n = this.byId.get(id)
      if (!p || !n) continue
      const at = this._onStage(p, w, h)
      const pw = Math.min(PLATE_MAX, w - 12, this._textWidth(n.title) + PLATE_EXTRA + (at.inFrame ? 0 : PLATE_EDGE))
      cands.push({ id, ...at, light, d: p.distanceTo(this.camera.position), w: pw, h: PLATE_H })
    }
    const shown = titlesAt(this.dist ?? Infinity, cands, { w, h, max: LABEL_MAX, least: LABEL_LEAST, avoid })
    if (!shown.length) { this._dropLabels(); return }
    for (let i = 0; i < LABEL_MAX; i += 1) {
      const el = this.labelPool[i]
      const s = shown[i]
      if (!s) { el.hidden = true; continue }
      const n = this.byId.get(s.id)
      if (el.dataset.note !== s.id) { el.firstChild.textContent = n.title; el.dataset.note = s.id }
      el.classList.toggle('edge', !s.inFrame)
      el.style.setProperty('--ink', this.inks[(this.slot?.get(n.area) ?? 0) % this.inks.length])
      el.style.setProperty('--turn', `${s.turn}deg`)
      el.style.width = `${s.w}px`
      el.style.transform = `translate(${Math.round(s.box.left)}px, ${Math.round(s.box.top)}px)`
      el.hidden = false
    }
  }

  /** Which note is under the pointer, if any. */
  _hit(e) {
    if (!this.nodes) return ''
    const r = this.renderer.domElement.getBoundingClientRect()
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.ray.setFromCamera(this.mouse, this.camera)
    this.ray.params.Points.threshold = 7 * Math.max(0.5, this.camera.position.distanceTo(this.controls.target) / 520)
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
