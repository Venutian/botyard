/**
 * Engram, the Brain view (`/api/studio/brain`, `/v1/brain`): what it reads from a notes vault, that it only
 * reads, and that it answers the owner and never a bot. Everything runs on the demo vault in studio/demo/brain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { DEMO_BRAIN, brainFolder, brainNote, brainRoute, frontmatter, looksSecret, newNote, readBrain, saveNote, setBrainFolder } from '../server/lib/brain.mjs'
import { matches } from '../src/ui/brain-map.js'
import { RADIUS, SHAPE, brainDust, fieldLayout } from '../src/ui/brain-layout.js'
import { clampBox, edgePoint, layoutTitles, nearestNote, placeExcerpt, titlesAt, zoomFactor } from '../src/ui/brain-field.js'

const demo = DEMO_BRAIN()

test('the demo vault is read: notes, areas, links, the index and the date span', () => {
  const b = readBrain(demo)
  assert.equal(b.on, true)
  assert.equal(b.notes.length, 18)
  assert.ok(!b.notes.some((n) => /^(index|readme)$/i.test(n.id)), 'index and README are not notes')
  assert.deepEqual(b.areas.slice(0, 2).map((a) => a.id), ['money', 'life'], 'personal categories come first')
  assert.ok(b.areas.find((a) => a.id === 'life').private)
  assert.ok(!b.areas.some((a) => a.id === 'other'), 'every demo note has a category')
  assert.deepEqual(b.areas.map((a) => a.id), ['money', 'life', 'products', 'crew', 'inbox'], 'categories, not project names')
  assert.equal(b.from, '2026-09-02')
  assert.equal(b.to, '2026-11-18')
  const green = b.notes.find((n) => n.id === '2026-10-14-release-when-green')
  assert.equal(green.kind, 'decision')
  assert.ok(green.pinned, 'named in index.md')
  assert.ok(green.links.includes('tests-before-merge'))
  assert.deepEqual(green.supersedes, ['2026-09-05-weekly-release-train'])
  for (const n of b.notes) assert.ok(!('text' in n), 'the map carries no note text')
})

test('a superseded note points at what replaced it, from either side', () => {
  const b = readBrain(demo)
  const old = b.notes.find((n) => n.id === '2026-10-02-night-runs-only-tests')
  assert.equal(old.status, 'superseded')
  assert.deepEqual(old.supersededBy, ['2026-11-10-night-builds-on-branches'])
})

test('notes in personal folders, or marked private, are private; imported ones are flagged', () => {
  const b = readBrain(demo)
  for (const n of b.notes.filter((x) => ['life', 'money'].includes(x.folder))) assert.equal(n.private, true, n.id)
  assert.ok(b.notes.filter((n) => n.folder === 'decisions').every((n) => !n.private))
  assert.equal(b.notes.filter((n) => n.imported).length, 3)
})

test('frontmatter: [[link]] values stay links, [a, b] values are lists', () => {
  const { data } = frontmatter('---\nsuperseded_by: [[a-note]]\ntags: [one, two]\n---\n# T\n')
  assert.equal(data.superseded_by, '[[a-note]]')
  assert.deepEqual(data.tags, ['one', 'two'])
})

test('one note: its text without frontmatter, and nothing outside the vault', () => {
  const n = brainNote('plain-copy', demo)
  assert.match(n.text, /^# Plain copy/)
  assert.ok(!n.text.startsWith('---'))
  assert.throws(() => brainNote('../../package', demo), /no note by that name/)
})

test('the folder: env first, then the settings file, then the demo vault in the demo only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'))
  try {
    assert.equal(brainFolder({ BOTYARD_HOME: home }), '')
    assert.equal(brainFolder({ BOTYARD_HOME: home, BOTYARD_DEMO: '1' }), demo)
    assert.throws(() => setBrainFolder(home, { BOTYARD_HOME: home }), /no markdown notes/)
    setBrainFolder(demo, { BOTYARD_HOME: home })
    assert.equal(brainFolder({ BOTYARD_HOME: home }), demo)
    assert.equal(brainFolder({ BOTYARD_HOME: home, BOTYARD_BRAIN_DIR: '/x' }), '/x')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/** brainRoute against a fake request: the status it answers. */
