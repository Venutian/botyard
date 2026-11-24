/**
 * The owner's statements on the store-rules register (docs/launch.md, "Store rules"), per app: written when the owner says
 * yes on a release card that listed them, read by the next release's scan so the owner is not asked again until a rule
 * changes or a year passes. Kept in the yard's config, never in a repository.
 */
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './home.mjs'
import { attestationsFrom } from './store-rules.mjs'

const file = (env = process.env) => path.join(configDir(env), 'store-attestations.json')

function readAll(env) {
  try {
    const all = JSON.parse(fs.readFileSync(file(env), 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch { return {} }
}

/** The attestations kept for one app (its package or bundle id). */
export const readAttestations = (app, env = process.env) => readAll(env)[app] || {}

/** Records the owner's yes on a card that listed `asks` for `app`. Returns the ids recorded. */
export function recordAttestations({ app, regions, asks }, { by = 'the owner', on = new Date().toISOString().slice(0, 10), ref = '' } = {}, env = process.env) {
  if (!app || !Array.isArray(asks) || !asks.length) return []
  const made = attestationsFrom(asks, { by, on, regions, ref })
  const all = readAll(env)
  all[app] = { ...(all[app] || {}), ...made }
  const tmp = `${file(env)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file(env))
  return Object.keys(made)
}
