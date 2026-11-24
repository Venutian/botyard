/**
 * The owner's statements per app (docs/store-rules.md): written when the owner says yes on a release card that listed
 * them, read by the next release's scan, so a statement is not asked again for a year or until its revision changes.
 * Kept in the yard's config, never in a repository.
 */
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from '../home.mjs'

const file = (env = process.env) => path.join(configDir(env), 'store-statements.json')

function readAll(env) {
  try {
    const all = JSON.parse(fs.readFileSync(file(env), 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch { return {} }
}

/** The statements kept for one app (its package or bundle id): { id: { revision, on, by, ref } }. */
export const keptFor = (app, env = process.env) => readAll(env)[app] || {}

/** Records the owner's yes on a card that listed `state` ([{ id, revision }]) for `app`. Returns the ids recorded. */
export function keep(app, state, { by = 'the owner', on = new Date().toISOString().slice(0, 10), ref = '' } = {}, env = process.env) {
  const list = (Array.isArray(state) ? state : []).filter((s) => s?.id)
  if (!app || !list.length) return []
  const all = readAll(env)
  all[app] = { ...(all[app] || {}), ...Object.fromEntries(list.map((s) => [s.id, { revision: s.revision, on, by, ref }])) }
  const tmp = `${file(env)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file(env))
  return list.map((s) => s.id)
}
