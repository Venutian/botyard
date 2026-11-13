/**
 * Which "Needs you" cards the owner has read or archived, shared by the map and the phone, so a card
 * sorted on one is sorted on the other. Kept in a small file next to the guard settings; the cards
 * themselves still come from the engine.
 *
 * A card's key names what it is, not its words: a chat's question card is keyed by its questions, so a
 * new question in an archived chat comes back as a new card instead of staying hidden.
 */
import fs from 'node:fs'
import path from 'node:path'
import { guardFolder } from './guard.mjs'

export const cardsFile = (env = process.env) => path.join(guardFolder(env), 'cards.json')
const KEEP_MS = 60 * 24 * 3600 * 1000
const MAX_KEYS = 200

export function cardKey(item = {}) {
  const asks = Array.isArray(item.asks) ? item.asks.map((a) => a?.id).filter(Boolean).sort() : []
  if (asks.length) return `question:${item.id}:${asks.join(',')}`
  return `${item.kind}:${item.id || item.title || ''}`
}

export function readCards(file = cardsFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const map = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
    return { read: map(data.read), archived: map(data.archived) }
  } catch {
    return { read: {}, archived: {} }
  }
}

/** Mark keys read or unread, archived or back. Unset fields leave that side as it is. */
export function markCards(keys, { read, archived } = {}, { file = cardsFile(), now = Date.now() } = {}) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k && k.length <= 600).slice(0, MAX_KEYS)
  if (!list.length) throw new Error('No card given')
  const store = readCards(file)
  for (const key of list) {
    if (read === true) store.read[key] = now
    if (read === false) delete store.read[key]
    if (archived === true) { store.archived[key] = now; store.read[key] = store.read[key] || now }
    if (archived === false) delete store.archived[key]
  }
  // Old marks go: a card that has not been seen for two months is long gone from the engine.
  for (const side of ['read', 'archived']) {
    for (const [key, at] of Object.entries(store[side])) if (!(now - at < KEEP_MS)) delete store[side][key]
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store))
  fs.renameSync(tmp, file)
  return store
}

/** The cards with their key and whether they are read or archived. */
export function withCardState(items = [], store = readCards()) {
  return items.map((item) => {
    const key = cardKey(item)
    return { ...item, key, read: Boolean(store.read[key]), archived: Boolean(store.archived[key]) }
  })
}
