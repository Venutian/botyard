/**
 * Engram, the Brain view (`/api/studio/brain`, `/v1/brain`): what it reads from a notes vault, that it only
 * reads, and that it answers the owner and never a bot. Everything runs on the demo vault in studio/demo/brain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEMO_BRAIN, brainFolder, brainNote, brainRoute, frontmatter, looksSecret, newNote, readBrain, saveNote, setBrainFolder } from '../server/lib/brain.mjs'
import { matches } from '../src/ui/brain-map.js'
import { RADIUS, SHAPE, brainDust, fieldLayout } from '../src/ui/brain-layout.js'

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
