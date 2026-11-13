/**
 * Projects in the owner's ranking: named ones first in that order, the rest after in their own.
 *
 *   rankProjects([{ name: 'A' }, { name: 'B' }], ['B']) → [{ name: 'B' }, { name: 'A' }]
 */
export function rankProjects(projects, ranked) {
  const at = new Map(ranked.map((name, i) => [name, i]))
  return projects
    .map((p, i) => ({ p, i, r: at.has(p.name) ? at.get(p.name) : ranked.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p)
}
