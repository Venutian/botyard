/**
 * The token guard's settings, kept apart from the engine's budgets.
 *
 * The engine's budgets count billed dollars, and a subscription run bills none, so they never stop
 * anything on a subscription. The owner sets a token limit here, and a small script on this machine
 * pauses the Claude bots past it and resumes them once usage falls back. The door only reads and
 * writes these settings. It pauses nothing itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './home.mjs'

const MAX_LIMIT = 1e11
/** Where the crew's Claude bots stop, and where the director does, unless the owner says otherwise. */
const WEEK_CEILING = 0.9
const LEAD_CEILING = 0.97

export const guardFolder = (env = process.env) => env.BOTYARD_GUARD_DIR || configDir(env)

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** A share of Claude's week, kept where a ceiling makes sense. */
const share = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(1, Math.max(0.5, Math.round(Number(value) * 100) / 100)) : fallback)

/** A list of project names as it may be stored: text only, each once, and not without end. */
const names = (list) => (Array.isArray(list) ? [...new Set(list.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 80)))].slice(0, 50) : [])

export function readGuard(folder) {
  const settings = readJson(path.join(folder, 'guard.json'))
  const state = readJson(path.join(folder, 'guard-state.json'))
  const weekCeiling = share(settings.weekCeiling, WEEK_CEILING)
  return {
    enabled: Boolean(settings.enabled), limit: Number(settings.limit) || 0, tripped: Boolean(state.tripped), used: Number(state.used) || 0,
    // The director keeps answering past the crew's ceiling, so his is never the lower one.
    weekCeiling, leadCeiling: Math.max(weekCeiling, share(settings.leadCeiling, LEAD_CEILING)),
    // Projects the owner put on the shelf: the crew's director gives nobody work from them.
    shelved: names(settings.shelved),
    // The owner's order of the projects, highest first: a free bot takes the next job from the
    // highest one that has work it can do (the crew's health check tells the director).
    ranked: names(settings.ranked),
    // Bots that are no longer part of the crew: still in the engine, shown nowhere.
    retired: names(settings.retired),
  }
}

/** Only what is sent changes: the phone sets the token limit, the map the ceilings too. */
export function writeGuard(folder, { enabled, limit, weekCeiling, leadCeiling, shelved, ranked, retired } = {}) {
  const now = readGuard(folder)
  const clean = {
    enabled: enabled === undefined ? now.enabled : Boolean(enabled),
    limit: limit === undefined ? now.limit : Math.min(MAX_LIMIT, Math.max(0, Math.round(Number(limit) || 0))),
    weekCeiling: share(weekCeiling, now.weekCeiling),
    leadCeiling: share(leadCeiling, now.leadCeiling),
    shelved: shelved === undefined ? now.shelved : names(shelved),
    ranked: ranked === undefined ? now.ranked : names(ranked),
    retired: retired === undefined ? now.retired : names(retired),
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(folder, 'guard.json'), JSON.stringify(clean), { mode: 0o600 })
  return readGuard(folder)
}
