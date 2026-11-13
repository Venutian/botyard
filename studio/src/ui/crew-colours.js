/**
 * Each bot's own colour, the one its robot wears in the yard (src/robots/look.js), for the page: its
 * plate in the crew bar, the edge of the jobs it is on, the head of its conversation. A bot is told
 * apart by colour first, everywhere, the same way it is on the floor.
 *
 * The colour is the bot's own (`look.colour`, from its settings or handed out by the server); the
 * page learns the crew's colours from every list of bots it is given and looks one up by name.
 */
const paints = new Map()
const SPARE = '#7d8590'

const light = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Take note of the crew's colours from a list of bots as the server sent it. */
export function learnColours(bots = []) {
  for (const bot of bots) {
    if (bot?.name && /^#[0-9a-f]{6}$/i.test(bot.look?.colour || '')) paints.set(bot.name, bot.look.colour)
  }
}

/** The bot's paint and the ink that reads on it, by its name as the crew lists it. */
export function botColour(name) {
  const paint = paints.get(String(name || '')) || SPARE
  return { paint, ink: light(paint) > 0.3 ? '#14161a' : '#ffffff' }
}

/** The same as an inline style, for a tag that draws itself from `--bot` and `--bot-ink`. */
export function botStyle(name) {
  const { paint, ink } = botColour(name)
  return `--bot:${paint};--bot-ink:${ink}`
}
