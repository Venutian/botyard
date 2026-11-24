#!/usr/bin/env node
/**
 * Release step "Store rules": the App Store Compliance Playbook's guard over the built app (docs/launch.md). A critical
 * or high finding no reviewed waiver covers sends the release back to the builder with each finding and its fix; what
 * the law asks the owner to state, and the console steps only the owner can do, are left for the owner's one card.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureRules, fleetFor, judge, rulesFolder, rulesText, scanCopy, sweep, usableWaivers } from '../../lib/store-rules.mjs'
import { readAttestations } from '../../lib/store-attestations.mjs'
import { done, input, storesOf } from './release-lib.mjs'

const stores = storesOf()
const appId = input('package') || input('bundle')
const folder = process.cwd()
if (!stores.length) done({ verdict: 'fail', findings: 'No store to check for: the release names neither a Play package nor an App Store bundle id.' })
const missing = ensureRules(rulesFolder())
if (missing) done({ verdict: 'fail', findings: `${missing}. Store rules were not checked, so the release does not go on.` })

// The crew's waivers live with the app, so they are reviewed with it: store/waivers.json.
let written = []
try { written = JSON.parse(fs.readFileSync(path.join(folder, 'store', 'waivers.json'), 'utf8')) } catch { /* none */ }
const { waivers, refused } = usableWaivers(written, appId)
const copy = scanCopy(folder, fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-scan-')))
const regions = input('regions').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
const features = input('features').split(',').map((s) => s.trim()).filter(Boolean)
const ran = sweep({ app: fleetFor({ name: appId, folder: copy, stores, regions, features, attestations: readAttestations(appId) }), waivers })
fs.rmSync(copy, { recursive: true, force: true })
if (ran.error) done({ verdict: 'fail', findings: `${ran.error}. Store rules were not checked, so the release does not go on.` })

const j = judge(ran.result, ran.register)
if (refused.length) j.waiverProblems.push(...refused)
const text = rulesText(j)
const attest = JSON.stringify({ app: appId, regions: ran.result.apps[0].regions, asks: j.attest })
done(j.verdict === 'pass'
  ? { verdict: 'pass', leaves: { rules: text, attest }, summary: `Store rules: nothing blocks (${j.notes.length} to look at, ${j.attest.length} for you to state).`, numbers: { blocking: 0, waived: j.waived.length } }
  : { verdict: 'fail', leaves: { rules: text }, findings: `${text}\n\nFix each one in the app, or, for a high finding you can prove false, add a waiver to store/waivers.json with the finding id, severity and file exactly as above, a reason, evidence, reviewed_by and an expiry within 180 days. A critical finding is never waived.` })
