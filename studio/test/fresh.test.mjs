/** A page left open reloads itself when the service hands out a new build, never under the owner's hands. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pageBuild } from '../server/lib/built-page.mjs'
import { busy, ownBuild, shouldReload } from '../src/ui/fresh.js'

const doc = ({ scripts = [], active = null, dialogs = [] } = {}) => ({
  activeElement: active,
  querySelectorAll: () => scripts.map((src) => ({ getAttribute: () => src })),
  querySelector: () => (dialogs.length ? dialogs[0] : null),
})

test('the service names the build it hands out, and a new build is seen at once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'))
  assert.equal(pageBuild(dir), '', 'no build, no name')
  fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-AAAA1111.js"></script>')
  assert.equal(pageBuild(dir), 'assets/index-AAAA1111.js')
  const later = Date.now() / 1000 + 5
  fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-BBBB2222.js"></script>')
  fs.utimesSync(path.join(dir, 'index.html'), later, later)
  assert.equal(pageBuild(dir), 'assets/index-BBBB2222.js')
})

test('the page knows its own build; the dev server has none, so it never reloads', () => {
  assert.equal(ownBuild(doc({ scripts: ['/assets/index-AAAA1111.js'] })), 'assets/index-AAAA1111.js')
  assert.equal(ownBuild(doc({ scripts: ['/src/main.js'] })), '')
})

test('it reloads on another build only, and waits while a field has the focus or a dialog is open', () => {
  assert.equal(shouldReload('assets/a.js', 'assets/b.js', false), true)
  assert.equal(shouldReload('assets/a.js', 'assets/a.js', false), false)
  assert.equal(shouldReload('assets/a.js', '', false), false, 'a service with no build says nothing')
  assert.equal(shouldReload('assets/a.js', 'assets/b.js', true), false)
  assert.equal(busy(doc({ active: { tagName: 'TEXTAREA' } })), true)
  assert.equal(busy(doc({ active: { tagName: 'DIV', isContentEditable: true } })), true)
  assert.equal(busy(doc({ dialogs: [{}] })), true)
  assert.equal(busy(doc({ active: { tagName: 'BUTTON' } })), false)
})
