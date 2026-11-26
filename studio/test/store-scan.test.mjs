/** Botyard's store scan (docs/store-rules.md): its own rules over small apps made here, the waivers, the owner's part,
 * the card text, and the release track that runs it before the owner's one card. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appRootOf, configFromText, readApp, shippedOf } from '../server/lib/store-scan/app.mjs'
import { RULES, playTargetOn } from '../server/lib/store-scan/rules.mjs'
import { ownerPart, STATEMENTS } from '../server/lib/store-scan/owner.mjs'
import { readWaivers, scan, scanText } from '../server/lib/store-scan/index.mjs'
import { keep, keptFor } from '../server/lib/store-scan/kept.mjs'
import { RELEASE_TRACK, checkTrack } from '../server/engine/tracks.mjs'

const TODAY = '2026-11-24'
function app(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), typeof text === 'string' ? text : JSON.stringify(text))
  }
  return root
}
const MANIFEST = (extra = '', perms = []) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${perms.map((p) => `  <uses-permission android:name="${p}"/>`).join('\n')}\n  <application android:allowBackup="false" ${extra}>\n  </application>\n</manifest>`
const GRADLE = (target = 36) => `android {\n  defaultConfig { targetSdkVersion ${target} }\n  buildTypes { release { minifyEnabled true } }\n}`
/** A small Android app with a privacy link, nothing wrong with it. */
const clean = (more = {}) => ({
  'package.json': { main: 'index.js', dependencies: { 'react-native': '0.79.0' } },
  'index.js': "import App from './App'\n",
  'App.tsx': "import { Settings } from './src/Settings'\nexport default function App() { return <Settings /> }\n",
  'src/Settings.tsx': "export const Settings = () => <Text>Privacy policy</Text>\n",
  'android/app/src/main/AndroidManifest.xml': MANIFEST(),
  'android/app/build.gradle': GRADLE(),
  ...more,
})
const ids = (r) => r.blocking.map((f) => f.rule)

test('a clean app passes, and its card says nothing blocks', () => {
  const r = scan(app(clean()), { stores: ['play'], regions: ['SE'], today: TODAY })
  assert.equal(r.verdict, 'pass', scanText(r))
  assert.match(scanText(r), /^Store rules: nothing blocks\./)
})

test("Play's minimum target level follows the date, and an app below it is a stop", () => {
  assert.equal(playTargetOn('2026-08-30'), 35)
  assert.equal(playTargetOn('2026-08-31'), 36)
  const r = scan(app(clean({ 'android/app/build.gradle': GRADLE(35) })), { stores: ['play'], today: TODAY })
  const f = r.blocking.find((x) => x.rule === 'play.target-api')
  assert.equal(f.level, 'stop')
  assert.match(f.detail, /targets 35; Play asks for 36/)
})

test('a debuggable release, a secret key and plain http are found where they are', () => {
  const r = scan(app(clean({
    'android/app/src/main/AndroidManifest.xml': MANIFEST('android:debuggable="true" android:usesCleartextTraffic="true"'),
    'src/Settings.tsx': "const KEY = 'sk_live_abcdefghijklmnop'\nexport const Settings = () => <Text>Privacy</Text>\n",
  })), { stores: ['play'], today: TODAY })
  assert.deepEqual(ids(r).sort(), ['android.cleartext', 'android.debuggable', 'secret.in-app'])
  assert.equal(r.blocking.find((f) => f.rule === 'secret.in-app').file, 'src/Settings.tsx')
  assert.equal(r.blocking.find((f) => f.rule === 'android.debuggable').line, 3)
})

test('a restricted Android permission asks for its declaration; a normal one does not', () => {
  const r = scan(app(clean({ 'android/app/src/main/AndroidManifest.xml': MANIFEST('', ['android.permission.QUERY_ALL_PACKAGES', 'android.permission.INTERNET']) })), { stores: ['play'], today: TODAY })
  assert.deepEqual(ids(r), ['play.restricted.query_all_packages'])
})

test('iOS: a package that touches the camera needs its purpose string, which a config plugin may write, and it must say why', () => {
  const ios = (expo) => app({ 'package.json': { main: 'index.js', dependencies: { expo: '54.0.0', 'expo-camera': '1' } }, 'index.js': "import './x'\n", 'x.tsx': '<Text>privacy</Text>', 'app.json': { expo: { ios: { bundleIdentifier: 'com.example.a', privacyManifests: {}, ...expo.ios }, plugins: expo.plugins || [] } } })
  assert.ok(ids(scan(ios({}), { stores: ['appstore'], today: TODAY })).includes('apple.purpose.camera'))
  assert.ok(!ids(scan(ios({ plugins: ['expo-camera'] }), { stores: ['appstore'], today: TODAY })).includes('apple.purpose.camera'))
  const vague = scan(ios({ ios: { infoPlist: { NSCameraUsageDescription: 'Not used.' } } }), { stores: ['appstore'], today: TODAY })
  assert.ok(!ids(vague).includes('apple.purpose.camera'))
  assert.match(vague.blocking.find((f) => f.rule === 'apple.purpose-vague').detail, /NSCameraUsageDescription: "Not used\."/)
})

