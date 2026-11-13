import * as THREE from 'three'
import { Ground, LIGHTS } from './ground.js'
import { BAY_PAINTS, DEPOT_PAINT, DECK_TOP, buildBay, buildGate } from './bays.js'
import { BAY_RADIUS, BAY_STEP, assign, centreOf, cornersOf, gateAt, places, ringsUsed, standAt } from './layout.js'
import { buildRobot } from '../robots/robot.js'
import { specOf, stateOf } from '../robots/look.js'

/**
 * Everything on the ground: the bays, the gate, the things standing about and the crew. Given the
 * yard's view (its projects and its bots), it changes only what differs from what is already
 * standing: a bay is built once, a robot is built again only when its look or state changes.
 */

const KEPT = 'botyard.bays.v1'
/** Robots are drawn a size up from their own units, so a bot reads at a glance across a bay. */
const ROBOT_SCALE = 1.6
const read = () => { try { return JSON.parse(localStorage.getItem(KEPT) || '{}') || {} } catch { return {} } }
const keep = (placed) => { try { localStorage.setItem(KEPT, JSON.stringify(placed)) } catch { /* kept for this visit only */ } }

export class Yard {
  /** @param {import('./stage.js').Stage} stage */
  constructor(stage) {
    this.stage = stage
    this.ground = new Ground(stage.scene)
    this.bays = new Map()
    this.robots = new Map()
    this.gate = null
    this.gateAnchor = null
    this.depot = ''
    this.shiftTo('day')
  }

  shiftTo(hour) {
    if (this.hour === hour) return
    this.hour = hour
    this.ground.light(hour)
    this.stage.renderer.toneMappingExposure = LIGHTS[hour].exposure
    // Concrete is painted per hour, so the bays and the gate are built again in the new light.
    for (const bay of this.bays.values()) this._drop(bay.group)
    this.bays.clear()
    if (this.gate) { this._drop(this.gate); this.gate = null }
    if (this._last) this.show(this._last)
    this.stage.redraw()
  }

  /** How fine the shadows are. */
  shadows(size) {
    this.ground.shadows(size)
    this.stage.redraw()
  }

  /**
   * Show the yard as the view says.
   * @param {{ projects: string[], depot: string, crew: { id: string, project: string, crew: { name: string, look?: object, status?: string, job?: object|null } }[] }} view
   *   the projects by name, the Depot's name, and the crew as the yard's view lists them (one entry per bot, in the bay of its job)
   * @returns {boolean} whether the bays changed (so the whole yard may want framing again)
   */
  show(view) {
    this._last = view
    this.depot = view.depot || 'Depot'
    const names = view.projects.filter((n) => n !== this.depot)
    const placed = assign(names, read())
    keep(placed)
    const concrete = LIGHTS[this.hour].concrete
    const wanted = new Map([[this.depot, 0], ...Object.entries(placed)])
    let moved = false

    // Bays: built for what is new or moved, taken down for what left.
    for (const [name, bay] of this.bays) {
      if (wanted.get(name) === bay.at) continue
      this._drop(bay.group)
      this.bays.delete(name)
      moved = true
    }
    for (const [name, at] of wanted) {
      if (this.bays.has(name)) continue
      const depot = name === this.depot
      const paint = depot ? DEPOT_PAINT : BAY_PAINTS[(at - 1) % BAY_PAINTS.length]
      const centre = centreOf(at)
      const group = buildBay({ name, paint, concrete, depot })
      group.position.set(centre.x, 0, centre.z)
      this.stage.scene.add(group)
      this.bays.set(name, {
        name, at, group, depot,
        paint,
        accent: parseInt(paint.slice(1), 16),
        middle: new THREE.Vector3(centre.x, 0, centre.z),
        corners: cornersOf(centre, BAY_RADIUS).map((c) => new THREE.Vector3(c.x, DECK_TOP, c.z)),
      })
      moved = true
    }

    // The gate beyond the last ring, and the things standing about between the bays.
    const rings = ringsUsed(placed)
    if (moved || !this.gate) {
      if (this.gate) this._drop(this.gate)
      const g = gateAt(rings)
      this.gate = buildGate(concrete)
      this.gate.position.set(g.x, 0, g.z)
      this.stage.scene.add(this.gate)
      this.gateAnchor = this.gate.userData.plate.clone().add(this.gate.position)
      this._dress(new Set(wanted.values()), rings)
    }

    // The crew: each in the bay of its job, the rest at the Depot.
    const byBay = new Map()
    for (const bot of view.crew) {
      if (!bot.crew) continue
      const home = this.bays.has(bot.project) ? bot.project : this.depot
      if (!byBay.has(home)) byBay.set(home, [])
      byBay.get(home).push(bot)
    }
    const seen = new Set()
    for (const [home, bots] of byBay) {
      const bay = this.bays.get(home)
      bots.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      bots.forEach((bot, n) => {
        seen.add(bot.id)
        const spec = specOf(bot.crew)
        const state = stateOf(bot.crew)
        const key = JSON.stringify([spec, state])
        let robot = this.robots.get(bot.id)
        if (robot && robot.key !== key) { this._drop(robot.group); robot = null }
        if (!robot) {
          const group = buildRobot(spec, state)
          group.scale.setScalar(ROBOT_SCALE)
          this.stage.scene.add(group)
          robot = { id: bot.id, key, group, state }
          this.robots.set(bot.id, robot)
        }
        const spot = standAt(n, bots.length)
        robot.group.position.set(bay.middle.x + spot.x, DECK_TOP, bay.middle.z + spot.z)
        // A bot at work faces the bay's middle; one with nothing to do faces out toward the viewer's side.
        robot.group.rotation.y = state === 'building' || state === 'checking' ? spot.facing + Math.PI : spot.facing * 0.25
        robot.thread = bot
        robot.pos = robot.group.position
        robot.top = robot.group.userData.top.y * ROBOT_SCALE
      })
    }
    for (const [id, robot] of this.robots) {
      if (seen.has(id)) continue
      this._drop(robot.group)
      this.robots.delete(id)
    }
    this.stage.redraw()
    return moved
  }

