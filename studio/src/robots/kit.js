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

  _add(geometry, paint, at, turn, edges = 'box') {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    if (flat !== geometry) geometry.dispose()
    const count = flat.attributes.position.count
    // Where each point lies on its face, 0 to 1 across: the paint is worn a little lighter at a
    // face's edges. A box's faces each run 0 to 1; a rod's side runs 0 to 1 from foot to top (its
    // rims), its caps and anything round have no edge (a half everywhere).
    const edge = new Uint8Array(count * 2).fill(128)
    const uv = flat.attributes.uv
    const normal = flat.attributes.normal
    if (uv && edges !== 'none') {
      for (let i = 0; i < count; i++) {
        if (edges === 'box') { edge[i * 2] = uv.getX(i) * 255; edge[i * 2 + 1] = uv.getY(i) * 255 }
        else if (Math.abs(normal.getY(i)) < 0.9) edge[i * 2 + 1] = uv.getY(i) * 255
      }
    }
    flat.deleteAttribute('uv')
    flat.setAttribute('edge', new THREE.BufferAttribute(edge, 2, true))
    if (turn) flat.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(turn[0] || 0, turn[1] || 0, turn[2] || 0, 'YXZ')))
    flat.translate(at[0], at[1], at[2])
    flat.applyMatrix4(this.joint)
    const colour = new THREE.Color(paint)
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
    return this._add(new THREE.CylinderGeometry(r1, r0, h, sides), paint, at, turn, 'rod')
  }

  /** A ring lying flat: `r` to the middle of its tube, `tube` thick. */
  ring(r, tube, paint, at, turn) {
    const g = new THREE.TorusGeometry(r, tube, 6, 14)
    g.rotateX(Math.PI / 2)
    return this._add(g, paint, at, turn, 'none')
  }

  /** A half ball, flat side down. */
  dome(r, paint, at, turn) {
    return this._add(new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), paint, at, turn, 'none')
  }

  /** A point in the current joint's frame as a point of the finished mesh. */
  point(x, y, z) {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.joint)
  }

  get empty() { return this.pieces.length === 0 }

  /**
   * Weld the pieces into one geometry; the pieces are spent. What the card keeps is packed small:
   * a face's direction in bytes, its paint in 16-bit steps and its edge place in bytes, so the
   * whole yard's sheet metal takes about two thirds of the memory plain floats would.
   */
  weld() {
    let total = 0
    for (const piece of this.pieces) total += piece.attributes.position.count
    const position = new Float32Array(total * 3)
    const normal = new Int8Array(total * 3)
    const color = new Uint16Array(total * 3)
    const edge = new Uint8Array(total * 2)
    let at = 0
    for (const piece of this.pieces) {
      const n = piece.attributes.normal.array
      const c = piece.attributes.color.array
      position.set(piece.attributes.position.array, at * 3)
      for (let i = 0; i < n.length; i++) {
        normal[at * 3 + i] = Math.round(Math.max(-1, Math.min(1, n[i])) * 127)
        color[at * 3 + i] = Math.round(Math.max(0, Math.min(1, c[i])) * 65535)
      }
      edge.set(piece.attributes.edge.array, at * 2)
      at += piece.attributes.position.count
      piece.dispose()
    }
    this.pieces = []
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.BufferAttribute(position, 3))
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true))
    out.setAttribute('color', new THREE.BufferAttribute(color, 3, true))
    out.setAttribute('edge', new THREE.BufferAttribute(edge, 2, true))
    out.computeBoundingSphere()
    out.computeBoundingBox()
    return out
  }
}

/**
 * How the paint is drawn, the same for the whole yard, set by the hour: how far the sky's light
 * wraps round an edge seen side-on, and how much the paint is worn at the edges and in patches.
 */
export const PAINT = {
  uRim: { value: new THREE.Color('#9fb6d8') },
  uWear: { value: 1 },
  uSpeckle: { value: null },
}

let speckle = null
/**
 * Wear and stains, drawn once: a small square of soft noise that tiles without a seam, in three
 * sizes, one to a channel (red broad, green middling, blue fine). The paint and the asphalt each
 * read it once a pixel, which costs far less than working noise out for every pixel.
 */