test('only code the app ships is read: build scripts and a server beside it are not', () => {
  const root = app(clean({ 'scripts/shot.mjs': "fetch('http://localhost:9000/api')", 'server/routes.ts': 'app.post("/signup")', 'src/unused.ts': "const API_URL = 'http://localhost:3000'" }))
  const a = readApp(root)
  assert.equal(a.shippedFrom, 'imports')
  assert.deepEqual(a.source.map((f) => f.file).sort(), ['App.tsx', 'index.js', 'src/Settings.tsx'])
  assert.equal(scan(root, { stores: ['play'], today: TODAY }).verdict, 'pass')
  const used = app(clean({ 'src/Settings.tsx': "const API_URL = 'http://10.0.2.2:3000'\nexport const Settings = () => <Text>Privacy</Text>" }))
  assert.deepEqual(ids(scan(used, { stores: ['play'], today: TODAY })), ['both.server-address'])
  assert.deepEqual([...shippedOf(root, ['App.tsx'], {})], ['App.tsx'])
})

test('the app in a monorepo is found, and a JavaScript config is read without running it', () => {
  const root = app({ 'package.json': { private: true }, 'app.json': { expo: { ios: { bundleIdentifier: 'com.example.m' } } }, 'apps/mobile/package.json': { dependencies: { expo: '54.0.0' } }, 'apps/mobile/app.config.js': "module.exports = { expo: { android: { package: 'com.example.m', permissions: ['CAMERA'] }, ios: { infoPlist: { NSCameraUsageDescription: 'Scan a receipt to add it to your expenses', ITSAppUsesNonExemptEncryption: false } }, plugins: [\n      'expo-router',\n      ['expo-camera', {}],\n    ],\n  } }\n" })
  assert.equal(appRootOf(root), path.join(root, 'apps', 'mobile'))
  const a = readApp(root)
  assert.equal(a.appDir, path.join('apps', 'mobile'))
  assert.equal(a.expo.config.ios.bundleIdentifier, 'com.example.m', 'the root app.json is the base')
  assert.equal(a.plist.keys.ITSAppUsesNonExemptEncryption, false)
  assert.deepEqual(a.androidPermissions, ['android.permission.CAMERA'])
  assert.deepEqual(configFromText("plugins: [\n  'expo-router',\n  ['expo-camera', {}],\n],\n").plugins, ['expo-router', 'expo-camera'])
})

test('an app with accounts needs a way to delete one; payments need restore; children need no trackers', () => {
  const r = scan(app(clean({ 'package.json': { main: 'index.js', dependencies: { 'react-native': '0.79.0', 'react-native-purchases': '8', 'react-native-google-mobile-ads': '14' } }, 'src/Settings.tsx': "auth.signUp(email)\nexport const Settings = () => <Text>Privacy</Text>" })), { stores: ['play'], features: ['kids'], today: TODAY })
  assert.deepEqual(ids(r).sort(), ['both.account-deletion', 'both.restore-purchases', 'kids.ads-or-tracking'])
})

test('a waiver with proof covers a fix at its file, never a stop, and never past 180 days', () => {
  const root = app(clean({ 'android/app/src/main/AndroidManifest.xml': MANIFEST('android:usesCleartextTraffic="true" android:debuggable="true"') }))
  const w = (rule, until = '2027-01-31') => ({ rule, file: 'android/app/src/main/AndroidManifest.xml', why: 'it talks to a PC on the home network', proof: 'the only http address is the paired PC', by: 'Reviewer', until })
  const r = scan(root, { stores: ['play'], today: TODAY, waivers: [w('android.cleartext'), w('android.debuggable')] })
  assert.deepEqual(r.waived.map((x) => x.rule), ['android.cleartext'])
  assert.deepEqual(ids(r), ['android.debuggable'])
  assert.match(r.refused.join('\n'), /android\.debuggable: a stop is fixed, never waived/)
  const { refused } = readWaivers([w('a', '2026-01-01'), w('b', '2028-01-01'), { rule: 'c' }], TODAY)
  assert.deepEqual(refused.map((x) => x.split(':')[0]), ['a', 'b', 'c'])
  assert.match(scanText(r), /Waived by the crew, with proof:\n- Plain http traffic is allowed/)
})