  /** Free ground round the bays gets something standing on it; the lane to the gate stays clear. */
  _dress(taken, rings) {
    const spots = []
    const all = places(rings + 1)
    const used = new Set([...taken].map((at) => `${all[at]?.a},${all[at]?.b}`))
    const gate = gateAt(rings)
    for (const p of all) {
      if (used.has(`${p.a},${p.b}`) || p.ring === 0) continue
      const c = centreOf(p)
      if (Math.abs(c.x - gate.x) < BAY_STEP * 0.6 && c.z < 0) continue
      // A free place gets two things, off its middle, so they sit in the lanes between bays.
      spots.push({ x: c.x - 3.2, z: c.z + 2.2, key: `${p.a},${p.b},1` }, { x: c.x + 3.6, z: c.z - 2.6, key: `${p.a},${p.b},2` })
    }
    this.ground.dress(spots, (rings + 1.5) * BAY_STEP)
  }

  /** Every point the whole yard should show: the bays' corners and the gate. */
  extent() {
    const out = []
    for (const bay of this.bays.values()) out.push(...bay.corners)
    if (this.gateAnchor) out.push(this.gateAnchor)
    return out
  }

  /** The bays in a list, for the signs over them. */
  get plotOrder() { return [...this.bays.values()].filter((b) => !b.hidden) }

  /** The robots in a list, shaped for the names placed under them. */
  get agents() {
    return [...this.robots.values()].map((r) => r.tagged ||= { id: r.id, get thread() { return r.thread }, get pos() { return r.pos }, scale: ROBOT_SCALE, state: 'here', robot: r })
  }

  /** The robot under a ray, if any. */
  pick(ray) {
    let best = null
    let near = Infinity
    const box = new THREE.Box3()
    const hit = new THREE.Vector3()
    for (const robot of this.robots.values()) {
      box.setFromCenterAndSize(new THREE.Vector3(robot.pos.x, robot.pos.y + robot.top / 2, robot.pos.z), new THREE.Vector3(1.3 * ROBOT_SCALE, robot.top, 1.3 * ROBOT_SCALE))
      if (!ray.ray.intersectBox(box, hit)) continue
      const d = hit.distanceTo(ray.ray.origin)
      if (d < near) { near = d; best = robot }
    }
    return best
  }

  /** The bay under a ground point. */
  bayAt(point) {
    for (const bay of this.bays.values()) if (Math.hypot(point.x - bay.middle.x, point.z - bay.middle.z) < BAY_RADIUS) return bay
    return null
  }

  _drop(group) {
    this.stage.scene.remove(group)
    group.userData.dispose?.()
  }
}
