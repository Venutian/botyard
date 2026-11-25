/** A page's phone view (src/ownView.ts): what the app will draw, and what it leaves out. */
import assert from 'node:assert/strict'
import { readView, viewPath } from '../src/ownView.ts'

assert.deepEqual(readView(null), { title: '', note: '', blocks: [] })
assert.deepEqual(readView({ blocks: 'nope' }).blocks, [])

const v = readView({
  title: 'Shop', note: 'Orders this month',
  blocks: [
    { kind: 'heading', text: 'October' },
    { kind: 'tiles', items: [{ label: 'Sold', value: '12 400 kr', note: 'usual 11 000', tone: 'good' }, { label: '', value: 'x' }, { label: 'Odd tone', value: '1', tone: 'pink' }] },
    { kind: 'chart', param: 'month', items: [{ label: 'Sep', value: 10, pick: '2026-09' }, { label: 'Oct', value: -3, on: true, pick: '2026-10' }, { label: 'No value', value: 'x' }] },
    { kind: 'chart', items: [{ label: 'Sep', value: 10, pick: '2026-09' }] },
    { kind: 'bars', title: 'By kind', items: [{ label: 'Books', value: 300, shown: '300 kr', mark: 250 }] },
    { kind: 'rows', items: [{ title: 'Order 7', right: '99 kr' }, { detail: 'no title' }] },
    { kind: 'list', items: ['one', '', 4] },
    { kind: 'choose', param: 'month', value: '2026-10', options: [{ id: '2026-09', name: 'September' }] },
    { kind: 'choose', param: 'bad param!', options: [{ id: 'a', name: 'A' }] },
    { kind: 'actions', items: [{ label: 'Fetch now', call: '/sync', body: { all: true }, done: 'Fetched' }, { label: 'Out', call: 'https://elsewhere.example/x' }, { label: 'Up', call: '/../x' }, { label: 'Twice', call: '//x' }] },
    { kind: 'fold', title: 'Earlier', blocks: [{ kind: 'text', text: 'old' }, { kind: 'fold', title: 'deeper', blocks: [{ kind: 'text', text: 'x' }] }] },
    { kind: 'script', text: 'alert(1)' },
    { kind: 'text', text: '' },
  ],
})
assert.equal(v.title, 'Shop')
assert.deepEqual(v.blocks.map((b) => b.kind), ['heading', 'tiles', 'chart', 'chart', 'bars', 'rows', 'list', 'choose', 'actions', 'fold'])
const tiles = v.blocks[1]
assert.equal(tiles.items.length, 2, 'a tile needs a label and a value')
assert.equal(tiles.items[1].tone, '', 'an unknown tone is no tone')
const chart = v.blocks[2]
assert.deepEqual(chart.items.map((i) => [i.label, i.value, i.on, i.pick]), [['Sep', 10, false, '2026-09'], ['Oct', 0, true, '2026-10']])
assert.equal(v.blocks[3].items[0].pick, '', 'a bar picks nothing when its chart names no param')
assert.equal(v.blocks[4].items[0].mark, 250)
assert.deepEqual(v.blocks[5].items.map((i) => i.title), ['Order 7'])
assert.deepEqual(v.blocks[6].items, ['one', '4'])
assert.deepEqual(v.blocks[8].items.map((a) => a.call), ['/sync'], 'a button calls only a plain path on the page\'s own server')
assert.deepEqual(v.blocks[8].items[0].body, { all: true })
assert.deepEqual(v.blocks[9].blocks.map((b) => b.kind), ['text'], 'a fold holds no fold')

const many = readView({ blocks: Array.from({ length: 100 }, () => ({ kind: 'heading', text: 'x'.repeat(500) })) })
assert.equal(many.blocks.length, 60)
assert.equal(many.blocks[0].text.length, 80)

assert.equal(viewPath({}), '/phone')
assert.equal(viewPath({ month: '2026-10', review: 'weekly', 'bad key': 'x', empty: '' }), '/phone?month=2026-10&review=weekly')
assert.equal(viewPath({ q: 'a&b' }), '/phone?q=a%26b')
console.log('own view: ok')

