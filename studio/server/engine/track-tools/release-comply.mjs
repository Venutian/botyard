#!/usr/bin/env node
/**
 * Release step "Scan against the store rules" (docs/store-rules.md): Botyard's own store scan over the built app. A
 * stop, or a fix no proven waiver covers, sends the release back to the builder with each finding and its fix; what
 * only the owner can state or do is left for the owner's one card.
 */
import { scan, scanText, waiversIn } from '../../lib/store-scan/index.mjs'
import { keptFor } from '../../lib/store-scan/kept.mjs'
import { done, input, storesOf } from './release-lib.mjs'

const stores = storesOf()
const appId = input('package') || input('bundle')
if (!stores.length) done({ verdict: 'fail', findings: 'No store to check for: the release names neither a Play package nor an App Store bundle id.' })
const folder = process.cwd()
const list = (name) => input(name).split(',').map((s) => s.trim()).filter(Boolean)
const regions = list('regions').map((r) => r.toUpperCase())
const r = scan(folder, { stores, regions: regions.length ? regions : ['US', 'GB', 'DE', 'SE'], features: list('features'), waivers: waiversIn(folder), kept: keptFor(appId) })
const text = scanText(r)
const statements = JSON.stringify({ app: appId, state: r.state.map((s) => ({ id: s.id, revision: s.revision })) })
done(r.verdict === 'pass'
  ? { verdict: 'pass', leaves: { rules: text, statements }, summary: `Store rules: nothing blocks (${r.notes.length} to look at, ${r.state.length} for you to state).`, numbers: { blocking: 0, waived: r.waived.length } }
  : { verdict: 'fail', leaves: { rules: text }, findings: `${text}\n\nFix each one in the app. For a FIX you can prove does not apply, add a waiver to store/waivers.json: { "rule": "<rule id>", "file": "<file as above>", "why", "proof", "by", "until": "<date within 180 days>" }. The rule ids are in docs/store-rules.md. A STOP is fixed, never waived.` })
