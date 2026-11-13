/**
 * What a person may choose about the map, kept in this browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MapSettings, QUALITIES } from '../src/yard/settings.js'

const KEY = 'botyard.map.v2'
const fakeStore = (start = {}) => {
  const data = { ...start }
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) } }
}

test('the defaults are day, medium and no notifications', () => {
  const s = new MapSettings(fakeStore())
  assert.equal(s.get('shift'), 'day')
  assert.equal(s.get('quality'), 'mid')
  assert.equal(s.get('notify'), false)
  assert.ok(Object.hasOwn(QUALITIES, 'low') && Object.hasOwn(QUALITIES, 'mid') && Object.hasOwn(QUALITIES, 'high'))
})

test('a choice is kept in the store and found again by the next settings', () => {
  const store = fakeStore()
  const s = new MapSettings(store)
  assert.equal(s.set('shift', 'night'), true)
  assert.equal(s.set('quality', 'high'), true)
  assert.equal(s.set('notify', true), true)
  assert.deepEqual(JSON.parse(store.data[KEY]), { shift: 'night', quality: 'high', notify: true })
  const again = new MapSettings(store)
  assert.equal(again.get('shift'), 'night')
  assert.equal(again.get('quality'), 'high')
  assert.equal(again.get('notify'), true)
})

test('a bad stored value is tidied', () => {
  const s = new MapSettings(fakeStore({ [KEY]: JSON.stringify({ shift: 'dusk', quality: 'ultra', notify: 'yes' }) }))
  assert.equal(s.get('shift'), 'day')
  assert.equal(s.get('quality'), 'mid')
  assert.equal(s.get('notify'), false)
  assert.equal(new MapSettings(fakeStore({ [KEY]: '{torn' })).get('quality'), 'mid')
  assert.equal(new MapSettings(fakeStore({ [KEY]: 'null' })).get('shift'), 'day')
})

test('a bad value set is tidied and does not count as a change when it lands on the same', () => {
  const s = new MapSettings(fakeStore())
  assert.equal(s.set('quality', 'ultra'), false)
  assert.equal(s.get('quality'), 'mid')
  assert.equal(s.set('notify', 'yes'), false)
})

test('watchers are told after a change, and not when nothing changed', () => {
  const s = new MapSettings(fakeStore())
  const told = []
  const stop = s.watch((name, value) => told.push([name, value, s.get(name)]))
  s.set('shift', 'night')
  s.set('shift', 'night')
  s.set('quality', 'mid')
  s.set('quality', 'low')
  assert.deepEqual(told, [['shift', 'night', 'night'], ['quality', 'low', 'low']])
  stop()
  s.set('quality', 'high')
  assert.equal(told.length, 2, 'a watcher that stopped hears nothing')
})

test('without a store, or with one that refuses, the choice still holds for the visit', () => {
  const none = new MapSettings(null)
  none.set('shift', 'night')
  assert.equal(none.get('shift'), 'night')
  const refusing = new MapSettings({ getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } })
  assert.doesNotThrow(() => refusing.set('quality', 'low'))
  assert.equal(refusing.get('quality'), 'low')
})