async function ask({ pathname = '/api/studio/brain', base = '/api/studio/brain', headers = {}, method = 'GET', local = true, bot = '' } = {}) {
  let status = 0
  let body = null
  const answered = await brainRoute({ method, headers }, {}, { pathname, query: new URLSearchParams(), base, local, botBehind: () => bot, readBody: async () => ({ folder: demo }), send: (_res, s, b) => { status = s; body = b } })
  return { answered, status, body }
}

test('owner only: a bot\'s run, a script\'s key or a bot\'s pass is refused, on the page and the phone door', async () => {
  const saved = { ...process.env }
  process.env.BOTYARD_BRAIN_DIR = demo
  delete process.env.BOTYARD_REFUSE_BOTS
  try {
    assert.equal((await ask()).status, 200)
    assert.equal((await ask({ bot: 'run-1' })).status, 403)
    assert.equal((await ask({ headers: { 'x-botyard-script': 'k' } })).status, 403)
    assert.equal((await ask({ headers: { authorization: 'Bearer bot-pass' } })).status, 403)
    // The phone door's own key is checked before this; a bot's run is still refused there.
    assert.equal((await ask({ base: '/v1/brain', pathname: '/v1/brain', headers: { authorization: 'Bearer phone-key' } })).status, 200)
    assert.equal((await ask({ base: '/v1/brain', pathname: '/v1/brain', bot: 'run-2' })).status, 403)
    assert.equal((await ask({ pathname: '/api/studio/brain/folder', method: 'POST', local: false })).status, 403)
    assert.equal((await ask({ pathname: '/api/studio/brain', method: 'POST' })).status, 405, 'read-only: nothing writes a note')
    assert.equal((await ask({ pathname: '/api/studio/flow' })).answered, false)
  } finally {
    process.env = saved
  }
})

test('the demo\'s own made-up vault may be read by a bot (its screenshots), never written; a real folder stays the owner\'s', async () => {
  const saved = { ...process.env }
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-real-'))
  fs.writeFileSync(path.join(real, 'a.md'), '# A real note\n')
  delete process.env.BOTYARD_REFUSE_BOTS
  process.env.BOTYARD_DEMO = '1'
  try {
    process.env.BOTYARD_BRAIN_DIR = demo
    assert.equal((await ask({ bot: 'run-1' })).status, 200, 'the demo map, for a bot-run browser')
    assert.equal((await ask({ bot: 'run-1', pathname: '/api/studio/brain/note' })).status, 404, 'past the guard: a note with no id is not found, not refused')
    assert.equal((await ask({ bot: 'run-1', pathname: '/api/studio/brain/note', method: 'POST' })).status, 403, 'a bot never writes, even the demo')
    assert.equal((await ask({ bot: 'run-1', pathname: '/api/studio/brain/folder', method: 'POST' })).status, 403, 'nor moves the folder')
    assert.equal((await ask({ headers: { 'x-botyard-script': 'k' } })).status, 403, 'a script key is refused everywhere')
    process.env.BOTYARD_BRAIN_DIR = real
    assert.equal((await ask({ bot: 'run-1' })).status, 403, 'a demo pointed at a real folder: refused as ever')
    delete process.env.BOTYARD_DEMO
    process.env.BOTYARD_BRAIN_DIR = demo
    assert.equal((await ask({ bot: 'run-1' })).status, 403, 'the demo vault outside the demo: refused as ever')
  } finally {
    process.env = saved
    fs.rmSync(real, { recursive: true, force: true })
  }
})

