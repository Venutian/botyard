import * as THREE from 'three'

/**
 * Where the yard is looked at from: a point on the ground, how far back, how high and from which
 * side. A hand on the picture moves it (drag to slide the ground, wheel or pinch to come closer,
 * right-drag or two fingers turning to look from another side); `frame` puts a set of points in
 * the free part of the window. It glides to where it was sent and then stands still.
 */

const NEAR = 14
const FAR = 260
/** Looked at from well above, like a plan: the angle between the line of sight and straight down. */
const LEAN = THREE.MathUtils.degToRad(38)
const LEAN_MIN = THREE.MathUtils.degToRad(8)
const LEAN_MAX = THREE.MathUtils.degToRad(72)
const SIDE = Math.PI / 4
const EASE = 9

const clamp = THREE.MathUtils.clamp

/**
 * How far back the eye must be for every point to fall inside the free part of the picture.
 * Plain numbers in, a distance out, so it is tested without a browser.
 *
 * @param {{x:number,y?:number,z:number}[]} points on or above the ground
 * @param {{x:number,z:number}} aim the ground point looked at
 * @param {{side:number, lean:number, fov:number, w:number, h:number, left?:number, right?:number, top?:number, bottom?:number}} how
 *   the angles in radians, the vertical field of view in degrees, the picture in pixels and how much of each edge is covered
 */
export function distanceToFit(points, aim, how) {
  const { side, lean, fov, w, h, left = 0, right = 0, top = 0, bottom = 0 } = how
  const tan = Math.tan(THREE.MathUtils.degToRad(fov) / 2)
  // The eye's own axes: across the picture, up the picture, and along the line of sight.
  const across = { x: Math.cos(side), z: -Math.sin(side) }
  const sight = { x: -Math.sin(side) * Math.sin(lean), y: -Math.cos(lean), z: -Math.cos(side) * Math.sin(lean) }
  const up = { x: -Math.sin(side) * Math.cos(lean), y: Math.sin(lean), z: -Math.cos(side) * Math.cos(lean) }
  // The free part's edges as shares of the half picture, measured from its middle.
  const xLo = -1 + (2 * left) / w, xHi = 1 - (2 * right) / w
  const yLo = -1 + (2 * bottom) / h, yHi = 1 - (2 * top) / h
  // The picture's middle shows the aim; the free part's middle is off it by (cx, cy).
  const cx = (xLo + xHi) / 2, cy = (yLo + yHi) / 2
  const halfX = (xHi - xLo) / 2, halfY = (yHi - yLo) / 2
  const aspect = w / h
  let need = NEAR
  for (const p of points) {
    const dx = p.x - aim.x, dy = p.y || 0, dz = p.z - aim.z
    const a = dx * across.x + dz * across.z
    const u = dx * up.x + dy * up.y + dz * up.z
    const s = dx * sight.x + dy * sight.y + dz * sight.z
    // At distance d the point shows at (a / ((d + s) * tan * aspect), u / ((d + s) * tan)), and the
    // aim itself is drawn at the free part's middle, so the point may stray (halfX, halfY) from it.
    need = Math.max(need, Math.abs(a) / (tan * aspect * halfX) - s, Math.abs(u) / (tan * halfY) - s)
  }
  return clamp(need, NEAR, FAR)
}

export class View {
  /**
   * @param {import('./stage.js').Stage} stage
   */
  constructor(stage) {
    this.stage = stage
    this.aim = new THREE.Vector3()
    this.back = 80
    this.side = SIDE
    this.lean = LEAN
    this.want = { aim: new THREE.Vector3(), back: 80, side: SIDE, lean: LEAN }
    /** How much of each edge of the picture is covered by panels, in pixels. */
    this.covered = { left: 0, right: 0, top: 0, bottom: 0 }
    this.home = null
    this._ray = new THREE.Raycaster()
    this._ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    this._hand = null
    this.moved = 0
    stage.steps.add((dt) => this._step(dt))
    stage.onResize(() => this._offset())
    stage.onCanvas((canvas) => this._listen(canvas))
    this._listen(stage.canvas)
    this._place()
  }

  // ── where it is sent ────────────────────────────────────────────────────────────

  /** Panels cover this much of each edge: the yard is centred in what is left. */
  cover(covered) {
    Object.assign(this.covered, covered)
    this._offset()
    this.stage.redraw()
  }

