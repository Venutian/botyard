#!/usr/bin/env node
/**
 * Release step "Ready": everything a store would refuse, checked before anything is sent (docs/launch.md): the
 * listing against each store's limits, the store images at the sizes the stores take, the privacy and support
 * addresses, the build and its version code, and products for an app that takes payments. A fail goes back to
 * the crew with the list; what only the owner can do is said, not failed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseListing, readiness, readinessText } from '../../lib/release-checks.mjs'
import { playProductCount } from '../../lib/store-apis.mjs'
import { done, input, storeKey, storeTool, storesOf } from './release-lib.mjs'

const stores = storesOf()
const pkg = input('package')
const io = {
  answers: async (url) => { try { return (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })).ok } catch { return false } },
  fileSize: (file) => { try { return fs.statSync(file).size } catch { return 0 } },
  versionCode: () => input('build'),
  playHighestCode: async () => Math.max(0, ...(await storeTool('google-play', 'play_tracks', { packageName: pkg })).flatMap((t) => (t.releases || []).flatMap((r) => (r.versionCodes || []).map(Number)))),
  playProducts: async () => { const key = storeKey('google-play'); if (!key) throw new Error('no key'); return playProductCount(key, fetch, pkg) },
  dependencies: (folder) => {
    for (const where of [folder, path.join(folder || '', 'apps', 'mobile')]) {
      try { const p = JSON.parse(fs.readFileSync(path.join(where, 'package.json'), 'utf8')); return Object.keys({ ...p.dependencies, ...p.devDependencies }) } catch { /* next */ }
    }
    return []
  },
}
const result = await readiness({ listing: parseListing(input('listing')), artFolder: input('art'), aab: input('aab'), appFolder: process.env.BOTYARD_PROJECT_FOLDER || '', stores, io })
const text = readinessText(result)
done(result.ok
  ? { verdict: 'pass', leaves: { ready: text }, summary: `Ready: ${result.items.filter((i) => i.state === 'pass').length} checks pass.`, numbers: { checks: result.items.length } }
  : { verdict: 'fail', leaves: { ready: text }, findings: `Not ready. Fix these:\n${result.blocking.map((i) => `- ${i.group}: ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}` })
