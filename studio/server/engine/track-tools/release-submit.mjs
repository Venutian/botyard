#!/usr/bin/env node
/**
 * Release step "Send for review", after the owner's yes: the listing text goes onto each store, then Google Play gets
 * a production release (a staged rollout, which Google reviews first) and the App Store version is set to go live by
 * itself once approved, as a phased release, and sent to Apple. The same yes states what the card listed from the
 * store-rules register; it is recorded first, so the next release does not ask again.
 */
import { parseListing } from '../../lib/release-checks.mjs'
import { recordAttestations } from '../../lib/store-attestations.mjs'
import { done, input, storeTool, storesOf } from './release-lib.mjs'

const stores = storesOf()
const listing = parseListing(input('listing')) || {}
const share = Math.min(1, Math.max(0.01, Number(input('rollout')) || 0.2))
const said = []
try {
  const attest = JSON.parse(input('attest') || '{}')
  const stated = recordAttestations(attest, { ref: process.env.BOTYARD_REQUEST_JOB || '' })
  if (stated.length) said.push(`Recorded your statements: ${stated.join(', ')}.`)
} catch { /* nothing to record */ }
try {
  if (stores.includes('play')) {
    const pkg = input('package')
    const code = input('play_code')
    if (!code) done({ verdict: 'fail', findings: 'Nothing was uploaded to Play to send.' })
    const play = listing.play || {}
    if (play.title || play.short || play.full) await storeTool('google-play', 'play_edit_listing', { packageName: pkg, language: listing.language || 'en-US', title: play.title, shortDescription: play.short, fullDescription: play.full })
    await storeTool('google-play', 'play_release', { packageName: pkg, track: 'production', versionCodes: [code], status: share >= 1 ? 'completed' : 'inProgress', userFraction: share, releaseNotes: play.whatsNew || listing.whatsNew || undefined })
    said.push(`Google Play: version code ${code} sent to production, rolling out to ${Math.round(share * 100)}% once Google has reviewed it.`)
  }
  if (stores.includes('appstore')) {
    const app = (await storeTool('app-store-connect', 'asc_apps', {})).find((a) => a.bundleId === input('bundle'))
    if (!app) done({ verdict: 'fail', findings: 'The App Store has no app with this bundle id: create its record in App Store Connect first.' })
    const version = (await storeTool('app-store-connect', 'asc_versions', { appId: app.id })).find((v) => (v.appStoreState || v.appVersionState) === 'PREPARE_FOR_SUBMISSION')
    if (!version) done({ verdict: 'fail', findings: `No App Store version is being prepared for ${app.name}: make version ${input('version') || 'the new one'} in App Store Connect and attach the TestFlight build, then send it again.` })
    await storeTool('app-store-connect', 'asc_release_after_approval', { versionId: version.id })
    await storeTool('app-store-connect', 'asc_submit_for_review', { appId: app.id, versionId: version.id })
    said.push(`App Store: version ${version.versionString} sent to Apple for review; it goes live by itself once approved, phased over seven days.`)
  }
} catch (err) {
  done({ verdict: 'fail', findings: `The store refused: ${String(err.message || err).slice(0, 400)}` })
}
done({ verdict: 'pass', leaves: { sent: said.join('\n') }, summary: said.join(' ') })
