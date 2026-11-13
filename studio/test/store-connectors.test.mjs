import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { addConnector, connectorList, gateway, readStore, setAccess, settleHeld } from '../server/lib/connectors.mjs'
import { appleToken, googleToken, runBuiltin } from '../server/lib/store-apis.mjs'

const CREW = [{ id: 'bot-lead', name: 'Lead' }, { id: 'bot-pub', name: 'Publisher' }]
const room = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-'))
  return { folder: path.join(dir, 'keys'), out: path.join(dir, 'bots') }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const parts = (jwt) => jwt.split('.').map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, 'base64url')) : p))

// ── stand-in keys and stores ─────────────────────────────────────────────────────────

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' })
const APPLE = { issuerId: '57246542-96fe-1a63-e053-0824d011072a', keyId: '2X9R4HXF34', privateKey: P8 }

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const ACCOUNT = { type: 'service_account', client_email: 'publisher@yard-test.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' } // a made-up service account. release-check: allow

/** App Store Connect, as far as these tools ask it: checks the token on every call. */
function appleStore() {
  const seen = []
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    const token = String(init.headers?.Authorization || '').replace('Bearer ', '')
    const [head, body, signature] = token.split('.')
    const ok = head && crypto.verify('sha256', Buffer.from(`${head}.${body}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    if (!ok) return json({ errors: [{ title: 'Unauthorized' }] }, 401)
    seen.push({ method: init.method || 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : null })
    if (u.pathname === '/v1/apps') return json({ data: [{ id: '1234', type: 'apps', attributes: { name: 'Tide Tables', bundleId: 'com.example.tides' } }] })
    if (u.pathname === '/v1/apps/1234/customerReviews') return json({ data: [{ id: 'r1', type: 'customerReviews', attributes: { rating: 2, title: 'Crashes', body: 'It crashes on start' } }] })
    if (u.pathname === '/v1/salesReports') return new Response(zlib.gzipSync('Provider\tUnits\tCountry Code\nAPPLE\t12\tUS\nAPPLE\t3\tDE\n'), { headers: { 'Content-Type': 'application/a-gzip' } })
    if (u.pathname === '/v1/customerReviewResponses' && init.method === 'POST') return json({ data: { id: 'resp1', type: 'customerReviewResponses' } }, 201)
    return json({ errors: [{ title: 'Not found' }] }, 404)
  }
  return { fetcher, seen }
}

/** Google's token endpoint and the Play Developer API, as far as these tools ask them. */
function playStore() {
  const seen = []
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    if (url === ACCOUNT.token_uri) {
      const assertion = new URLSearchParams(String(init.body)).get('assertion')
      const [head, body, signature] = assertion.split('.')
      const ok = crypto.verify('sha256', Buffer.from(`${head}.${body}`), rsa.publicKey, Buffer.from(signature, 'base64url'))
      seen.push({ token: parts(assertion)[1] })
      return ok ? json({ access_token: 'play-token', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400)
    }
    if (init.headers?.Authorization !== 'Bearer play-token') return json({ error: { message: 'no' } }, 401)
    seen.push({ method: init.method || 'GET', path: u.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    const app = '/androidpublisher/v3/applications/com.example.tides'
    if (u.pathname === `${app}/reviews`) return json({ reviews: [{ reviewId: 'g1', comments: [{ userComment: { text: 'Love it', starRating: 5 } }] }] })
    if (u.pathname === `${app}/edits` && init.method === 'POST') return json({ id: 'edit-1' })
    if (u.pathname === `${app}/edits/edit-1/tracks`) return json({ tracks: [{ track: 'production', releases: [{ versionCodes: ['41'], status: 'completed' }] }] })
    if (u.pathname === `${app}/edits/edit-1` && init.method === 'DELETE') return new Response(null, { status: 204 })
    if (u.pathname === `${app}/edits/edit-1/tracks/production` && init.method === 'PUT') return json({ track: 'production' })
    if (u.pathname === `${app}/edits/edit-1:commit`) return json({ id: 'edit-1' })
    return json({ error: { message: 'not found' } }, 404)
  }
  return { fetcher, seen }
}

/** Cards as the engine keeps them: put on the bot's job; the bot told there. */
const cards = () => {
  const seen = { cards: [], told: [] }
  return { seen, place: async (c) => { const card = `card-${seen.cards.length + 1}`; seen.cards.push({ ...c, card }); return { job: 'job-1', card } }, tell: async (job, text) => { seen.told.push({ job, text }) } }
}

// ── tests ────────────────────────────────────────────────────────────────────────────

test('an App Store Connect token is ES256, signed with the .p8 key, for Apple\'s audience, and short-lived', () => {
  const [head, body, signature] = parts(appleToken(APPLE, Date.parse('2026-11-13T12:00:00Z')))
  assert.deepEqual(head, { alg: 'ES256', kid: APPLE.keyId, typ: 'JWT' })
  assert.equal(body.iss, APPLE.issuerId)
  assert.equal(body.aud, 'appstoreconnect-v1')
  assert.ok(body.exp - body.iat <= 20 * 60, 'Apple refuses a token good for more than twenty minutes')
  assert.equal(Buffer.from(signature, 'base64url').length, 64, 'a raw ES256 signature, not DER')
})

test('a Google Play token is asked for with the service account\'s own signed assertion and the Play scopes', async () => {
  const play = playStore()
  assert.equal(await googleToken(ACCOUNT, play.fetcher), 'play-token')
  const asked = play.seen[0].token
  assert.equal(asked.iss, ACCOUNT.client_email)
  assert.match(asked.scope, /androidpublisher/)
  assert.match(asked.scope, /playdeveloperreporting/)
})

test('App Store Connect: a bad key is refused when pasted, and nothing is kept', async () => {
  const where = room()
  await assert.rejects(addConnector({ from: 'app-store-connect', issuerId: APPLE.issuerId, keyId: APPLE.keyId, privateKey: 'not a key' }, { folder: where.folder, crew: CREW }), /not a \.p8 key/)
  await assert.rejects(addConnector({ from: 'app-store-connect', issuerId: APPLE.issuerId, keyId: APPLE.keyId }, { folder: where.folder, crew: CREW }), /Paste the .*\.p8/)
  assert.deepEqual(readStore(where.folder).connectors, {})
})

test('App Store Connect reads pass through the gateway; the key is never shown back', async () => {
  const where = room()
  const apple = appleStore()
  const made = await addConnector({ from: 'app-store-connect', ...APPLE, owner: 'business' }, { folder: where.folder, fetcher: apple.fetcher, crew: CREW })
  assert.equal(made.state, 'ready', 'the key is proved by one read')
  assert.ok(!JSON.stringify(connectorList({ crew: CREW, folder: where.folder })).includes('PRIVATE KEY'), 'the page never sees the key')
  assert.equal(fs.statSync(path.join(where.folder, 'connectors.json')).mode & 0o777, 0o600)
  await setAccess(made.id, { bots: { 'bot-pub': 'write' }, writes: ['asc_reply_to_review'] }, { folder: where.folder, crew: CREW, out: where.out })
  const pass = readStore(where.folder).passes['bot-pub']
  const ask = async (msg, deck = cards()) => JSON.parse((await gateway(made.id, pass, { body: JSON.stringify(msg) }, { folder: where.folder, fetcher: apple.fetcher, cards: deck })).body)
  const listed = (await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name)
  assert.ok(listed.includes('asc_reviews') && listed.includes('asc_reply_to_review') && !listed.includes('asc_release'), 'only reads and the ticked change')
  const reviews = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'asc_reviews', arguments: { appId: '1234' } } })
  assert.match(reviews.result.content[0].text, /It crashes on start/)
  const sales = await runBuiltin('app-store-connect', APPLE, 'asc_sales', { vendorNumber: '8765', date: '2026-11-11' }, { fetcher: apple.fetcher })
  assert.match(sales.content[0].text, /"Units": "12"/, 'the gzipped report is read into rows')
})

test('a reply to a review waits for the owner\'s yes even on a business account, shows exactly the reply, and is sent only after the yes', async () => {
  const where = room()
  const apple = appleStore()
  const made = await addConnector({ from: 'app-store-connect', ...APPLE, owner: 'business' }, { folder: where.folder, fetcher: apple.fetcher, crew: CREW })
  await setAccess(made.id, { bots: { 'bot-pub': 'write' }, writes: ['asc_reply_to_review'] }, { folder: where.folder, crew: CREW, out: where.out })
  const pass = readStore(where.folder).passes['bot-pub']
  const deck = cards()
  const reply = 'Thank you. Version 2.1 fixes the crash on start.'
  const answer = JSON.parse((await gateway(made.id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'asc_reply_to_review', arguments: { reviewId: 'r1', reply } } }) }, { folder: where.folder, fetcher: apple.fetcher, cards: deck })).body)
  assert.match(answer.result.content[0].text, /^Not done yet/)
  assert.equal(apple.seen.filter((c) => c.method === 'POST').length, 0, 'nothing is sent before the yes')
  assert.ok(deck.seen.cards[0].prompt.includes(`reply: ${reply}`), 'the card shows the reply word for word')
  await settleHeld(deck.seen.cards[0].card, 'accept', { folder: where.folder, fetcher: apple.fetcher, cards: deck })
  const posted = apple.seen.filter((c) => c.method === 'POST')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body.data.attributes.responseBody, reply)
  assert.equal(posted[0].body.data.relationships.review.data.id, 'r1')
  assert.match(deck.seen.told[0].text, /said yes/)
})

test('Google Play: reads go through an edit that is thrown away; a rollout waits for the yes and is committed only after it', async () => {
  const where = room()
  const play = playStore()
  const made = await addConnector({ from: 'google-play', serviceAccount: JSON.stringify(ACCOUNT), packageName: 'com.example.tides', owner: 'business' }, { folder: where.folder, fetcher: play.fetcher, crew: CREW })
  assert.equal(made.state, 'ready')
  await setAccess(made.id, { bots: { 'bot-pub': 'write' }, writes: ['play_release'] }, { folder: where.folder, crew: CREW, out: where.out })
  const pass = readStore(where.folder).passes['bot-pub']
  const deck = cards()
  const call = async (name, args) => JSON.parse((await gateway(made.id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } }) }, { folder: where.folder, fetcher: play.fetcher, cards: deck })).body)
  const tracks = await call('play_tracks', {})
  assert.match(tracks.result.content[0].text, /production/)
  assert.ok(play.seen.some((c) => c.method === 'DELETE'), 'an edit opened only to read is thrown away')
  assert.ok(!play.seen.some((c) => /:commit$/.test(c.path)))

  const held = await call('play_release', { track: 'production', versionCodes: ['42'], status: 'inProgress', userFraction: 0.1 })
  assert.match(held.result.content[0].text, /^Not done yet/)
  assert.ok(!play.seen.some((c) => c.method === 'PUT'), 'no rollout before the yes')
  assert.match(deck.seen.cards[0].prompt, /userFraction: 0\.1/)
  await settleHeld(deck.seen.cards[0].card, 'accept', { folder: where.folder, fetcher: play.fetcher, cards: deck })
  const put = play.seen.find((c) => c.method === 'PUT')
  assert.deepEqual(put.body.releases[0], { versionCodes: ['42'], status: 'inProgress', userFraction: 0.1 })
  assert.ok(play.seen.some((c) => /:commit$/.test(c.path)), 'the change is committed after the yes')
})

test('a no on a store change reaches the bot and nothing reaches the store', async () => {
  const where = room()
  const play = playStore()
  const made = await addConnector({ from: 'google-play', serviceAccount: JSON.stringify(ACCOUNT), packageName: 'com.example.tides' }, { folder: where.folder, fetcher: play.fetcher, crew: CREW })
  await setAccess(made.id, { bots: { 'bot-pub': 'write' }, writes: ['play_reply_to_review'] }, { folder: where.folder, crew: CREW, out: where.out })
  const pass = readStore(where.folder).passes['bot-pub']
  const deck = cards()
  await gateway(made.id, pass, { body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'play_reply_to_review', arguments: { reviewId: 'g1', reply: 'Thanks!' } } }) }, { folder: where.folder, fetcher: play.fetcher, cards: deck })
  const before = play.seen.length
  await settleHeld(deck.seen.cards[0].card, 'reject', { reason: 'Too short', folder: where.folder, fetcher: play.fetcher, cards: deck })
  assert.equal(play.seen.length, before)
  assert.match(deck.seen.told[0].text, /said no.*Too short/)
})