export function wearTexture() {
  if (speckle || typeof document === 'undefined') return speckle
  const n = 256
  const data = new Uint8Array(n * n * 4)
  let seed = 11
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647)
  const smooth = (t) => t * t * (3 - 2 * t)
  for (const [channel, cell] of [[0, 32], [1, 8], [2, 2]]) {
    const k = n / cell
    const grid = Array.from({ length: k * k }, rnd)
    const at = (x, y) => grid[((y + k) % k) * k + ((x + k) % k)]
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const gx = x / cell, gy = y / cell
        const x0 = Math.floor(gx), y0 = Math.floor(gy)
        const fx = smooth(gx - x0), fy = smooth(gy - y0)
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx
        const low = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx
        data[(y * n + x) * 4 + channel] = Math.round((top + (low - top) * fy) * 255)
      }
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  speckle = new THREE.DataTexture(data, n, n)
  speckle.wrapS = speckle.wrapT = THREE.RepeatWrapping
  speckle.magFilter = THREE.LinearFilter
  speckle.minFilter = THREE.LinearMipmapLinearFilter
  speckle.generateMipmaps = true
  speckle.needsUpdate = true
  return speckle
}

/**
 * Painted sheet metal: matte paint that takes the light, one material for the whole yard. Drawn
 * with four touches that cost a few sums a pixel and nothing else:
 *   - the paint is worn in soft patches and a fine grain, so a wall is not one flat colour;
 *   - its edges are worn a shade lighter, a line about a pixel wide, so every box reads crisp;
 *   - the foot of every upright face is darker, as if the ground kept the light off it there;
 *   - a face seen side-on catches a little of the sky, so a bot stands off the ground behind it.
 */
let paintwork = null
export const painted = () => {
  if (paintwork) return paintwork
  paintwork = new THREE.MeshLambertMaterial({ vertexColors: true })
  PAINT.uSpeckle.value = wearTexture()
  paintwork.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, PAINT)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 edge;
varying vec2 vEdge;
varying vec2 vSpot;
varying float vFoot;
varying float vUpright;
varying float vRim;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vEdge = edge;
// The sky caught on a face seen side-on: faces are flat, so it is worked out at the corners only.
vRim = pow(1.0 - saturate(dot(normalize(transformedNormal), normalize(-mvPosition.xyz))), 3.0);
vFoot = position.y;
vUpright = 1.0 - smoothstep(0.55, 0.9, abs(normal.y));
// The wear is laid on from one slanted side, so no face, upright or flat, gets it smeared.
vec3 spot = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSpot = (spot.xz + spot.y * vec2(0.37, 0.61)) / 24.0;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uRim;
uniform float uWear;
uniform sampler2D uSpeckle;
varying float vRim;
varying vec2 vEdge;
varying vec2 vSpot;
varying float vFoot;
varying float vUpright;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 wear = texture2D(uSpeckle, vSpot).rgb - 0.5;
  diffuseColor.rgb *= 1.0 + uWear * dot(wear, vec3(0.16, 0.1, 0.07));
  vec2 fw = max(fwidth(vEdge), vec2(1e-5));
  vec2 away = min(vEdge, 1.0 - vEdge) / fw;
  float line = 1.0 - smoothstep(0.5, 1.6, min(away.x, away.y));
  line *= smoothstep(7.0, 20.0, 1.0 / max(fw.x, fw.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.035, line * uWear);
  diffuseColor.rgb *= mix(1.0, mix(0.6, 1.0, smoothstep(0.0, 0.8, vFoot)), vUpright);
}`)
      .replace('#include <envmap_fragment>', `#include <envmap_fragment>
outgoingLight += uRim * vRim * (0.4 + 0.6 * diffuseColor.rgb);`)
  }
  return paintwork
}

/** What gives light of its own (lamps, eyes): drawn at its own colour whatever the hour. One for the whole yard. */
let glow = null
export const lit = () => (glow ||= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }))
