/**
 * How a page knows a bot: by the role it plays and the look its own settings give it, never by its name.
 *
 * A bot's settings file may say `role` (lead, builder, checker, reviewer, ruler, researcher) and
 * `look` (colour, build, gear, hat, face); the engine keeps both in the bot's `metadata`. What a bot
 * does not say gets a default by its role, and a colour from a fixed palette by its place in the
 * crew, so two bots are told apart whatever they are called. This is the one place that decides it,
 * for the map, the phone's door and every list.
 */

export const ROLES = ['lead', 'builder', 'checker', 'reviewer', 'ruler', 'researcher', 'general']
/** The engine's own words for a bot's kind of work, as the roles a page speaks of. */
const FROM_ENGINE = { ceo: 'lead', engineer: 'builder', qa: 'checker', researcher: 'researcher' }

/** The role a bot plays: the one its settings name, else the one its kind of work implies. */
export function roleOf(agent = {}) {
  const said = String(agent.metadata?.role || '').toLowerCase()
  if (ROLES.includes(said)) return said
  return FROM_ENGINE[agent.role] || 'general'
}

/** What each role wears when its settings say nothing: a hat that says the job, a build, and what it carries. */
const BY_ROLE = {
  lead: { hat: 'crown', build: 'standard', gear: ['sash'] },
  builder: { hat: 'hardhat', build: 'heavy', gear: ['toolbelt'] },
  checker: { hat: 'feelers', build: 'sleek', gear: ['magnifier'] },
  reviewer: { hat: 'beret', build: 'slim', gear: ['clipboard'] },
  ruler: { hat: 'wizard', build: 'robed', gear: ['cape'] },
  researcher: { hat: 'cap', build: 'slim', gear: ['satchel'] },
  general: { hat: 'antenna', build: 'standard', gear: [] },
}

/** Ten paints that read apart on the floor and on a plate, in the order they are handed out. */
export const PALETTE = ['#2f7cf6', '#e2404d', '#2fbf5a', '#f08a1c', '#6457e8', '#07b2ce', '#f06fae', '#c49a6c', '#9bdc1c', '#eaae20']
const HEX = /^#[0-9a-f]{6}$/i
const word = (value, fallback) => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,30}$/i.test(value) ? value.toLowerCase() : fallback)

/** A bot's look: what its settings give, the rest by its role; `place` is its place in the crew, for its paint. */
export function lookOf(agent = {}, place = 0) {
  const own = agent.metadata?.look && typeof agent.metadata.look === 'object' ? agent.metadata.look : {}
  const usual = BY_ROLE[roleOf(agent)]
  return {
    colour: HEX.test(own.colour || '') ? own.colour.toLowerCase() : PALETTE[((place % PALETTE.length) + PALETTE.length) % PALETTE.length],
    build: word(own.build, usual.build),
    gear: Array.isArray(own.gear) ? own.gear.map((g) => word(g, '')).filter(Boolean).slice(0, 6) : usual.gear,
    hat: word(own.hat, usual.hat),
    face: typeof own.face === 'string' && /^[\w.-]{1,80}$/.test(own.face) ? own.face : '',
  }
}

/**
 * Every bot's role and look by id. A bot's place is its turn in the crew by when it was made, so its
 * paint stays the same when another bot is added, paused or renamed.
 */
export function crewLooks(agents = []) {
  const byAge = [...agents].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)))
  return new Map(byAge.map((agent, place) => [agent.id, { role: roleOf(agent), look: lookOf(agent, place) }]))
}

/** The bot that leads the crew: the first made of those whose role is lead. */
export function leadOf(agents = []) {
  return [...agents].filter((a) => roleOf(a) === 'lead').sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0] || null
}
