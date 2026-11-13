import * as THREE from 'three'

/**
 * Sheet metal by the piece. A robot (and everything else in the yard) is put together from flat
 * painted boxes, plates that taper, rods and the odd cone; a Kit collects the pieces, each in its
 * own paint, and welds them into one mesh. Pieces are placed through a stack of joints, so a pose
 * is just the angles of the joints the pieces were hung from.
 */
export class Kit {
  constructor() {
    this.pieces = []
    this.joint = new THREE.Matrix4()
    this._stack = []
  }

  /** Hang what `make` adds from a joint at `at`, turned by `turn` (x, y, z in radians). */
  from(at, turn, make) {
    this._stack.push(this.joint.clone())
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(turn[0] || 0, turn[1] || 0, turn[2] || 0, 'YXZ'))
    m.setPosition(at[0], at[1], at[2])
    this.joint.multiply(m)
    make()
    this.joint.copy(this._stack.pop())
    return this
  }

  _add(geometry, paint, at, turn) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    if (flat !== geometry) geometry.dispose()
    flat.deleteAttribute('uv')
    if (turn) flat.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(turn[0] || 0, turn[1] || 0, turn[2] || 0, 'YXZ')))
    flat.translate(at[0], at[1], at[2])
    flat.applyMatrix4(this.joint)
    const colour = new THREE.Color(paint)
    const count = flat.attributes.position.count
    const colours = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) colour.toArray(colours, i * 3)
    flat.setAttribute('color', new THREE.BufferAttribute(colours, 3))
    this.pieces.push(flat)
    return this
  }

  /** A box `w` wide, `h` high, `d` deep, its middle at `at`. */
  box(w, h, d, paint, at, turn) {
    return this._add(new THREE.BoxGeometry(w, h, d), paint, at, turn)
  }

  /** A plate that tapers: `w0` wide at the foot, `w1` at the top, standing on `at`. */
  slab(w0, w1, h, d, paint, at, turn) {
    const g = new THREE.BoxGeometry(1, h, d)
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * (p.getY(i) > 0 ? w1 : w0))
    g.translate(0, h / 2, 0)
    g.computeVertexNormals()
    return this._add(g, paint, at, turn)
  }

  /** An upright rod or drum: `r0` at the foot, `r1` at the top, its middle at `at`. */
  rod(r0, r1, h, paint, at, turn, sides = 10) {
    return this._add(new THREE.CylinderGeometry(r1, r0, h, sides), paint, at, turn)
  }

  /** A ring lying flat: `r` to the middle of its tube, `tube` thick. */
  ring(r, tube, paint, at, turn) {
    const g = new THREE.TorusGeometry(r, tube, 6, 14)
    g.rotateX(Math.PI / 2)
    return this._add(g, paint, at, turn)
  }

  /** A half ball, flat side down. */
  dome(r, paint, at, turn) {
    return this._add(new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), paint, at, turn)
  }

  /** A point in the current joint's frame as a point of the finished mesh. */
  point(x, y, z) {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.joint)
  }

  get empty() { return this.pieces.length === 0 }

  /** Weld the pieces into one geometry; the pieces are spent. */
  weld() {
    let total = 0
    for (const piece of this.pieces) total += piece.attributes.position.count
    const position = new Float32Array(total * 3)
    const normal = new Float32Array(total * 3)
    const color = new Float32Array(total * 3)
    let at = 0
    for (const piece of this.pieces) {
      position.set(piece.attributes.position.array, at)
      normal.set(piece.attributes.normal.array, at)
      color.set(piece.attributes.color.array, at)
      at += piece.attributes.position.count * 3
      piece.dispose()
    }
    this.pieces = []
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.BufferAttribute(position, 3))
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
    out.setAttribute('color', new THREE.BufferAttribute(color, 3))
    out.computeBoundingSphere()
    out.computeBoundingBox()
    return out
  }
}

/** Painted sheet metal: flat colour that takes the light, no shine. One for the whole yard. */
let paintwork = null
export const painted = () => (paintwork ||= new THREE.MeshLambertMaterial({ vertexColors: true }))

/** What gives light of its own (lamps, eyes): drawn at its own colour whatever the hour. One for the whole yard. */
let glow = null
export const lit = () => (glow ||= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }))
