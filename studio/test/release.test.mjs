/** A release to the stores (docs/launch.md): what a store would refuse is found before anything is sent. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { checkArt, checkListing, imageSize, parseListing, readiness, readinessText } from '../server/lib/release-checks.mjs'
import { RELEASE_TRACK, checkTrack } from '../server/engine/tracks.mjs'

/** A real, tiny PNG of a given size (one grey row repeated), so sizes are read from real headers. */
function png(file, w, h) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 0
  const raw = Buffer.alloc((w + 1) * h, 128); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

const LISTING = {
  language: 'en-US',
  play: { title: 'Lamp', short: 'A small lamp that turns on.', full: 'Turn the lamp on and off. That is all it does.', whatsNew: 'Faster start.' },
  appstore: { name: 'Lamp', subtitle: 'Turns on', keywords: 'lamp,light', description: 'Turn the lamp on and off.', promo: '', whatsNew: 'Faster start.' },
  privacyUrl: 'https://example.test/privacy', supportUrl: 'https://example.test/help',
}

test('a listing is read as JSON, alone or inside a note, and held to each store\'s limits with no placeholder text', () => {
  assert.deepEqual(parseListing(`Here it is:\n\`\`\`json\n${JSON.stringify(LISTING)}\n\`\`\``).play.title, 'Lamp')
  assert.equal(parseListing('not json'), null)
  assert.deepEqual(checkListing(LISTING, ['play', 'appstore']).map((i) => i.state), ['pass'])
  const long = checkListing({ ...LISTING, play: { ...LISTING.play, title: 'A title far longer than thirty characters' } }, ['play'])
  assert.match(long[0].text, /Play title within 30 characters/)
  const todo = checkListing({ ...LISTING, appstore: { ...LISTING.appstore, description: 'TODO write this' } }, ['appstore'])
  assert.match(todo[0].detail, /TODO/)
  assert.equal(checkListing({ play: LISTING.play }, ['play', 'appstore']).find((i) => i.state === 'fail').detail, 'No part for this store')
})

test('store art is checked at the sizes the stores take, read from the images themselves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'))
  png(path.join(dir, 'icon.png'), 512, 512)
  assert.deepEqual(imageSize(path.join(dir, 'icon.png')), { w: 512, h: 512 })
  const missing = checkArt(dir, ['play'])
  assert.equal(missing.find((i) => i.text.startsWith('Play feature graphic')).state, 'fail')
  png(path.join(dir, 'feature.png'), 1024, 500)
  for (let n = 0; n < 3; n++) png(path.join(dir, `shot-${n}.png`), 1320, 2868)
  const all = checkArt(dir, ['play', 'appstore'])
  assert.deepEqual(all.map((i) => i.state), ['pass', 'pass', 'pass', 'pass'])
  assert.equal(checkArt('', ['play'])[0].state, 'fail')
})

test('readiness blocks on what a store would refuse, and says what only the owner can do', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-'))
  png(path.join(dir, 'icon.png'), 512, 512)
  png(path.join(dir, 'feature.png'), 1024, 500)
  for (let n = 0; n < 3; n++) png(path.join(dir, `shot-${n}.png`), 1080, 1920)
  const io = (over = {}) => ({
    answers: async (url) => !url.includes('broken'), fileSize: () => 1000, versionCode: () => '45',
    playHighestCode: async () => 44, playProducts: async () => 2, dependencies: () => ['react-native-purchases'], ...over,
  })
  const ok = await readiness({ listing: LISTING, artFolder: dir, aab: '/x/app.aab', appFolder: '/x', stores: ['play'], io: io() })
  assert.equal(ok.ok, true)
  assert.ok(ok.items.some((i) => i.group === 'Payments' && i.state === 'yours'), 'a test purchase is the owner\'s')
  assert.match(readinessText(ok), /^OK {2}Listing/m)
  // A version code that does not rise, a privacy page that does not answer and no products for a paying app all block.
  const bad = await readiness({ listing: { ...LISTING, privacyUrl: 'https://broken.test/privacy' }, artFolder: dir, aab: '/x/app.aab', appFolder: '/x', stores: ['play'], io: io({ versionCode: () => '44', playProducts: async () => 0 }) })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.blocking.map((i) => i.group).sort(), ['Build', 'Legal', 'Payments'])
  // A store that cannot be read is said, not passed and not failed.
  const unread = await readiness({ listing: LISTING, artFolder: dir, aab: '/x/app.aab', appFolder: '/x', stores: ['play'], io: io({ playHighestCode: async () => { throw new Error('no key') } }) })
  assert.equal(unread.items.find((i) => i.text.startsWith('Version code')).state, 'warn')
})

test('the release track: the owner says yes before anything is sent for review, and nothing goes on to main', () => {
  const t = checkTrack(RELEASE_TRACK, { selfKey: 'release-app' })
  assert.equal(t.delivers, 'nothing')
  const order = t.steps.map((s) => s.id)
  assert.ok(order.indexOf('owner') < order.indexOf('submit'), 'the gate comes before sending for review')
  assert.ok(order.indexOf('ready') < order.indexOf('upload'), 'the checks come before any upload')
  assert.deepEqual(t.lines.filter((l) => l.to === 'submit').map((l) => l.from), ['owner'], 'only the owner\'s yes leads to sending')
  assert.equal(t.steps.find((s) => s.id === 'score').orBot, '$writer')
})
