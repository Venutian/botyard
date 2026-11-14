/**
 * How much of each AI the crew has used, and how much is left where that is known: the list the top
 * bar opens. One row a provider, the subscriptions first, then Gemini, then the free providers.
 *
 * What is known differs by provider, and the list says only what is known:
 * - Claude and Codex report their own weekly share (and Codex a five-hour one); the crew's usage script
 *   reads it (plans.mjs).
 * - OpenRouter can be asked how many of its free requests a day are left on the key.
 * - The other free providers publish little or nothing. For each of their models, free-limits.py has
 *   learned from watching how much work it usually gives before it stops and how long it stays out.
 * - Every provider's new tokens over 5 hours, a day and a week come from the engine's own count.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keysDir } from './home.mjs'

const OPENROUTER_TTL_MS = 120_000
let openrouterCache = { at: 0, value: null }

/** The OpenRouter key Botyard was given, else the one OpenCode signed in with; never shown. */
function openrouterKey({ keys = keysDir(), home = os.homedir() } = {}) {
  try {
    const key = fs.readFileSync(path.join(keys, 'openrouter.key'), 'utf8').split('\n')[0].trim()
    if (key) return key
  } catch { /* not pasted */ }
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
    return typeof auth?.openrouter?.key === 'string' ? auth.openrouter.key : ''
  } catch {
    return ''
  }
}

/**
 * How many free requests OpenRouter still allows the key today, as `{ left, limit }`, or null when
 * there is no key or it will not say. Asked at most every two minutes.
 */
export async function openrouterLeft({ fetchImpl = fetch, now = Date.now(), key = openrouterKey() } = {}) {
  if (!key) return null
  if (now - openrouterCache.at < OPENROUTER_TTL_MS) return openrouterCache.value
  let value = null
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const day = (await res.json())?.data?.free_model_daily_requests
      const left = Number(day?.remaining)
      const limit = Number(day?.limit)
      if (Number.isFinite(left)) value = { left: Math.max(0, Math.round(left)), ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.round(limit) } : {}) }
    }
  } catch { /* offline or refused: the row says less */ }
  openrouterCache = { at: now, value }
  return value
}

const SHARE = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null)
const STAMP = (v) => (Number(v) > 0 ? Math.floor(Number(v) > 1e12 ? Number(v) / 1000 : Number(v)) : null)

/**
 * The list, from what was read. Pure, so the shape is tested without any file or network.
 * @param {object} a
 * @param {object|null} a.plans what readPlans() gives
 * @param {Array<object>} a.windows tokenWindows(): `{ name, '5h', '24h', '7d' }`
 * @param {Array<object>} a.free readModels().free
 * @param {Array<{label: string, until: number}>} [a.usedUp] Gemini models set aside as used up
 * @param {{left: number, limit?: number}|null} [a.openrouter]
 */
export function usageRows({ plans = null, windows = [], free = [], usedUp = [], openrouter = null }) {
  const tokens = new Map(windows.map((w) => [w.name, { '5h': w['5h'] || 0, '24h': w['24h'] || 0, '7d': w['7d'] || 0 }]))
  const none = { '5h': 0, '24h': 0, '7d': 0 }
  const rows = []
  const claude = plans?.claude
  if (claude || tokens.has('Claude')) {
    rows.push({ id: 'claude', name: 'Claude', kind: 'plan', week: SHARE(claude?.week), resets: STAMP(claude?.resets), tokens: tokens.get('Claude') || none,
      note: claude ? "The subscription's weekly limit, as Claude reports it." : "The weekly share is not known here: the crew's usage script did not answer." })
  }
  const codex = plans?.codex
  if (codex || tokens.has('Codex')) {
    rows.push({ id: 'codex', name: 'Codex', kind: 'plan', week: SHARE(codex?.week), resets: STAMP(codex?.resets), fiveHours: SHARE(codex?.fiveHours), fiveHoursResets: STAMP(codex?.fiveHoursResets), tokens: tokens.get('Codex') || none,
      note: codex ? 'The weekly and five-hour limits, as Codex reports them.' : "The weekly share is not known here: the crew's usage script did not answer." })
  }
  if (tokens.has('Antigravity') || usedUp.length) {
    rows.push({ id: 'gemini', name: 'Gemini', sub: 'through Antigravity', kind: 'other', tokens: tokens.get('Antigravity') || none,
      models: usedUp.map((m) => ({ label: m.label, state: 'aside', back: STAMP(m.until) })),
      note: usedUp.length ? 'A model used up is set aside until its limit resets.' : 'Google does not report how much of the limit is used; a model that runs out is set aside here.' })
  }
  // The free providers: those with models in the free list, then any other with tokens this week.
  const byProvider = new Map()
  for (const f of free) {
    const list = byProvider.get(f.provider) || []
    list.push(f)
    byProvider.set(f.provider, list)
  }
  const names = [...new Set([...byProvider.keys(), ...windows.map((w) => w.name).filter((n) => !['Claude', 'Codex', 'Antigravity'].includes(n))])]
  for (const name of names) {
    // The provider's own note is what most of its models share; a model with a limit of its own says it on its line.
    const notes = (byProvider.get(name) || []).map((f) => f.published).filter(Boolean)
    const common = [...new Set(notes)].sort((x, y) => notes.filter((n) => n === y).length - notes.filter((n) => n === x).length)[0] || ''
    const models = (byProvider.get(name) || []).map((f) => {
      const l = f.learned || {}
      const state = f.state === 'aside' ? 'aside' : f.state === 'answering' ? 'answering' : 'unchecked'
      return {
        label: f.label, state,
        ...(state === 'aside' ? { back: STAMP(f.until) || STAMP(l.back) } : {}),
        ...(state !== 'aside' && l.usualSeconds ? { usualSeconds: l.usualSeconds, leftSeconds: l.leftSeconds ?? null, roundSeconds: l.round?.seconds || 0 } : {}),
        ...(f.why && state === 'aside' ? { why: f.why } : {}),
        ...(f.published && f.published !== common ? { limit: f.published } : {}),
      }
    })
    const row = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, kind: 'free', tokens: tokens.get(name) || none, models, note: common ? `Published limit: ${common[0].toLowerCase()}${common.slice(1)}.` : '' }
    if (name === 'OpenRouter free' && openrouter) {
      const limit = openrouter.limit || 1000
      row.day = { left: openrouter.left, limit, share: SHARE(1 - openrouter.left / limit) }
    }
    rows.push(row)
  }
  return rows
}
