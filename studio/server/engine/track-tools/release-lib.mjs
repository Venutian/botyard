/**
 * What the release track's scripts share: the step's inputs, the owner's store keys (read here by the engine's own
 * script, never typed by a bot), and how a step says its result. See docs/launch.md.
 */
import fs from 'node:fs'
import { readStore } from '../../lib/connectors.mjs'
import { BUILTINS } from '../../lib/store-apis.mjs'

export const input = (name) => String(process.env[`BOTYARD_IN_${name.toUpperCase()}`] || '').trim()

/** The saved key of a store connector, or null. */
export function storeKey(kind) {
  const found = Object.values(readStore().connectors).find((c) => c.auth === 'builtin' && c.builtin === kind && c.secret)
  return found ? found.secret : null
}

/** Run one of a store connector's tools with the owner's key. */
export async function storeTool(kind, name, args, fetcher = fetch) {
  const key = storeKey(kind)
  if (!key) throw new Error(`No ${BUILTINS[kind].name} key: add it on its row in Connectors`)
  return BUILTINS[kind].tools.find((t) => t.name === name).run(key, fetcher, args)
}

/** The stores this release goes to: those it has an id for. */
export const storesOf = () => [input('package') && 'play', input('bundle') && 'appstore'].filter(Boolean)

/** Say the step's result and end. */
export function done(out) {
  if (process.env.BOTYARD_STEP_OUT) fs.writeFileSync(process.env.BOTYARD_STEP_OUT, JSON.stringify(out))
  console.log(out.verdict === 'pass' ? out.summary || 'Done.' : out.findings)
  process.exit(0)
}
