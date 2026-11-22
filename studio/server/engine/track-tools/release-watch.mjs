#!/usr/bin/env node
/**
 * Release step "Watch the review": reads each store until the release is live or approved, or a store rejects it
 * (which goes back to the crew with the store's words). After its hours it ends and the Launch board keeps watching.
 */
import { appleState, playState } from '../../lib/launch.mjs'
import { done, input, storeTool, storesOf } from './release-lib.mjs'

const stores = storesOf()
const hours = Math.max(0.01, Number(input('watch_hours')) || 20)
const until = Date.now() + hours * 3600_000
const every = Math.max(5_000, Number(input('watch_every_ms')) || 10 * 60_000)
const read = async () => {
  const out = {}
  if (stores.includes('play')) out.play = playState(await storeTool('google-play', 'play_tracks', { packageName: input('package') }))
  if (stores.includes('appstore')) {
    const app = (await storeTool('app-store-connect', 'asc_apps', {})).find((a) => a.bundleId === input('bundle'))
    out.appstore = app ? appleState(await storeTool('app-store-connect', 'asc_versions', { appId: app.id }), []) : null
  }
  return out
}
for (;;) {
  let seen
  try { seen = await read() } catch (err) { seen = null; console.log(`Could not read the stores: ${err.message}`) }
  if (seen) {
    const lines = Object.entries(seen).filter(([, c]) => c).map(([s, c]) => `${s === 'play' ? 'Google Play' : 'App Store'}: ${c.state}`)
    const bad = Object.values(seen).find((c) => c?.tone === 'bad')
    if (bad) done({ verdict: 'fail', findings: `A store said no: ${lines.join('; ')}. ${bad.detail || ''}`.trim() })
    if (Object.values(seen).every((c) => !c || ['ok', 'look'].includes(c.tone) || /^Rolling out/.test(c.state))) done({ verdict: 'pass', leaves: { outcome: lines.join('\n') }, summary: lines.join('; ') })
    if (Date.now() > until) done({ verdict: 'pass', leaves: { outcome: `Still with the stores after ${hours} hours: ${lines.join('; ')}. The Launch board keeps watching.` }, summary: lines.join('; ') })
  }
  await new Promise((r) => setTimeout(r, every))
}
