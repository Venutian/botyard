/**
 * The piles the Work sheet and the phone's Jobs list sort jobs into, each one tap away with its count: what the
 * crew has in hand, what waits to start, the backlog, what is blocked, what was done today, and what was cancelled.
 * "active" and "done" are the older piles, kept for a phone app that still asks for them.
 */
export const PILES = {
  inhand: { name: 'In hand', statuses: ['in_progress', 'in_review'] },
  waiting: { name: 'Waiting to start', statuses: ['todo'] },
  backlog: { name: 'Backlog', statuses: ['backlog'] },
  blocked: { name: 'Blocked', statuses: ['blocked'] },
  today: { name: 'Done today', statuses: ['done'], today: true },
  cancelled: { name: 'Cancelled', statuses: ['cancelled'] },
  active: { name: 'Active', statuses: ['in_progress', 'in_review', 'blocked', 'todo'], old: true },
  done: { name: 'Done', statuses: ['done', 'cancelled'], old: true },
}

/** The piles in the order they are shown. */
export const PILE_ORDER = Object.keys(PILES).filter((id) => !PILES[id].old)

/** Midnight this morning on this computer's clock, as an ISO time: where "today" starts. */
export function startOfToday(now = Date.now()) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.toISOString()
}

/** Each pile with its count, from the engine's job counts (`/companies/:id/job-counts`); none when it has none. */
export function pilesOf(counts) {
  if (!counts?.statuses) return []
  return PILE_ORDER.map((id) => {
    const pile = PILES[id]
    const count = pile.today ? Number(counts.settled?.done) || 0 : pile.statuses.reduce((sum, s) => sum + (Number(counts.statuses[s]) || 0), 0)
    return { id, name: pile.name, count }
  })
}
