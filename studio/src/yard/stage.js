import * as THREE from 'three'
import { QUALITIES } from './settings.js'

/**
 * The picture: one canvas, one scene, one camera, drawn only when something asks.
 *
 * The yard stands still, so there is no loop. Whoever changes what is seen calls `redraw()`;
 * the next animation frame draws once. A helper that is still moving something (the camera
 * gliding to a bay) says so from its `step` and gets the frame after that too. After each
 * drawing the `drawn` listeners place whatever sits over the picture (signs, names).
 */
export class Stage {
  /**
   * @param {HTMLElement} holder the element the canvas fills
   * @param {import('./settings.js').MapSettings} settings
   */
  constructor(holder, settings) {
    this.holder = holder
    this.settings = settings
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 900)
    this.size = { w: 1, h: 1 }
    this.steps = new Set()
    this.drawn = new Set()
    this.frames = 0
    this._asked = false
    this._last = 0
    this._make()
    // A soft shade round the picture's edge, drawn by the page once: it holds the eye on the yard.
    if (typeof document !== 'undefined') {
      this.veil = document.createElement('div')
      this.veil.className = 'yard-veil'
      this.canvas.after(this.veil)
    }
    this._watch = new ResizeObserver(() => this._fit())
    this._watch.observe(holder)
    this._fit()
    settings.watch((name) => { if (name === 'quality') this._make() })
  }

  /** The renderer is made again when the picture quality changes: smoothing is fixed at its birth. */
  _make() {
    const quality = QUALITIES[this.settings.get('quality')]
    const old = this.renderer
    const canvas = document.createElement('canvas')
    canvas.className = 'yard-canvas'
    canvas.setAttribute('aria-label', 'The yard: a bay for each project and the crew at work')
    canvas.tabIndex = 0
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.smooth, powerPreference: 'high-performance' })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.shadowMap.enabled = quality.shadows > 0
    renderer.shadowMap.type = THREE.PCFShadowMap
    // The sun's shadows fall on things that stand still, so they are drawn once and kept: only a
    // change in the yard (`reshade`) draws them again, never a turn of the camera.
    renderer.shadowMap.autoUpdate = false
    renderer.shadowMap.needsUpdate = true
    this.renderer = renderer
    this.canvas = canvas
    this.quality = quality
    if (old) {
      old.domElement.replaceWith(canvas)
      old.dispose()
      for (const remade of this.remade || []) remade(canvas)
    } else this.holder.prepend(canvas)
    this._fit()
  }

  /** Called with the new canvas whenever it is replaced, so input can move to it. */
  onCanvas(remade) {
    (this.remade ||= []).push(remade)
  }

  _fit() {
    if (!this.renderer) return
    const w = Math.max(1, this.holder.clientWidth)
    const h = Math.max(1, this.holder.clientHeight)
    this.size = { w, h }
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, this.quality.pixels))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    for (const resized of this.resized || []) resized(this.size)
    this.redraw()
  }

  /** Called with `{ w, h }` after the picture's size changed. */
  onResize(resized) {
    (this.resized ||= []).push(resized)
  }

  /** The edge shade for the hour: light and warm by day, deeper by night. */
  grade(hour) {
    if (this.veil) this.veil.dataset.hour = hour
  }

  /** Something in the yard was built, moved or relit: its shadows are drawn again with the next picture. */
  reshade() {
    this.renderer.shadowMap.needsUpdate = true
    this.redraw()
  }

  /** Ask for one drawing. Any number of asks before the next frame make one drawing. */
  redraw() {
    if (this._asked) return
    this._asked = true
    requestAnimationFrame((now) => {
      this._asked = false
      const dt = Math.min(0.05, this._last ? (now - this._last) / 1000 : 0.016)
      this._last = now
      let moving = false
      for (const step of this.steps) moving = step(dt) || moving
      this.renderer.render(this.scene, this.camera)
      this.frames++
      for (const after of this.drawn) after()
      if (moving) this.redraw()
      else this._last = 0
    })
  }

  /** A world point as page pixels inside the picture, or null when it is behind the viewer. */
  toPage(point, out = {}) {
    const v = this._v || (this._v = new THREE.Vector3())
    v.set(point.x, point.y ?? 0, point.z).project(this.camera)
    if (v.z > 1 || v.z < -1) return null
    out.x = (v.x * 0.5 + 0.5) * this.size.w
    out.y = (-v.y * 0.5 + 0.5) * this.size.h
    return out
  }

  /** The picture as a PNG, drawn afresh so the buffer is still there to read. */
  picture() {
    this.renderer.render(this.scene, this.camera)
    return this.canvas.toDataURL('image/png')
  }
}