test('the field: every note inside the brain, near its own lobe, the same every time; search matches every word', () => {
  const b = readBrain(demo)
  const one = fieldLayout(b)
  const two = fieldLayout(b)
  assert.deepEqual([...one.at], [...two.at], 'seeded from the notes, never random')
  for (const n of b.notes) {
    const p = one.at.get(n.id)
    const inside = Math.hypot(p.x / (RADIUS * SHAPE.x), p.y / (RADIUS * SHAPE.y), p.z / (RADIUS * SHAPE.z))
    assert.ok(inside <= 0.91, `${n.id} inside the brain`)
    const mine = one.centres.get(n.area)
    const nearest = [...one.centres.values()].reduce((best, c) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) < Math.hypot(p.x - best.x, p.y - best.y, p.z - best.z) ? c : best)
    assert.ok(Math.hypot(p.x - mine.x, p.y - mine.y, p.z - mine.z) < Math.hypot(p.x - nearest.x, p.y - nearest.y, p.z - nearest.z) + 60, `${n.id} near its lobe`)
  }
  const dust = brainDust(3000)
  assert.equal(dust.length, 9000)
  for (let i = 0; i < Math.round(3000 * 0.8) * 3; i += 3) assert.ok(Math.abs(dust[i]) > 0.04 * RADIUS * 0.8 || dust[i + 1] < -0.2 * RADIUS, 'the fissure between the halves stays empty')
  assert.deepEqual([...matches(b.notes, 'release green')], ['2026-10-14-release-when-green'])
  assert.equal(matches(b.notes, '  '), null)
})

test('the zoom helpers: which neurons get labels as the camera comes closer', () => {
  const at = new Map([
    ['one', new THREE.Vector3(0, 0, 0)],
    ['two', new THREE.Vector3(20, 0, 0)],
    ['three', new THREE.Vector3(90, 0, 0)],
  ])
  const order = ['one', 'two', 'three']
  const cam = new THREE.Vector3(0, 0, 0)
  const light = new Map([['one', 1], ['two', 1], ['three', 1]])
  assert.equal(nearestNote(at, order, cam, light), 'one')
  const dim = new Map([['one', 0.1], ['two', 1], ['three', 1]])
  assert.equal(nearestNote(at, order, cam, dim), 'two')
  assert.equal(nearestNote(at, order, new THREE.Vector3(1000, 0, 0), light), 'three')
  assert.equal(nearestNote(at, order, cam, new Map()), 'one', 'no light map dims nothing')
  assert.equal(zoomFactor(500), 0, 'no labels far away')
  assert.equal(zoomFactor(360), 0, 'labels only begin inside about 360')
  assert.equal(zoomFactor(140), 1, 'full zoom right inside the brain')
  assert.ok(zoomFactor(300) > 0 && zoomFactor(300) < 1, 'labels begin under about 300')
  assert.ok(zoomFactor(310) > zoomFactor(340), 'closer means more zoom')
})

test('which neurons get titles at a camera distance: none far off, then the nearest lit ones first, never more than twelve', () => {
  const w = 1440
  const h = 900
  // Twenty neurons in a row across the stage, each 30 px apart and 10 units further from the camera than the last;
  // n3 and n7 are dimmed by a search, so they never get a title.
  const cands = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, x: 60 + i * 66, y: 450, d: 50 + i * 10, inFrame: true, w: 60, h: 23, light: i === 3 || i === 7 ? 0.12 : 1 }))
  // Shuffled, so the order out is the helper's own and not the input's.
  const mixed = [...cands].reverse()
  const ids = (dist) => titlesAt(dist, mixed, { w, h, max: 12, least: 6 }).map((s) => s.id)
  assert.deepEqual(ids(520), [], 'the default view: no titles')
  assert.deepEqual(ids(360), [], 'still none at the edge of the zoom')
  const near = ids(200)
  assert.equal(near.length, 12, 'twelve at most, though eighteen are lit')
  assert.deepEqual(near, ['n0', 'n1', 'n2', 'n4', 'n5', 'n6', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13'], 'nearest first, dimmed ones skipped')
  assert.deepEqual(ids(290), near, 'the same choice anywhere inside the zoom: distance gates the titles, nearness orders them')
  const five = mixed.filter((c) => ['n0', 'n1', 'n2', 'n3', 'n4'].includes(c.id))
  assert.deepEqual(titlesAt(200, five, { w, h, max: 12, least: 6 }).map((s) => s.id), ['n0', 'n1', 'n2', 'n4'], 'fewer than twelve lit: every lit one')
})

