/** The Launch page (lib/launch.mjs, docs/launch.md): each channel read as one plain state, never shown as live unread. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appleState, checkAll, githubState, launchPage, playState, readState, tellState } from '../server/lib/launch.mjs'

const NOW = Date.parse('2026-11-18T20:00:00Z')
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('Google Play\'s tracks read as one state: a draft waits for the owner, a rollout says its share, testing waits for the crew', () => {
  assert.equal(playState([]).state, 'Nothing uploaded yet')
  const internal = playState([{ track: 'internal', releases: [{ name: '2.0.1', versionCodes: ['17'], status: 'completed' }] }])
  assert.equal(internal.state, 'Internal testing 2.0.1 (17)')
  assert.equal(internal.waits, 'crew')
  const draft = playState([{ track: 'production', releases: [{ name: '2.0.1', versionCodes: ['17'], status: 'draft' }, { name: '2.0.0', status: 'completed' }] }])
  assert.equal(draft.state, 'Production draft 2.0.1 (17)')
  assert.equal(draft.waits, 'owner')
  const rolling = playState([{ track: 'production', releases: [{ name: '2.0.1', status: 'inProgress', userFraction: 0.2 }] }])
  assert.equal(rolling.state, 'Rolling out 2.0.1 to 20%')
  assert.match(rolling.detail, /Google does not say whether a release is in review/)
  assert.equal(playState([{ track: 'production', releases: [{ name: '2.0.0', status: 'completed' }] }]).state, 'Live 2.0.0')
  // A release named with its code says the code once.
  assert.equal(playState([{ track: 'production', releases: [{ name: '44 (1.0.0)', versionCodes: ['44'], status: 'completed' }] }]).state, 'Live 44 (1.0.0)')
  assert.equal(playState([{ track: 'production', releases: [{ name: '2.0.1', status: 'halted' }] }]).tone, 'bad')
})

test('the App Store\'s newest version reads as its review state, with the newest build beside it', () => {
  assert.equal(appleState([], []).state, 'No version yet')
  const waiting = appleState([{ versionString: '2.0.1', appStoreState: 'WAITING_FOR_REVIEW' }], [{ version: '17', processingState: 'VALID' }])
  assert.equal(waiting.state, 'Waiting for review 2.0.1')
  assert.equal(waiting.waits, 'store')
  assert.match(waiting.detail, /Newest build 17: valid/)
  assert.equal(appleState([{ versionString: '2.0.1', appStoreState: 'PENDING_DEVELOPER_RELEASE' }]).waits, 'owner')
  assert.equal(appleState([{ versionString: '2.0.1', appStoreState: 'REJECTED' }]).waits, 'crew')
})

test('a GitHub draft waits for the owner\'s yes; a published release is shown as published', () => {
  assert.equal(githubState([]).state, 'No release yet')
  const draft = githubState([{ draft: true, tag_name: 'v1.9.0' }, { draft: false, tag_name: 'v1.8.0' }])
  assert.equal(draft.state, 'Draft v1.9.0 waits for you')
  assert.equal(draft.waits, 'owner')
  assert.equal(githubState([{ draft: false, tag_name: 'v1.8.0' }]).state, 'Published v1.8.0')
})

test('a check reads every channel, says "not known" without a key, keeps what people told, and writes each change to the history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'))
  const file = path.join(dir, 'state.json')
  const plan = {
    found: true,
    products: [
      { name: 'Lamp', kind: 'app', channels: { play: { package: 'com.example.lamp' }, appstore: { bundle: 'com.example.lamp' } } },
      { name: 'Site', kind: 'web', channels: { web: { url: 'https://example.test/' }, github: { repo: 'acme/site' } } },
      { name: 'Quest', kind: 'game', channels: { steam: { missing: 'the Steam app id' }, crazygames: { told: true } } },
    ],
  }
  const fetcher = async (url) => {
    if (url === 'https://example.test/') return new Response('<html>', { status: 200 })
    if (url === 'https://example.test/version.json') return json({ version: '3.1.0' })
    if (url.startsWith('https://api.github.com/repos/acme/site/releases')) return json([{ draft: true, tag_name: 'v3.2.0' }, { draft: false, tag_name: 'v3.1.0' }])
    return json({}, 404)
  }
  const state = await checkAll({ fetcher, useGh: false, now: NOW, plan, file, keys: {} })
  // No store key: the cell is not known, and waits on the owner's key, never shown as live.
  assert.equal(state.cells['Lamp|play'].state, 'Not known: no Google Play key')
  assert.equal(state.cells['Lamp|play'].how, 'none')
  assert.equal(state.cells['Lamp|appstore'].waits, 'owner')
  assert.equal(state.cells['Site|web'].state, 'Live 3.1.0')
  assert.equal(state.cells['Site|github'].state, 'Draft v3.2.0 waits for you')
  assert.equal(state.cells['Quest|steam'].state, 'Not set up')
  assert.equal(state.cells['Quest|crazygames'].state, 'Not told yet')
  assert.equal(state.history.length, 6)
  // A channel with no API is told by a person, kept with its age, and turns amber after a week.
  tellState({ product: 'Quest', channel: 'crazygames', state: 'Basic launch, day 3', tone: 'go' }, { now: NOW, file, plan })
  assert.throws(() => tellState({ product: 'Quest', channel: 'poki', state: 'x' }, { now: NOW, file, plan }), /no such channel/)
  const again = await checkAll({ fetcher, useGh: false, now: NOW + 8 * 24 * 3600_000, plan, file, keys: {} })
  assert.equal(again.cells['Quest|crazygames'].state, 'Basic launch, day 3')
  assert.equal(again.cells['Quest|crazygames'].how, 'told')
  assert.equal(again.cells['Quest|crazygames'].tone, 'look')
  // Nothing else changed, so the history has only the telling.
  assert.equal(readState(file).history.length, 7)
  // The page: a column per channel in use, the next step and who it waits on, and the readiness list.
  const page = launchPage({ plan, state: readState(file), keys: {}, now: NOW })
  assert.deepEqual(page.channels.map((c) => c.id), ['play', 'appstore', 'web', 'github', 'steam', 'crazygames'])
  const lamp = page.rows.find((r) => r.name === 'Lamp')
  assert.equal(lamp.cells.web, null)
  assert.deepEqual(lamp.next, { channel: 'Google Play', text: 'Add the Google Play key on its row in Connectors', waits: 'you' })
  assert.ok(lamp.readiness.some((i) => i.text === 'Google Play key added' && i.state === 'yours'))
  assert.ok(lamp.readiness.some((i) => i.group === 'Payments' && i.state === 'unknown'))
  assert.equal(page.rows.find((r) => r.name === 'Site').next.waits, 'you')
})

test('the board draws a column per channel and a row per product; an unread cell has no colour of its own', async () => {
  const { launchScreen, productScreen } = await import('../src/ui/studio-launch.js')
  const data = {
    planFound: true, planFile: '~/.botyard/launch-plan.json', checkedAt: NOW,
    channels: [{ id: 'play', name: 'Google Play' }, { id: 'web', name: 'Web' }],
    rows: [{ name: 'Lamp', note: '', next: { channel: 'Google Play', text: 'Add the Google Play key on its row in Connectors', waits: 'you' },
      cells: { play: { state: 'Not known: no Google Play key', how: 'none', tone: 'wait', checkedAt: NOW }, web: null },
      readiness: [{ group: 'Keys', text: 'Google Play key added', state: 'yours', detail: 'Add it once on its row in Connectors' }], history: [] }],
  }
  const board = launchScreen(data)
  assert.match(board, /<th>Google Play<\/th><th>Web<\/th>/)
  assert.match(board, /class="cell wait how-none">Not known: no Google Play key/)
  assert.match(board, /Waits for you/)
  assert.match(board, /data-act="launch-check"/)
  const page = productScreen(data, 'Lamp')
  assert.match(page, /<span class="mark">Yours<\/span>Google Play key added/)
  // A channel that cannot be read can be told where it stands.
  assert.match(page, /data-part="launch-tell"/)
  assert.match(launchScreen({ planFound: false, planFile: '~/x.json' }), /No launch plan yet/)
})

test('a store that refuses the key for one app says which step fixes it, and waits on the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'))
  const plan = { found: true, products: [{ name: 'Lamp', kind: 'app', channels: { play: { package: 'com.example.lamp' } } }] }
  const fetcher = async (url) => (String(url).includes('oauth2') ? json({ access_token: 't', expires_in: 3600 }) : json({ error: { message: 'The caller does not have permission' } }, 403))
  const key = { secret: { account: { client_email: 'bot@example.iam', private_key: (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }, packageName: '' } }
  const state = await checkAll({ fetcher, useGh: false, now: NOW, plan, file: path.join(dir, 's.json'), keys: { play: key } })
  const c = state.cells['Lamp|play']
  assert.equal(c.state, 'Not known: the key may not see this app')
  assert.equal(c.waits, 'owner')
  assert.match(c.next, /give the key's service account access to com\.example\.lamp/)
  assert.match(c.detail, /403/)
})
