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
