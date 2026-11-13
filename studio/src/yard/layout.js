/**
 * Where the bays stand. The yard is a honeycomb of six-sided bays, the shape of the nut in
 * Botyard's sign: the Depot in the middle, the projects round it ring by ring, the gate beyond the
 * last ring. A project keeps the place it was first given, so the yard can be learnt: a new
 * project takes the first free place, and a place freed by a project that left is used again.
 *
 * Everything here is plain numbers, so it is tested without a browser.
 */

/** A bay, centre to corner. */
export const BAY_RADIUS = 8
/** Centre to centre of two neighbouring bays: two bays and a lane to walk between them. */
export const BAY_STEP = 18.6
/** How many places the yard has: the middle and five rings round it. */
export const MAX_RING = 5

const SIXTH = Math.PI / 3
/** The six ways from one place to its neighbours, as steps on the honeycomb's two axes. */
const WAYS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]

/** Every place in order: the middle, then each ring from its northern corner round. */
export function places(rings = MAX_RING) {
  const out = [{ a: 0, b: 0, ring: 0 }]
  for (let ring = 1; ring <= rings; ring++) {
    // From the ring's northern corner, one side at a time.
    let a = WAYS[4][0] * ring, b = WAYS[4][1] * ring
    for (let side = 0; side < 6; side++) {
      const [da, db] = WAYS[side]
      for (let step = 0; step < ring; step++) {
        out.push({ a, b, ring })
        a += da
        b += db
      }
    }
  }
  return out
}

const ALL = places()

/** The middle of a place on the ground: x to the right, z toward the viewer. */
export function centreOf(place) {
  const { a, b } = typeof place === 'number' ? ALL[place] : place
  return { x: BAY_STEP * (a + b / 2), z: BAY_STEP * (Math.sqrt(3) / 2) * b }
}

/** A bay's six corners round a centre, flat sides to east and west. */
export function cornersOf(centre, radius = BAY_RADIUS) {
  return Array.from({ length: 6 }, (_, k) => ({
    x: centre.x + radius * Math.sin(k * SIXTH),
    z: centre.z + radius * Math.cos(k * SIXTH),
  }))
}

/**
 * Give every bay its place.
 * @param {string[]} names the projects, in any order
 * @param {Record<string, number>} [kept] the places given before (name to place number)
 * @returns {Record<string, number>} name to place number, for exactly these names; place 0 is the Depot's
 */
export function assign(names, kept = {}) {
  const out = {}
  const taken = new Set([0])
  for (const name of names) {
    const at = kept[name]
    if (Number.isInteger(at) && at > 0 && at < ALL.length && !taken.has(at)) {
      out[name] = at
      taken.add(at)
    }
  }
  let next = 1
  for (const name of names) {
    if (name in out) continue
    while (taken.has(next) && next < ALL.length) next++
    // A yard with more projects than places stacks the rest on the last one rather than losing them.
    out[name] = Math.min(next, ALL.length - 1)
    taken.add(next)
  }
  return out
}

/** The outermost ring in use, for where the gate stands and how far the ground is dressed. */
export function ringsUsed(placed) {
  return Math.max(1, ...Object.values(placed).map((at) => ALL[at].ring))
}

/** The gate: beyond the last ring, to the north (the far side from the viewer). */
export function gateAt(rings) {
  return { x: 0, z: -(rings + 0.5) * BAY_STEP * (Math.sqrt(3) / 2) - BAY_RADIUS }
}

/**
 * Where bot number `n` of `count` stands in a bay, bay-local, and which way it faces (radians
 * round the upright, 0 looking toward the viewer). Rings of six, twelve, eighteen round the
 * middle, which is left free for the bay's post.
 */
export function standAt(n, count) {
  let ring = 1, first = 0
  while (n >= first + ring * 6) { first += ring * 6; ring++ }
  const rings = Math.max(1, Math.ceil((Math.sqrt(1 + (4 * Math.max(count, 1)) / 3) - 1) / 2))
  const reach = Math.min(BAY_RADIUS - 2.4, 3.6 * rings)
  const r = (reach * ring) / rings
  const angle = ((n - first) / (ring * 6)) * Math.PI * 2 + (ring % 2 ? SIXTH / 2 : 0)
  return { x: r * Math.sin(angle), z: r * Math.cos(angle), facing: angle }
}