test('the nearest note prefers one on the stage, and falls back to the nearest of all', () => {
  const at = new Map([['near', new THREE.Vector3(5, 0, 0)], ['seen', new THREE.Vector3(40, 0, 0)]])
  const cam = new THREE.Vector3(0, 0, 0)
  assert.equal(nearestNote(at, ['near', 'seen'], cam, null, (id) => id === 'seen'), 'seen')
  assert.equal(nearestNote(at, ['near', 'seen'], cam, null, () => false), 'near', 'none in view: the nearest of all')
})

/** Two boxes overlap. */
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const insideOf = (w, h) => (b) => b.left >= 0 && b.top >= 0 && b.right <= w && b.bottom <= h

test('a neuron off the stage is pinned to its edge, the way it lies', () => {
  const e = edgePoint(500, 0, 400, 300, 10)
  assert.deepEqual([Math.round(e.x), Math.round(e.y)], [390, 150], 'far right: on the right edge, level')
  const up = edgePoint(0, -9000, 400, 300, 10)
  assert.deepEqual([Math.round(up.x), Math.round(up.y)], [200, 10])
  const corner = edgePoint(-1000, 1000, 400, 300, 10)
  assert.ok(corner.y === 290 && corner.x > 0 && corner.x < 200, 'down left: on the bottom edge, left of the middle')
  const b = clampBox(398, -20, 120, 23, 400, 300)
  assert.ok(insideOf(400, 300)(b), 'a plate centred off the stage is moved inside it')
  assert.equal(b.right - b.left, 120)
})

test('the titles: in-frame ones nearest first, edge ones only to make up six, all inside, none overlapping', () => {
  const w = 375
  const h = 560
  const plate = (id, x, y, d, inFrame = true) => ({ id, x, y, d, inFrame, w: 150, h: 23 })
  // Twelve neurons crowded on one spot, two off the stage: the crowd spreads out, the edge ones are not needed.
  const crowd = Array.from({ length: 12 }, (_, i) => plate(`n${i}`, 180, 280, 100 + i))
  const shown = layoutTitles([...crowd, plate('off', 360, 10, 1, false)], { w, h, max: 12, least: 6 })
  assert.equal(shown.length, 12)
  assert.ok(!shown.some((s) => s.id === 'off'), 'twelve in view: no edge plate, even for the nearest neuron')
  assert.deepEqual(shown.slice(0, 3).map((s) => s.id), ['n0', 'n1', 'n2'], 'nearest first')
  for (const s of shown) assert.ok(insideOf(w, h)(s.box), `${s.id} inside the stage`)
  for (let i = 0; i < shown.length; i += 1) for (let j = i + 1; j < shown.length; j += 1) assert.ok(!overlap(shown[i].box, shown[j].box), `${shown[i].id} and ${shown[j].id} apart`)
  // Two in view: four of the nearest out of view make up six, on the edge, and the excerpt is kept clear.
  const excerpt = { left: 100, top: 300, right: 300, bottom: 360 }
  const few = [plate('a', 200, 320, 50), plate('b', 210, 330, 60), ...['e1', 'e2', 'e3', 'e4', 'e5'].map((id, i) => plate(id, 12, 200 + i, 70 + i, false))]
  const six = layoutTitles(few, { w, h, max: 12, least: 6, avoid: [excerpt] })
  assert.equal(six.length, 6)
  assert.deepEqual(six.map((s) => s.id), ['a', 'b', 'e1', 'e2', 'e3', 'e4'], 'in view first, then the nearest out of view')
  for (const s of six) assert.ok(insideOf(w, h)(s.box) && !overlap(s.box, excerpt), `${s.id} inside and off the excerpt`)
  assert.deepEqual(layoutTitles([], { w, h }), [], 'nothing to show, nothing drawn')
})

