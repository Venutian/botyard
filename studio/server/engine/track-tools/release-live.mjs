#!/usr/bin/env node
/**
 * Release step "Go live", the last part of the owner's one yes (docs/launch.md): Google Play's staged rollout is raised
 * step by step (20%, then 50% after a day, then everyone after three) while the crash and ANR rates stay under Google's
 * own bad-behaviour lines; above a line the rollout is halted and the release goes to the ruler. The App Store needs
 * nothing here: the version was set to go live by itself once approved, phased over seven days by Apple.
 */
import { done, input, storeTool, storesOf } from './release-lib.mjs'

/** Google's bad-behaviour lines (Android vitals): user-perceived crash rate 1.09%, user-perceived ANR rate 0.47%. */
const LINES = { crash: 0.0109, anr: 0.0047 }
/** The rollout's steps: the share of users, and the hours since going live before it is reached. */
const STEPS = [{ share: 0.5, after: 24 }, { share: 1, after: 72 }]

const stores = storesOf()
const pkg = input('package')
const every = Math.max(5_000, Number(input('live_every_ms')) || 60 * 60_000)
const start = Date.now()
const said = []
if (stores.includes('appstore')) said.push('App Store: goes live by itself once Apple approves it, phased over seven days.')
if (!stores.includes('play')) done({ verdict: 'pass', leaves: { live: said.join('\n') }, summary: said.join(' ') })

const day = (t) => new Date(t).toISOString().slice(0, 10)
/** The worst user-perceived crash and ANR rates of the last days; null when Google has no numbers yet. */
async function rates() {
  try {
    const v = await storeTool('google-play', 'play_vitals', { packageName: pkg, from: day(Date.now() - 3 * 86400_000), to: day(Date.now() - 86400_000) })
    const worst = (rows, metric) => Math.max(0, ...rows.flatMap((r) => (r.metrics || []).filter((m) => m.metric === metric).map((m) => Number(m.decimalValue?.value) || 0)))
    return { crash: worst(v.crashes || [], 'userPerceivedCrashRate'), anr: worst(v.anrs || [], 'userPerceivedAnrRate') }
  } catch { return null }
}

for (;;) {
  const tracks = await storeTool('google-play', 'play_tracks', { packageName: pkg }).catch(() => null)
  const prod = (tracks || []).find((t) => t.track === 'production')?.releases || []
  const rolling = prod.find((r) => r.status === 'inProgress')
  const halted = prod.find((r) => r.status === 'halted')
  if (halted) done({ verdict: 'fail', findings: `Google Play: the rollout of ${halted.name || halted.versionCodes} is halted. ${said.join(' ')}` })
  if (!rolling && prod.some((r) => r.status === 'completed')) done({ verdict: 'pass', leaves: { live: [...said, 'Google Play: live for everyone.'].join('\n') }, summary: 'Live for everyone.' })
  if (rolling) {
    const share = Number(rolling.userFraction) || 0
    const hours = (Date.now() - start) / 3600_000
    const next = STEPS.find((s) => s.share > share && hours >= s.after)
    const r = await rates()
    if (r && (r.crash > LINES.crash || r.anr > LINES.anr)) {
      await storeTool('google-play', 'play_release', { packageName: pkg, track: 'production', versionCodes: rolling.versionCodes, status: 'halted' }).catch(() => {})
      done({ verdict: 'fail', findings: `Google Play: rollout halted at ${Math.round(share * 100)}%: crashes ${(r.crash * 100).toFixed(2)}% (line ${LINES.crash * 100}%), ANRs ${(r.anr * 100).toFixed(2)}% (line ${LINES.anr * 100}%).` })
    }
    if (next) {
      await storeTool('google-play', 'play_release', { packageName: pkg, track: 'production', versionCodes: rolling.versionCodes, status: next.share >= 1 ? 'completed' : 'inProgress', ...(next.share < 1 ? { userFraction: next.share } : {}) })
      console.log(`Google Play: raised to ${Math.round(next.share * 100)}%${r ? `, crashes ${(r.crash * 100).toFixed(2)}%` : ', Google has no crash numbers yet'}.`)
    }
  }
  await new Promise((resolve) => setTimeout(resolve, every))
}
