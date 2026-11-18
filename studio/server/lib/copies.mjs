/**
 * One bot, several copies. A checker can have a copy of itself on another AI, made from its own file
 * ("<Name> on Codex"), so a check never waits on a busy model. The engine keeps each copy as an agent of
 * its own; every list the owner reads shows them as one bot: the parent's look and name, a tag with the
 * AI the running copy is on, and the jobs of all copies together.
 *
 * A copy says whose it is in its metadata (`laneOf`: the parent's name, `lane`: the AI), set when the crew
 * is seeded. A copy made before that is known by its name: "<parent's name> on <AI>" where the parent exists.
 */

const COPY_NAME = /^(.+) on (Claude|Codex|Gemini|Antigravity|Free models)$/

/** The agent a copy belongs to, or null. Copies of copies are not followed: a parent is never itself a copy. */
function ownerOf(agent, byName) {
  const said = typeof agent.metadata?.laneOf === 'string' ? agent.metadata.laneOf.trim() : ''
  const named = COPY_NAME.exec(agent.name || '')?.[1]
  for (const name of [said, named]) {
    const parent = name && name !== agent.name ? byName.get(name) : null
    if (parent && !(typeof parent.metadata?.laneOf === 'string' && parent.metadata.laneOf.trim())) return parent
  }
  return null
}

/**
 * The copies among `agents`. `parentOf` maps a copy's id to its parent agent; `copiesOf` a parent's id to its
 * copies; `idOf(id)` is the id a list shows for an agent (the parent's, for a copy); `top` the agents that
 * are not copies, in their order.
 */
export function copyGroups(agents = []) {
  const byName = new Map(agents.map((a) => [a.name, a]))
  const parentOf = new Map()
  const copiesOf = new Map()
  for (const agent of agents) {
    const parent = ownerOf(agent, byName)
    if (!parent || parentOf.has(parent.id)) continue
    parentOf.set(agent.id, parent)
    copiesOf.set(parent.id, [...(copiesOf.get(parent.id) || []), agent])
  }
  return {
    parentOf,
    copiesOf,
    idOf: (id) => parentOf.get(id)?.id ?? id,
    top: agents.filter((a) => !parentOf.has(a.id)),
    /** The parent and its copies. */
    family: (agent) => [agent, ...(copiesOf.get(agent.id) || [])],
  }
}

/** The records with every copy's id put as its parent's, for the keys given; the records are not changed. */
export function foldKeys(list, keys, fold) {
  if (!fold.parentOf.size) return list
  return (list || []).map((item) => {
    let out = item
    for (const key of keys) {
      const to = item?.[key] ? fold.idOf(item[key]) : null
      if (to && to !== item[key]) out = { ...out, [key]: to }
    }
    return out
  })
}

/** The copy a family is running on now: the one with a live run, else the one holding an open job, else the parent. */
export function runningCopy(agent, fold, { liveIds = new Set(), heldIds = new Set() } = {}) {
  const family = fold.family(agent)
  return family.find((a) => liveIds.has(a.id)) || family.find((a) => heldIds.has(a.id)) || agent
}