// Taps that open a view: `open` holds a few choices, names a view may use only; an empty value takes one away.
import { withOpen } from '../src/ownView.ts'
const drill = readView({
  blocks: [
    { kind: 'rows', items: [{ title: 'Groceries', open: { category: 'Groceries', page: '', 'bad key!': 'x', n: 2 } }, { title: 'Plain', open: 'nope' }, { title: 'Empty', open: { '!': 'x' } }] },
    { kind: 'bars', items: [{ label: 'Food', value: 3, open: { category: 'Food' } }] },
    { kind: 'tiles', items: [{ label: 'Spent', value: '10 kr', open: { tab: 'spending' } }] },
    { kind: 'chart', param: 'month', mark: 7, items: [{ label: 'Oct', value: 5, tone: 'bad', open: { month: '2026-10', category: '' } }] },
    { kind: 'split', title: 'Shares', items: [{ label: 'Food', value: 60, shown: '60 kr', open: { category: 'Food' } }, { label: 'Nothing', value: 0 }, { label: 'Rent', value: 40 }] },
    { kind: 'table', title: 'Months', columns: ['Sep', 'Oct', { x: 1 }], rows: [{ label: 'Spent', cells: ['1', '2', '3'], tones: ['', 'bad', 'pink'], open: { category: 'x' } }, { cells: ['no label'] }] },
    { kind: 'table', columns: [], rows: [{ label: 'x' }] },
    { kind: 'search', param: 'q', value: 'ica', placeholder: 'Search payments' },
    { kind: 'search', param: 'bad param!' },
  ],
})
assert.deepEqual(drill.blocks.map((b) => b.kind), ['rows', 'bars', 'tiles', 'chart', 'split', 'table', 'search'])
assert.deepEqual(drill.blocks[0].items.map((i) => i.open), [{ category: 'Groceries', page: '', n: '2' }, null, null], 'only names a view may use, at most four')
assert.deepEqual(drill.blocks[1].items[0].open, { category: 'Food' })
assert.deepEqual(drill.blocks[2].items[0].open, { tab: 'spending' })
assert.equal(drill.blocks[3].mark, 7)
assert.equal(drill.blocks[3].items[0].tone, 'bad')
assert.deepEqual(drill.blocks[4].items.map((i) => i.label), ['Food', 'Rent'], 'a share of nothing is left out')
assert.deepEqual(drill.blocks[5].columns, ['Sep', 'Oct'], 'a column is words or a number')
assert.equal(drill.blocks[5].rows.length, 1, 'a row needs a label')
assert.deepEqual(drill.blocks[5].rows[0].cells, ['1', '2'], 'a row has a cell per column, no more')
assert.deepEqual(drill.blocks[5].rows[0].tones, ['', 'bad'])
assert.deepEqual(drill.blocks[6], { kind: 'search', param: 'q', value: 'ica', placeholder: 'Search payments' })
assert.deepEqual(withOpen({ month: '2026-10', category: 'Food', page: '2' }, { category: 'Rent', page: '' }), { month: '2026-10', category: 'Rent' })
assert.equal(viewPath(withOpen({}, { category: 'Eating out', q: '' })), '/phone?category=Eating%20out')
console.log('own view taps: ok')

// A form: fields of three kinds, fixed values riding along, and only a plain path of the page's own server to send to.
const forms = readView({ blocks: [
  { kind: 'form', title: 'Budget', call: '/budget', submit: 'Save', done: 'Saved.', fixed: { category: 'Groceries', 'bad key!': 'x', n: 3 },
    fields: [{ name: 'amount', label: 'A month', kind: 'number', value: 4000 }, { name: 'note', label: 'Note', kind: 'weird' }, { name: 'cat', label: 'Category', kind: 'choice', options: [{ id: 'a', name: 'A' }] }, { name: 'empty', label: 'No options', kind: 'choice', options: [] }, { name: 'bad name!', label: 'x' }] },
  { kind: 'form', call: 'https://elsewhere.example/x', fields: [{ name: 'a', label: 'A' }] },
  { kind: 'form', call: '/x', fields: [] },
] })
assert.equal(forms.blocks.length, 1, 'a form needs a plain path and a field')
const form = forms.blocks[0]
assert.deepEqual(form.fixed, { category: 'Groceries', n: '3' })
assert.deepEqual(form.fields.map((f) => [f.name, f.kind, f.value]), [['amount', 'number', '4000'], ['note', 'text', ''], ['cat', 'choice', '']])
assert.equal(form.submit, 'Save')
console.log('own view forms: ok')

// A hero number, compact alerts, a quiet footnote and a chart's note.
const slim = readView({ blocks: [
  { kind: 'hero', label: 'Safe to spend', value: '10 754 kr', note: 'a day', tone: 'good', open: { tab: 'upcoming' } },
  { kind: 'hero', label: 'No value' },
  { kind: 'alerts', title: 'Worth a look', items: [{ title: 'Health is high', text: 'More than usual.', tone: 'warn' }, { text: 'no title' }] },
  { kind: 'text', text: 'small', quiet: true },
  { kind: 'chart', note: 'usual 5 kr', items: [{ label: 'Oct', value: 1 }] },
] })
assert.deepEqual(slim.blocks.map((b) => b.kind), ['hero', 'alerts', 'text', 'chart'])
assert.deepEqual(slim.blocks[0].open, { tab: 'upcoming' })
assert.equal(slim.blocks[1].items.length, 1)
assert.equal(slim.blocks[2].quiet, true)
assert.equal(slim.blocks[3].note, 'usual 5 kr')
console.log('own view slim: ok')
