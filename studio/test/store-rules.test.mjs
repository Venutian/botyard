/** Store rules before a release (docs/launch.md): the playbook's scan blocks what a store would reject, the owner states
 * the rest on one card, and everything after that card runs by itself. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RULES_PIN, attestationsFrom, ensureRules, fleetFor, judge, rulesText, scanCopy, sweep, usableWaivers } from '../server/lib/store-rules.mjs'
import { readAttestations, recordAttestations } from '../server/lib/store-attestations.mjs'
import { RELEASE_TRACK, checkTrack } from '../server/engine/tracks.mjs'

const REGISTER = { requirements: [{ id: 'RR-EU-CRA-REPORTING', revision: 1, title: 'Report exploited vulnerabilities within 24 and 72 hours', jurisdiction: 'EU', proof_items: [{ id: 'owner-1', what: 'A named reporting owner and a timed drill' }] }] }
const app = (more = {}) => ({ apps: [{ name: 'com.example', regions: ['SE', 'US'], findings: [], waived: [], waiver_problems: [], owner_actions: [], register_blockers: [], coverage: { state: 'complete' }, guard_exit: 0, ...more }] })

test('a critical or high finding blocks; a medium one is a note; a scan that did not see the app blocks', () => {
  const high = judge(app({ findings: [{ severity: 'high', id: 'ANDROID-INSECURE-BACKUP', title: 'Backups on', file: 'AndroidManifest.xml:18', fix: 'Turn them off' }, { severity: 'medium', id: 'GOOGLE-12-TESTER-RULE', title: 'Testers' }] }), REGISTER)
  assert.equal(high.verdict, 'fail')
  assert.deepEqual(high.blocking.map((f) => f.id), ['ANDROID-INSECURE-BACKUP'])
  assert.deepEqual(high.notes.map((f) => f.id), ['GOOGLE-12-TESTER-RULE'])
  assert.match(rulesText(high), /Must be fixed:\n\[HIGH\] ANDROID-INSECURE-BACKUP: Backups on \(AndroidManifest.xml:18\)\n {4}Fix: Turn them off/)
  assert.equal(judge(app({ findings: [{ severity: 'medium', id: 'X' }] }), REGISTER).verdict, 'pass')
  const unseen = judge(app({ coverage: { state: 'partial', reason: 'no native project' } }), REGISTER)
  assert.equal(unseen.verdict, 'fail')
  assert.match(unseen.why, /did not see the whole app: no native project/)
  assert.equal(judge({ apps: [] }).verdict, 'fail')
})

test('what the owner states and does is on the card in plain words, and does not block the scan', () => {
  const j = judge(app({ register_blockers: ['RR-EU-CRA-REPORTING needs your attestation, which is missing. Report...'], owner_actions: ['play_data_safety_matches_runtime'] }), REGISTER)
  assert.equal(j.verdict, 'pass')
  const text = rulesText(j)
  assert.match(text, /Your yes also states that each of these is true:\n- Report exploited vulnerabilities within 24 and 72 hours: A named reporting owner and a timed drill/)
  assert.match(text, /Your yes also confirms these are done in the store consoles[^\n]*\n- Play Data safety answers match what the app collects/)
})

test('the crew may waive a high finding with evidence, never a critical one', () => {
  const { waivers, refused } = usableWaivers({ waivers: [
    { finding_id: 'A', severity: 'high', file: 'x', reason: 'test fixture', evidence: 'not in the release build', reviewed_by: 'Reviewer', expires: '2027-01-01' },
    { finding_id: 'B', severity: 'critical', file: 'y', reason: 'r', evidence: 'e', reviewed_by: 'Reviewer', expires: '2027-01-01' },
    { finding_id: 'C', severity: 'high', file: 'z', reason: 'r' },
  ] }, 'com.example')
  assert.deepEqual(waivers.map((w) => [w.finding_id, w.app]), [['A', 'com.example']])
  assert.equal(refused.length, 2)
  assert.match(refused[0], /critical finding is fixed, never waived/)
})

test('the owner\'s yes becomes attestations the sweep accepts, kept per app in the yard', () => {
  const asks = [{ id: 'RR-EU-CRA-REPORTING', revision: 1, title: 't', items: [{ id: 'owner-1', what: 'A drill' }] }]
  const made = attestationsFrom(asks, { by: 'the owner', on: '2026-11-24', regions: ['SE', 'DE'], ref: 'JOB-1' })
  assert.deepEqual(made['RR-EU-CRA-REPORTING'], { attested_by: 'the owner', attested_on: '2026-11-24', outcome: 'compliant', revision: 1, covers: ['owner-1'], regions: ['SE', 'DE'], evidence: "The owner's yes on the release card JOB-1, which listed: A drill" })
  const env = { ...process.env, BOTYARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'yard-')) }
  assert.deepEqual(recordAttestations({ app: 'com.example', regions: ['SE'], asks }, { ref: 'JOB-1', on: '2026-11-24' }, env), ['RR-EU-CRA-REPORTING'])
  assert.equal(readAttestations('com.example', env)['RR-EU-CRA-REPORTING'].covers[0], 'owner-1')
  assert.deepEqual(readAttestations('other', env), {})
  assert.deepEqual(recordAttestations({ app: 'com.example', asks: [] }, {}, env), [])
})

test('the scan copy leaves out dependencies, build output, worktrees and built packages', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))
  for (const f of ['app.json', 'android/app/src/main/AndroidManifest.xml', 'node_modules/x/index.js', '.botyard/worktrees/a/app.json', 'android/app/build/out.txt', 'app.aab']) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true })
    fs.writeFileSync(path.join(src, f), 'x')
  }
  const dest = scanCopy(src, path.join(os.tmpdir(), `scan-${process.pid}`))
  const all = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort()
  assert.deepEqual(all(dest), ['android/app/src/main/AndroidManifest.xml', 'app.json'])
})

test('the fleet names the platforms from the stores, and the default countries when the plan names none', () => {
  const f = fleetFor({ name: 'com.example', folder: '/x', stores: ['play', 'appstore'], regions: [], features: ['personal_data'] })
  assert.deepEqual(f.apps[0].platforms, ['android', 'ios'])
  assert.deepEqual(f.apps[0].regions, ['US', 'GB', 'DE', 'SE'])
  assert.deepEqual(fleetFor({ name: 'a', folder: '/x', stores: ['play'], regions: ['NO'] }).apps[0].regions, ['NO'])
  assert.deepEqual(Object.values(f.apps[0].readiness), [false, false, false, false, false, false], 'every console step is open until the owner\'s yes')
})

test('the playbook is fetched once at its pinned commit, and refused at any other', () => {
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rules-')), 'pb')
  let head = ''
  const calls = []
  const exec = (cmd, args) => {
    calls.push(args.join(' '))
    if (args.includes('rev-parse')) return { status: 0, stdout: head }
    if (args[0] === 'clone') fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
    if (args.includes('checkout')) head = RULES_PIN.commit
    return { status: 0, stdout: '' }
  }
  assert.equal(ensureRules(folder, { exec }), '')
  assert.ok(calls.some((c) => c.startsWith('clone') && c.includes(RULES_PIN.repo)))
  calls.length = 0
  assert.equal(ensureRules(folder, { exec }), '')
  assert.ok(!calls.some((c) => c.startsWith('clone')), 'not fetched again')
  const wrong = (cmd, args) => (args.includes('rev-parse') ? { status: 0, stdout: 'abc' } : { status: 0, stdout: '' })
  assert.match(ensureRules(folder, { exec: wrong }), /not at its pinned commit/)
  assert.match(ensureRules(folder, { exec: () => ({ status: 128, stderr: 'no network' }) }), /could not be fetched: no network/)
})

test('the sweep runs with the waivers and reads its answer and the register', () => {
  const rules = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'))
  fs.mkdirSync(path.join(rules, 'data'))
  fs.writeFileSync(path.join(rules, 'data', 'ruling-register.json'), JSON.stringify(REGISTER))
  let seen
  const exec = (cmd, args) => {
    seen = args
    fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(app()))
    return { status: 0 }
  }
  const out = sweep({ rules, app: fleetFor({ name: 'a', folder: '/x', stores: ['play'] }), waivers: [{ finding_id: 'A' }], exec })
  assert.equal(out.result.apps[0].name, 'com.example')
  assert.equal(out.register.requirements[0].id, 'RR-EU-CRA-REPORTING')
  assert.ok(seen.includes('--waivers'))
  assert.match(sweep({ rules, app: {}, exec: () => ({ status: 1, stdout: 'boom' }) }).error, /did not finish: boom/)
})

test('the release track: one owner card, every failure to the ruler, and everything after the card runs by itself', () => {
  const t = checkTrack(RELEASE_TRACK, { selfKey: 'release-app' })
  const order = t.steps.map((s) => s.id)
  assert.ok(order.indexOf('comply') < order.indexOf('upload') && order.indexOf('comply') < order.indexOf('owner'), 'the scan comes before any upload and the card')
  assert.deepEqual(t.lines.filter((l) => l.to === 'owner').map((l) => [l.from, l.on]), [['upload', 'pass']], 'the card is reached only when everything passed')
  assert.deepEqual(t.lines.filter((l) => l.to === 'decide').map((l) => [l.from, l.on]), [['rule', 'ask']], 'another question reaches the owner only when the ruler asks')
  assert.ok(t.lines.filter((l) => l.on === 'fail').every((l) => l.then !== 'owner' && l.to !== 'owner'), 'no failure lands on the owner')
  assert.deepEqual(t.lines.filter((l) => l.to === 'submit').map((l) => l.from), ['owner'])
  const after = ['submit', 'watch', 'live']
  assert.ok(after.every((id) => t.steps.find((s) => s.id === id).kind === 'script'), 'no bot and no gate after the card')
  assert.ok(t.steps.find((s) => s.id === 'owner').needs.includes('rules'), 'the card shows the store-rules result')
  assert.match(t.steps.find((s) => s.id === 'owner').words, /one yes/)
})
