// The plain descriptions of controls and status words: one wording on the PC page and the phone app, no
// exclamation marks, short sentences, and the crew map's marks and legend carry them.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DESCRIBE } from '../src/ui/describe.js'
import { describeControls, labelOf, tipFor } from '../src/ui/describe-controls.js'
import { flowHtml, legendHtml } from '../src/ui/crew-map.js'

const phone = fs.readFileSync(new URL('../../src/ui/describe.ts', import.meta.url), 'utf8')

test('the phone has the same words as the PC page', () => {
  const body = phone.slice(phone.indexOf('DESCRIBE = ') + 'DESCRIBE = '.length, phone.indexOf(' as const'))
  assert.deepEqual(JSON.parse(body), DESCRIBE)
})

const leaves = (node, path = []) => (typeof node === 'string' ? [[path.join('.'), node]] : Object.entries(node).flatMap(([k, v]) => leaves(v, [...path, k])))

test('every description is one short plain sentence', () => {
  for (const [where, text] of leaves(DESCRIBE)) {
    const words = text.split(/\s+/).length
    assert.ok(words >= 3 && words <= 16, `${where}: ${words} words: ${text}`)
    assert.ok(!text.includes('!'), `${where}: no exclamation marks`)
    assert.ok(!/[—]/.test(text), `${where}: no long dashes`)
  }
})

test('a status word starts its own description, so the word and its meaning read together', () => {
  for (const group of ['status', 'botStatus']) {
    for (const [word, text] of Object.entries(DESCRIBE[group])) assert.ok(text.startsWith(`${word}:`), `${group}.${word}`)
  }
})

/** A stand-in for a button on the page: what the lookup reads. */
const el = (text, { cls = [], data = {}, title = '' } = {}) => {
  const set = new Set(cls)
  return { textContent: text, title, dataset: data, classList: { contains: (c) => set.has(c), [Symbol.iterator]: () => set[Symbol.iterator]() }, getAttribute: (n) => (n === 'title' ? title : null), matches: () => false, querySelector: () => null }
}

test('a button whose label could be misread gets its description, and one that has a title keeps it', () => {
  assert.equal(tipFor(el('Reject')), DESCRIBE.act.Reject)
  assert.equal(tipFor(el('Cancel the job…')), DESCRIBE.act['Cancel the job'])
  assert.equal(tipFor(el('Reject', { title: 'Mine' })), '')
  assert.equal(tipFor(el('Open the settings')), '')
  assert.equal(labelOf(el('  Clear   it ')), 'Clear it')
})

test('Pause and Resume say what they stop, by what they belong to', () => {
  assert.equal(tipFor(el('Pause', { data: { act: 'pause', bot: 'b' } })), DESCRIBE.act.Pause)
  assert.equal(tipFor(el('Pause', { data: { act: 'routine', do: 'pause' } })), DESCRIBE.act['Pause routine'])
  assert.equal(tipFor(el('Resume', { data: { act: 'trip', do: 'resume' } })), DESCRIBE.act['Resume run'])
  assert.equal(tipFor(el('Approve', { data: { act: 'trip-gate' } })), DESCRIBE.act['Approve step'])
})

test('status words, pile tabs and findings get their meaning', () => {
  assert.equal(tipFor(el('Checking', { cls: ['state'] })), DESCRIBE.status.Checking)
  assert.equal(tipFor(el('Made up word', { cls: ['stage'] })), '')
  assert.equal(tipFor(el('To decide 3', { data: { act: 'improve-filter' } })), DESCRIBE.finding['To decide'])
  assert.equal(tipFor(el('Stale', { cls: ['chip', 'imp-stale'] })), DESCRIBE.finding.Stale)
})

test('describeControls sets the title of what it finds, once', () => {
  const found = [el('Clear it'), el('Details')]
  const root = { querySelectorAll: () => found, matches: () => false }
  found.forEach((f) => { f.setAttribute = (n, v) => { f.title = v } })
  describeControls(root)
  assert.equal(found[0].title, DESCRIBE.act['Clear it'])
  assert.equal(found[1].title, '')
})

const flow = {
  window: '24h',
  kinds: [{ kind: 'order', label: 'Orders', says: 'Work handed down' }],
  nodes: [
    { id: 'owner', kind: 'owner', name: 'You', role: 'owner', roleName: 'Owner', needs: 2 },
    { id: 'lead', kind: 'bot', name: 'Lead', role: 'lead', roleName: 'Lead', model: 'Model', status: 'waiting', look: {}, under: 'owner', runsToday: 1, job: { stage: 'Checking', title: 'A job', ref: 'J-1' } },
    { id: 'script', kind: 'script', name: 'Timer', role: 'script', notices: 3 },
  ],
  edges: [{ id: 'owner>lead:order', from: 'owner', to: 'lead', kind: 'order', count: 2, failed: 0, last: 1 }],
  lanes: [],
}

test('the crew map says what its status words, counters and legend mean', () => {
  const layout = { width: 900, height: 500, chartW: 700, laneW: 0, laneX: 0, laneTop: 0, laneH: 0, bandY: null, bandH: 0, box: new Map([['owner', { x: 0, y: 0, w: 268, h: 62 }], ['lead', { x: 0, y: 100, w: 236, h: 122 }], ['script', { x: 0, y: 300, w: 156, h: 36 }]]), lanes: [], lines: [] }
  const html = flowHtml(flow, layout)
  assert.ok(html.includes(`title="${DESCRIBE.botStatus.Waiting}"`))
  assert.ok(html.includes(`title="${DESCRIBE.status.Checking}"`))
  assert.ok(html.includes(`title="${DESCRIBE.map.owner}"`))
  assert.ok(html.includes(`title="${DESCRIBE.map.script}"`))
  assert.ok(legendHtml(flow).includes(`title="${DESCRIBE.map.failed}"`))
})