test("the owner's part: statements by country and feature from their day, console forms per store, what is coming", () => {
  const eu = ownerPart({ regions: ['SE'], features: ['ai'], stores: ['play'], today: TODAY })
  assert.deepEqual(eu.state.map((s) => s.id).sort(), ['eu-ai-transparency', 'eu-security-reporting', 'eu-trader', 'privacy-policy'])
  assert.ok(eu.console.some((c) => c.id === 'play-data-safety'))
  assert.ok(!eu.console.some((c) => c.id === 'apple-privacy'))
  const us = ownerPart({ regions: ['US'], features: [], stores: ['appstore'], today: TODAY })
  assert.deepEqual(us.state.map((s) => s.id), ['privacy-policy'])
  assert.deepEqual(us.coming.map((c) => c.on), ['2027-01-01'])
  const kept = { 'privacy-policy': { revision: 1, on: '2026-06-01' } }
  assert.deepEqual(ownerPart({ regions: ['US'], features: [], stores: ['appstore'], today: TODAY, kept }).standing, ['privacy-policy'])
  assert.deepEqual(ownerPart({ regions: ['US'], features: [], stores: ['appstore'], today: '2027-07-01', kept }).standing, [], 'a year later it is asked again')
})

test("the owner's yes is kept per app in the yard", () => {
  const env = { ...process.env, BOTYARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'yard-')) }
  assert.deepEqual(keep('com.example.a', [{ id: 'privacy-policy', revision: 1 }], { on: TODAY, ref: 'JOB-1' }, env), ['privacy-policy'])
  assert.deepEqual(keptFor('com.example.a', env), { 'privacy-policy': { revision: 1, on: TODAY, by: 'the owner', ref: 'JOB-1' } })
  assert.deepEqual(keep('', [{ id: 'x' }], {}, env), [])
})

test('every rule and statement says its fix or words and links an official page', () => {
  for (const r of RULES) {
    assert.ok(['stop', 'fix', 'look'].includes(r.level), r.id)
    assert.ok(r.title && r.fix && /^https:\/\//.test(r.source), r.id)
  }
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, 'rule ids are unique')
  for (const s of STATEMENTS) assert.ok(s.says && /^\d{4}-\d{2}-\d{2}$/.test(s.from) && /^https:\/\//.test(s.source), s.id)
})

test('the release track: the scan before the one card, every failure to the ruler, everything after the card by itself', () => {
  const t = checkTrack(RELEASE_TRACK, { selfKey: 'release-app' })
  const order = t.steps.map((s) => s.id)
  assert.ok(order.indexOf('comply') < order.indexOf('upload'))
  assert.deepEqual(t.lines.filter((l) => l.to === 'owner').map((l) => [l.from, l.on]), [['upload', 'pass']])
  assert.deepEqual(t.lines.filter((l) => l.to === 'decide').map((l) => [l.from, l.on]), [['rule', 'ask']])
  assert.ok(t.lines.filter((l) => l.on === 'fail').every((l) => l.then !== 'owner' && l.to !== 'owner'))
  assert.ok(['submit', 'watch', 'live'].every((id) => t.steps.find((s) => s.id === id).kind === 'script'))
  assert.deepEqual(t.steps.find((s) => s.id === 'comply').leaves, ['rules', 'statements'])
  assert.ok(t.steps.find((s) => s.id === 'owner').needs.includes('rules'))
})

test('listing words the stores refuse: rank and price words, emoji and capitals on Play; the other platform; keyword stuffing', async () => {
  const { checkListingWords } = await import('../server/lib/release-checks.mjs')
  const bad = checkListingWords({ play: { title: 'Best Free Fasting 🔥', short: 'Track fasts', full: 'Also on iPhone' }, appstore: { name: 'Fast, Diet, Timer', subtitle: 'Track', description: 'Get it on Google Play too', keywords: 'fast,timer,timer' } }, ['play', 'appstore'])
  const said = bad.map((i) => i.text).join('\n')
  for (const words of ['Play title: no rank, price or promotion words', 'Play title: no emoji', 'Play full: does not name Apple platforms', 'App Store description: does not name other platforms', 'App Store name: reads as a name', 'App Store keywords: leave out words already in the name', 'App Store keywords: each keyword once']) assert.ok(said.includes(words), words)
  assert.deepEqual(checkListingWords({ play: { title: 'Fasten: fasting timer', short: 'Track your fasts' }, appstore: { name: 'Fasten', subtitle: 'Fasting timer', description: 'Track fasts.', keywords: 'fasting,intermittent' } }, ['play', 'appstore']), [])
})

test('docs/store-rules.md names every rule and every statement', () => {
  const doc = fs.readFileSync(new URL('../../docs/store-rules.md', import.meta.url), 'utf8')
  for (const r of RULES) assert.ok(doc.includes(`\`${r.id}\``), `${r.id} is in docs/store-rules.md`)
  for (const s of STATEMENTS) assert.ok(doc.includes(s.title), `${s.id} is in docs/store-rules.md`)
})
