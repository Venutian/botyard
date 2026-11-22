#!/usr/bin/env node
/**
 * Release step "Upload to testing": the Android App Bundle to Google Play's internal testing (testers only, never
 * the public); the iOS build reaches TestFlight through the app's own cloud build, which the build step says.
 */
import { done, input, storeTool, storesOf } from './release-lib.mjs'

const stores = storesOf()
const said = []
const leaves = {}
try {
  if (stores.includes('play')) {
    const aab = input('aab')
    if (!aab) done({ verdict: 'fail', findings: 'No Android App Bundle was left by the build step.' })
    const bundle = await storeTool('google-play', 'play_upload_bundle', { packageName: input('package'), path: aab })
    const code = String(bundle.versionCode || input('build'))
    await storeTool('google-play', 'play_release', { packageName: input('package'), track: 'internal', versionCodes: [code], status: 'completed', releaseNotes: input('notes') || undefined })
    leaves.play_code = code
    said.push(`Google Play: version code ${code} is on internal testing (testers only).`)
  }
  if (stores.includes('appstore')) {
    const ios = input('ios_build')
    said.push(ios && ios !== 'none' ? `App Store: build ${ios} was sent to TestFlight by the app's cloud build.` : 'App Store: no iOS build was made this time.')
  }
} catch (err) {
  done({ verdict: 'fail', findings: `The upload was refused: ${String(err.message || err).slice(0, 400)}` })
}
done({ verdict: 'pass', leaves: { uploaded: said.join('\n'), ...leaves }, summary: said.join(' ') })