  /** Put all of these points in the free part of the picture, and remember it as "the whole yard". */
  frame(points, { glide = true } = {}) {
    if (!points.length) return
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const p of points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z) }
    this.home = { points, aim: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 } }
    this.whole({ glide })
  }

  /** Back to the whole yard, seen from the usual side. */
  whole({ glide = true } = {}) {
    if (!this.home) return
    const { w, h } = this.stage.size
    this.want.side = SIDE
    this.want.lean = LEAN
    this.want.aim.set(this.home.aim.x, 0, this.home.aim.z)
    // Signs stand over the bays, so the top is given room beyond what the points ask.
    this.want.back = distanceToFit(this.home.points, this.home.aim, { side: SIDE, lean: LEAN, fov: this.stage.camera.fov, w, h, left: this.covered.left + 24, right: this.covered.right + 24, top: this.covered.top + 76, bottom: this.covered.bottom + 28 })
    if (!glide) this._arrive()
    this.stage.redraw()
  }

  /** Look at one place from as close as `back`. */
  go(point, back = 34) {
    this.want.aim.set(point.x, 0, point.z)
    this.want.back = clamp(Math.min(this.want.back, back), NEAR, FAR)
    this.stage.redraw()
  }

  _arrive() {
    this.aim.copy(this.want.aim)
    this.back = this.want.back
    this.side = this.want.side
    this.lean = this.want.lean
    this._place()
  }

  // ── each drawing ────────────────────────────────────────────────────────────────

  _step(dt) {
    const k = 1 - Math.exp(-EASE * dt)
    const gap = this.aim.distanceTo(this.want.aim) + Math.abs(this.back - this.want.back) * 0.5 + Math.abs(this.side - this.want.side) * 20 + Math.abs(this.lean - this.want.lean) * 20
    if (gap < 0.01) {
      if (gap > 0) this._arrive()
      return false
    }
    // Someone who asked for less motion is taken straight there.
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) { this._arrive(); return false }
    this.aim.lerp(this.want.aim, k)
    this.back += (this.want.back - this.back) * k
    this.side += (this.want.side - this.side) * k
    this.lean += (this.want.lean - this.lean) * k
    this._place()
    return true
  }

  _place() {
    const camera = this.stage.camera
    const flat = Math.sin(this.lean) * this.back
    camera.position.set(this.aim.x + Math.sin(this.side) * flat, Math.cos(this.lean) * this.back, this.aim.z + Math.cos(this.side) * flat)
    camera.lookAt(this.aim)
    camera.updateMatrixWorld()
  }

  /** The aim is drawn in the middle of the free part of the picture, not of the whole of it. */
  _offset() {
    const { w, h } = this.stage.size
    const c = this.covered
    const camera = this.stage.camera
    if (c.left || c.right || c.top || c.bottom) camera.setViewOffset(w, h, (c.right - c.left) / 2, (c.bottom - c.top) / 2, w, h)
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
  }

  // ── a hand on the picture ───────────────────────────────────────────────────────

  /** The ground point under a place on the page, or null where the sky is. */
  groundUnder(clientX, clientY, out = new THREE.Vector3()) {
    const box = this.stage.canvas.getBoundingClientRect()
    this._ray.setFromCamera({ x: ((clientX - box.left) / box.width) * 2 - 1, y: -((clientY - box.top) / box.height) * 2 + 1 }, this.stage.camera)
    return this._ray.ray.intersectPlane(this._ground, out)
  }

  /** A ray from the eye through a place on the page, for telling what is under the pointer. */
  rayUnder(clientX, clientY) {
    const box = this.stage.canvas.getBoundingClientRect()
    this._ray.setFromCamera({ x: ((clientX - box.left) / box.width) * 2 - 1, y: -((clientY - box.top) / box.height) * 2 + 1 }, this.stage.camera)
    return this._ray
  }

  _listen(canvas) {
    const fingers = new Map()
    const spread = () => { const [a, b] = [...fingers.values()]; return { far: Math.hypot(a.x - b.x, a.y - b.y), turn: Math.atan2(b.y - a.y, b.x - a.x) } }
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      this.moved = 0
      const turning = e.button === 2 || e.ctrlKey || e.shiftKey
      this._hand = fingers.size === 2 ? { kind: 'two', ...spread(), back: this.want.back, side: this.want.side }
        : { kind: turning ? 'turn' : 'slide', x: e.clientX, y: e.clientY, grip: turning ? null : this.groundUnder(e.clientX, e.clientY) }
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!fingers.has(e.pointerId) || !this._hand) return
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const hand = this._hand
      if (hand.kind === 'two' && fingers.size === 2) {
        const now = spread()
        this.want.back = clamp(hand.back * (hand.far / Math.max(20, now.far)), NEAR, FAR)
        this.want.side = hand.side - (now.turn - hand.turn)
        this.moved = 99
      } else if (hand.kind === 'turn') {
        this.want.side -= (e.clientX - hand.x) * 0.006
        this.want.lean = clamp(this.want.lean - (e.clientY - hand.y) * 0.005, LEAN_MIN, LEAN_MAX)
        this.moved += Math.abs(e.clientX - hand.x) + Math.abs(e.clientY - hand.y)
        hand.x = e.clientX; hand.y = e.clientY
      } else if (hand.kind === 'slide' && hand.grip) {
        this.moved += Math.abs(e.clientX - hand.x) + Math.abs(e.clientY - hand.y)
        hand.x = e.clientX; hand.y = e.clientY
        // The ground point that was taken hold of stays under the pointer.
        const under = this.groundUnder(e.clientX, e.clientY)
        if (under) {
          this.want.aim.x += hand.grip.x - under.x
          this.want.aim.z += hand.grip.z - under.z
          this.aim.copy(this.want.aim)
          this._place()
        }
      }
      this.stage.redraw()
    })
    const let_go = (e) => {
      fingers.delete(e.pointerId)
      this._hand = null
    }
    canvas.addEventListener('pointerup', let_go)
    canvas.addEventListener('pointercancel', let_go)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const before = this.groundUnder(e.clientX, e.clientY)
      const to = clamp(this.want.back * Math.exp(e.deltaY * 0.0012), NEAR, FAR)
      // Coming closer keeps what is under the pointer under it.
      if (before) {
        const share = 1 - to / this.want.back
        this.want.aim.x += (before.x - this.want.aim.x) * share
        this.want.aim.z += (before.z - this.want.aim.z) * share
      }
      this.want.back = to
      this.stage.redraw()
    }, { passive: false })
  }

  /** Slide the ground by keys: `across` to the right, `away` up the picture, in shares of what is seen. */
  nudge(across, away) {
    const step = this.want.back * 0.12
    this.want.aim.x += (Math.cos(this.want.side) * across - Math.sin(this.want.side) * away) * step
    this.want.aim.z += (-Math.sin(this.want.side) * across - Math.cos(this.want.side) * away) * step
    this.stage.redraw()
  }

  /** Come closer (below 1) or go back (above 1). */
  zoom(by) {
    this.want.back = clamp(this.want.back * by, NEAR, FAR)
    this.stage.redraw()
  }
}