test('the excerpt plate flips and clamps so it stays fully on the stage', () => {
  const w = 375
  const h = 560
  const right = placeExcerpt(360, 100, 250, 80, w, h)
  assert.ok(right.right <= w - 6 && right.left >= 6, 'near the right edge it flips left')
  assert.equal(right.right, 360 - 16, 'beside the neuron, on its left')
  const low = placeExcerpt(40, 550, 250, 80, w, h)
  assert.ok(low.bottom <= h - 6 && low.top === 550 - 14 - 80, 'near the bottom it goes above')
  const huge = placeExcerpt(-500, 9000, 363, 600, w, h)
  assert.ok(huge.left >= 6 && huge.top >= 6, 'even a plate as big as the stage starts inside it')
})

test('a pooled plate that is hidden is not painted: the hidden rule beats the plates\' own display', () => {
  const css = fs.readFileSync(new URL('../src/ui/brain-map.css', import.meta.url), 'utf8')
  assert.match(css, /\.bf-node-label\[hidden\][^{]*\{\s*display:\s*none/, '.bf-node-label[hidden] is display none')
  assert.match(css, /\.bf-excerpt\[hidden\]/, 'and the excerpt plate too')
  const label = css.slice(css.indexOf('.brainmap .bf-node-label {'))
  assert.ok(css.indexOf('.bf-node-label[hidden]') > css.indexOf('.brainmap .bf-node-label {'), 'it comes after the rule that sets display: inline-flex')
  assert.match(label, /display: inline-flex/)
})

test('the owner edits a note: saved whole, refused when it changed meanwhile or holds a secret; a new note goes to inbox/', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  try {
    fs.cpSync(demo, vault, { recursive: true })
    const open = brainNote('plain-copy', vault)
    const edited = open.raw.replace('No taglines.', 'No taglines, no hype.')
    const saved = saveNote({ id: 'plain-copy', text: edited, version: open.version }, vault)
    assert.match(fs.readFileSync(path.join(vault, 'preferences', 'plain-copy.md'), 'utf8'), /no hype/)
    assert.notEqual(saved.version, open.version)
    assert.throws(() => saveNote({ id: 'plain-copy', text: edited + 'x', version: open.version }, vault), /changed since you opened it/)
    assert.throws(() => saveNote({ id: 'plain-copy', text: `${edited}\napi_key = abcdefghijklmnop1234`, version: saved.version }, vault), /password, key or card/)
    assert.throws(() => saveNote({ id: 'plain-copy', text: '  ', version: saved.version }, vault), /empty/)
    const made = newNote({ title: 'Try a gift card page', text: 'For the harbour shop.' }, vault, '2026-11-18')
    assert.equal(made.path, 'inbox/2026-11-18-try-a-gift-card-page.md')
    assert.equal(newNote({ title: 'Try a gift card page' }, vault, '2026-11-18').path, 'inbox/2026-11-18-try-a-gift-card-page-2.md', 'never overwrites')
    assert.equal(looksSecret('card 4111 1111 1111 1111'), true)
    assert.equal(looksSecret('on 2026-11-18 we decided'), false)
  } finally {
    fs.rmSync(vault, { recursive: true, force: true })
  }
})

test('writing is the owner\'s, on the PC page: a bot is refused, and the phone door cannot write', async () => {
  const saved = { ...process.env }
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
  fs.cpSync(demo, vault, { recursive: true })
  process.env.BOTYARD_BRAIN_DIR = vault
  delete process.env.BOTYARD_REFUSE_BOTS
  try {
    const post = async (pathname, base, { bot = '', local = true } = {}) => {
      let status = 0
      await brainRoute({ method: 'POST', headers: {} }, {}, { pathname, query: new URLSearchParams(), base, local, botBehind: () => bot, readBody: async () => ({ title: 'From a test' }), send: (_r, s) => { status = s } })
      return status
    }
    assert.equal(await post('/api/studio/brain/new', '/api/studio/brain', { bot: 'run-9' }), 403)
    assert.equal(await post('/v1/brain/new', '/v1/brain', { local: false }), 403)
    assert.equal(await post('/api/studio/brain/new', '/api/studio/brain'), 201)
  } finally {
    process.env = saved
    fs.rmSync(vault, { recursive: true, force: true })
  }
})
