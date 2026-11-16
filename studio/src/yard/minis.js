/**
 * Minis: a bot that works in two or more projects stands in its main bay as itself and has a
 * small copy working in each of the others. Plain data in, plain data out, so it is tested
 * without a browser.
 */

/** At most this many minis of one bot. */
export const MAX_MINIS = 3
/** A mini is drawn at this share of the bot's size. */
export const MINI_SCALE = 0.6

/**
 * @param {{ id: string, project: string, crew?: { alsoIn?: string[] } }[]} crew the yard's threads (project is where the bot stands)
 * @param {{ depot: string, bays: Iterable<string>, shelved?: Iterable<string> }} where the Depot, the bays that stand, and the shelved ones
 * @returns {{ id: string, project: string, n: number }[]} one entry per mini: whose copy, in which project, and its number there
 */
export function planMinis(crew, { depot, bays, shelved = [] }) {
  const standing = new Set(bays)
  const shut = new Set(shelved)
  const taken = new Map()
  const out = []
  for (const bot of crew) {
    const main = bot.project
    // Where the bot works: the bay it stands in (the Depot is not a project) and the others it has jobs in.
    const projects = new Set([...(main && main !== depot ? [main] : []), ...(bot.crew?.alsoIn || [])])
    if (projects.size < 2) continue
    let made = 0
    for (const project of projects) {
      if (project === main || project === depot || !standing.has(project) || shut.has(project)) continue
      if (made === MAX_MINIS) break
      const n = taken.get(project) || 0
      taken.set(project, n + 1)
      out.push({ id: bot.id, project, n })
      made++
    }
  }
  return out
}

/** Where mini number `n` stands in a bay, bay-local: along the bay's front edge, clear of the crates and the bots' rings. */
export function miniAt(n) {
  const row = [[-3.6, 5.4], [3.6, 5.4], [0, 6.4], [-1.8, -4.8], [1.8, -4.8]]
  const [x, z] = row[n % row.length]
  return { x, z, facing: 0 }
}
