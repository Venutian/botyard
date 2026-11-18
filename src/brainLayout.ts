/**
 * A copy of studio/src/ui/brain-layout.js for the phone app (the two apps build apart): keep them the same.
 *
 * Where each note of Engram stands in 3D: a pure function of the notes, so the field looks the same every time
 * and can be tested. Each area is a lobe whose centre sits on a brain-shaped ellipsoid; its notes gather round
 * it, pulled together along their links and pushed apart from each other. Seeded from the notes' names, never
 * from Math.random.
 */

/** A number in [0, 1) from a string and a salt: the same every time. */
export function hash01(text: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** The brain's shape: wider than tall, longer front to back. */
export const SHAPE = { x: 1.0, y: 0.78, z: 1.22 }
export const RADIUS = 230

/** Lobe centres: spread over the ellipsoid like seeds on a sunflower, a little inside its surface. */
type Area = { id: string }
type Note = { id: string; area: string; links: string[]; supersededBy: string[] }
export type P3 = { x: number; y: number; z: number }

export function lobeCentres(areas: Area[]): (P3 & { id: string })[] {
  const n = Math.max(1, areas.length)
  const golden = Math.PI * (3 - Math.sqrt(5))
  return areas.map((a, i) => {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const t = golden * i
    const k = RADIUS * 0.7
    return { id: a.id, x: Math.cos(t) * r * k * SHAPE.x, y: y * 0.82 * k * SHAPE.y, z: Math.sin(t) * r * k * SHAPE.z }
  })
}

/**
 * Positions for every note: `{ at: Map(id -> {x, y, z}), centres: Map(area -> {x, y, z}) }`.
 * Work is bounded: about 200 steps for a small vault, fewer for a big one.
 */
export function fieldLayout(brain: { notes: Note[]; areas: Area[] }): { at: Map<string, P3>; centres: Map<string, P3> } {
  const notes = brain.notes || []
  const centreList = lobeCentres(brain.areas || [])
  const centres = new Map(centreList.map((c) => [c.id, c]))
  const fallback = { x: 0, y: 0, z: 0 }
  const sizes = new Map<string, number>()
  for (const n of notes) sizes.set(n.area, (sizes.get(n.area) || 0) + 1)
  const p = notes.map((n) => {
    const c = centres.get(n.area) || fallback
    const u = hash01(n.id, 1) * Math.PI * 2
    const v = Math.acos(2 * hash01(n.id, 2) - 1)
    const r = (14 + hash01(n.id, 3) * 30) * (1 + Math.sqrt(sizes.get(n.area) || 1) / 4)
    return { id: n.id, area: n.area, x: c.x + Math.sin(v) * Math.cos(u) * r, y: c.y + Math.cos(v) * r, z: c.z + Math.sin(v) * Math.sin(u) * r, vx: 0, vy: 0, vz: 0 }
  })
  const index = new Map(p.map((q, i) => [q.id, i]))
  const springs: [number, number][] = []
  for (const n of notes) for (const t of [...n.links, ...n.supersededBy]) if (index.has(t)) springs.push([index.get(n.id)!, index.get(t)!])
  const steps = p.length > 800 ? 40 : p.length > 300 ? 90 : 200
  const repelAll = p.length <= 900
  for (let s = 0; s < steps; s += 1) {
    const cool = 1 - s / steps
    if (repelAll) {
      for (let i = 0; i < p.length; i += 1) {
        for (let j = i + 1; j < p.length; j += 1) {
          const dx = p[i].x - p[j].x
          const dy = p[i].y - p[j].y
          const dz = p[i].z - p[j].z
          const d2 = dx * dx + dy * dy + dz * dz + 0.01
          if (d2 > 3600) continue
          const f = (p[i].area === p[j].area ? 150 : 220) / d2
          p[i].vx += dx * f; p[i].vy += dy * f; p[i].vz += dz * f
          p[j].vx -= dx * f; p[j].vy -= dy * f; p[j].vz -= dz * f
        }
      }
    }
    for (const [a, b] of springs) {
      const dx = p[b].x - p[a].x
      const dy = p[b].y - p[a].y
      const dz = p[b].z - p[a].z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const f = (d - 70) * 0.004
      p[a].vx += dx / d * f * d * 0.02; p[a].vy += dy / d * f * d * 0.02; p[a].vz += dz / d * f * d * 0.02
      p[b].vx -= dx / d * f * d * 0.02; p[b].vy -= dy / d * f * d * 0.02; p[b].vz -= dz / d * f * d * 0.02
    }
    for (const q of p) {
      const c = centres.get(q.area) || fallback
      q.vx += (c.x - q.x) * 0.012; q.vy += (c.y - q.y) * 0.012; q.vz += (c.z - q.z) * 0.012
      const sp = Math.min(6, Math.hypot(q.vx, q.vy, q.vz)) / (Math.hypot(q.vx, q.vy, q.vz) || 1)
      q.x += q.vx * sp * cool; q.y += q.vy * sp * cool; q.z += q.vz * sp * cool
      q.vx *= 0.55; q.vy *= 0.55; q.vz *= 0.55
      // Kept inside the skull.
      const e = Math.hypot(q.x / (RADIUS * SHAPE.x), q.y / (RADIUS * SHAPE.y), q.z / (RADIUS * SHAPE.z))
      if (e > 0.9) { q.x *= 0.9 / e; q.y *= 0.9 / e; q.z *= 0.9 / e }
    }
  }
  return { at: new Map(p.map((q) => [q.id, { x: q.x, y: q.y, z: q.z }])), centres }
}

/**
 * The dust that draws the brain's outline, seen best from the side: a folded cortex (two hemispheres split by
 * the fissure, flattened underneath), a cerebellum at the back below it, finely ribbed, and the brain stem.
 * `count` points, the same every time. The front of the brain is +z.
 */
export function brainDust(count = 5000): Float32Array {
  const out = new Float32Array(count * 3)
  let made = 0
  let k = 0
  const put = (x: number, y: number, z: number) => { out[made * 3] = x; out[made * 3 + 1] = y; out[made * 3 + 2] = z; made += 1 }
  const cortex = Math.round(count * 0.8)
  const little = Math.round(count * 0.14)
  while (made < cortex && k < count * 8) {
    k += 1
    const u = hash01('u', k) * Math.PI * 2
    const v = Math.acos(2 * hash01('v', k) - 1)
    let sx = Math.sin(v) * Math.cos(u)
    const sy = Math.cos(v)
    const sz = Math.sin(v) * Math.sin(u)
    if (Math.abs(sx) < 0.06 && sy > -0.25) continue
    sx += Math.sign(sx) * 0.045
    // Gyri and sulci: the shell rises and falls, and the dust gathers on the crests.
    const wave = Math.sin(u * 11 + v * 6) * Math.sin(v * 13 - u * 4) + 0.5 * Math.sin(u * 23 - v * 17)
    if (wave < -0.35 && hash01('s', k) < 0.6) continue
    // The two great grooves, so the side reads as a brain: the lateral sulcus rising from the front of the
    // temporal lobe towards the back, and the central sulcus running down from the crown.
    if (Math.abs(sx) > 0.45 && sz > -0.25 && sz < 0.62 && Math.abs(sy - (-0.28 + (0.62 - sz) * 0.5)) < 0.045) continue
    if (sy > 0.05 && Math.abs(sz - (0.02 + sy * 0.28)) < 0.03) continue
    const fold = 1 + 0.05 * wave
    const depth = 0.94 + hash01('d', k) * 0.06
    const r = RADIUS * fold * depth
    let y = sy * r * SHAPE.y
    // Flat underneath, and a temporal lobe that hangs lower at the sides towards the front.
    const floor = -RADIUS * (0.42 + 0.12 * Math.max(0, sz) * Math.abs(sx))
    if (y < floor) y = floor - (y - floor) * -0.15
    put(sx * r * SHAPE.x, y, sz * r * SHAPE.z)
  }
  // The cerebellum: tucked under the back of the cortex, ribbed across.
  while (made < cortex + little && k < count * 12) {
    k += 1
    const u = hash01('cu', k) * Math.PI * 2
    const v = Math.acos(2 * hash01('cv', k) - 1)
    const rib = 1 + 0.06 * Math.sin(Math.cos(v) * 40)
    const r = RADIUS * 0.3 * rib * (0.9 + hash01('cd', k) * 0.1)
    put(Math.sin(v) * Math.cos(u) * r * 1.35, -RADIUS * 0.5 + Math.cos(v) * r * 0.62, -RADIUS * 0.72 + Math.sin(v) * Math.sin(u) * r * 0.85)
  }
  // The brain stem: down and slightly back from the middle.
  while (made < count && k < count * 16) {
    k += 1
    const t = hash01('st', k)
    const a = hash01('sa', k) * Math.PI * 2
    const r = RADIUS * (0.11 - t * 0.03)
    put(Math.cos(a) * r, -RADIUS * (0.35 + t * 0.5), -RADIUS * (0.32 + t * 0.12) + Math.sin(a) * r)
  }
  return out.subarray(0, made * 3)
}
