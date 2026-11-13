/**
 * What a bot's look fields mean on a yard robot. A bot's settings give `colour`, `build`, `hat`,
 * `gear` and `face`; this turns each word into the plain numbers and names the builder draws from.
 * A word it does not know falls back to the plain one, so an old or mistyped look still gives a
 * whole robot. Nothing here needs a browser.
 */

/**
 * A build is the body plate from the foot up: each row is one plate `[width at its foot, width at
 * its top, height]`, and `deep` is how thick the plate is. Heights add up to about 0.9.
 */
export const BUILDS = {
  standard: { deep: 0.24, plates: [[0.64, 0.64, 0.9]] },
  slim: { deep: 0.18, plates: [[0.42, 0.46, 0.98]] },
  sleek: { deep: 0.16, plates: [[0.36, 0.5, 0.5], [0.5, 0.44, 0.46]] },
  heavy: { deep: 0.36, plates: [[0.9, 0.82, 0.86]] },
  barrel: { deep: 0.46, plates: [[0.54, 0.84, 0.26], [0.84, 0.84, 0.3], [0.84, 0.54, 0.26]] },
  robed: { deep: 0.26, plates: [[0.92, 0.56, 0.6], [0.56, 0.6, 0.32]] },
  curvy: { deep: 0.26, plates: [[0.74, 0.42, 0.44], [0.42, 0.72, 0.44]] },
  lady: { deep: 0.22, plates: [[0.8, 0.46, 0.4], [0.46, 0.56, 0.5]] },
  vee: { deep: 0.26, plates: [[0.38, 0.9, 0.9]] },
}

export const HATS = ['none', 'crown', 'wizard', 'beret', 'cog', 'hardhat', 'headphones', 'feelers', 'tophat', 'cap', 'antenna']
export const GEAR = ['sash', 'cape', 'toolbelt', 'wrench', 'satchel', 'magnifier', 'ponytail', 'bowtie', 'clipboard']
/** Words a yard may still carry from an older set of looks, and what they are now. */
const ALSO = { kritik: 'clipboard', belt: 'toolbelt', glass: 'magnifier', bag: 'satchel', bow: 'bowtie', helmet: 'hardhat', hat: 'tophat' }

const HEX = /^#[0-9a-f]{6}$/i
const GREY = '#7d8590'

/** How light a paint is, 0 to 1, as the eye weighs it. */
export function lightness(hex) {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

/** A paint taken toward black (below 0) or white (above 0) by a share. */
export function shade(hex, by) {
  const n = parseInt(hex.slice(1), 16)
  const to = by < 0 ? 0 : 255
  const k = Math.abs(by)
  const part = (v) => Math.round(v + (to - v) * k).toString(16).padStart(2, '0')
  return `#${part(n >> 16)}${part((n >> 8) & 255)}${part(n & 255)}`
}

/**
 * @param {{ name?: string, look?: { colour?: string, color?: string, build?: string, hat?: string, gear?: string[]|string, face?: string } }} bot
 * @returns the robot's spec: its paints, its build, its hat and what it carries
 */
export function specOf(bot = {}) {
  const look = bot.look && typeof bot.look === 'object' ? bot.look : {}
  const said = look.colour || look.color
  const suit = HEX.test(said || '') ? said.toLowerCase() : GREY
  const build = Object.hasOwn(BUILDS, look.build) ? look.build : 'standard'
  const hatWord = ALSO[look.hat] || look.hat
  const hat = HATS.includes(hatWord) ? hatWord : 'none'
  const list = Array.isArray(look.gear) ? look.gear : look.gear ? [look.gear] : []
  const gear = [...new Set(list.map((g) => ALSO[g] || g).filter((g) => GEAR.includes(g)))]
  const name = String(bot.name || '').trim()
  return {
    suit,
    // The dark the suit is trimmed with, and the ink that reads on the suit.
    trim: shade(suit, -0.62),
    ink: lightness(suit) > 0.58 ? '#15181d' : '#f2f4f6',
    // A face said to be light is a pale screen with dark eyes; otherwise a dark screen with bright eyes.
    screen: look.face === 'light' ? '#dfe3e8' : '#15181d',
    eyes: look.face === 'light' ? '#15181d' : '#f2f4f6',
    build,
    hat,
    gear,
    initial: (name.match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase(),
  }
}

/** The states a robot is drawn in, and the paint of its lamp in each. */
export const STATES = {
  building: { lamp: '#35d07f', word: 'building' },
  checking: { lamp: '#6ea8ff', word: 'checking' },
  waiting: { lamp: '#c9ced6', word: 'waiting' },
  stopped: { lamp: '#ff5b4d', word: 'stopped' },
  free: { lamp: '#f2f4f6', word: 'free' },
  paused: { lamp: '#3a4049', word: 'paused' },
}

/**
 * Which state a bot of the crew is drawn in, from what the yard's view says of it.
 * @param {{ status?: string, job?: { stage?: string } | null }} crew
 */
export function stateOf(crew = {}) {
  if (crew.status === 'paused') return 'paused'
  if (crew.status === 'error') return 'stopped'
  if (crew.status === 'running') return /^(check|rul)/i.test(crew.job?.stage || '') ? 'checking' : 'building'
  return crew.job ? 'waiting' : 'free'
}
