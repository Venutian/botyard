/**
 * The picture taker's own rules, without a browser: which pictures there are, and that it says
 * plainly when it cannot work. Taking the pictures themselves needs a browser and is run by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, findBrowser, takeShots } from '../tools/shots.mjs'

test('the pictures are the ones the front page shows: the map by day and night, what needs you, a job, a run, a bot\'s settings and instructions, Setup, the phone', () => {
  assert.deepEqual(SHOTS.map((shot) => shot.name), ['crewmap', 'crewmap-night', 'map', 'needs', 'job', 'run', 'crew', 'rules', 'setup', 'night', 'phone'])
  // Every picture the front page points to is one this takes, and it takes no other.
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
  const used = [...readme.matchAll(/studio\/docs\/images\/([\w-]+\.png)/g)].map((found) => found[1]).sort()
  assert.deepEqual(SHOTS.map((shot) => shot.file).sort(), used)
  assert.equal(new Set(SHOTS.map((shot) => shot.file)).size, SHOTS.length)
  for (const shot of SHOTS) {
    assert.match(shot.file, /^[a-z-]+\.png$/)
    assert.ok(shot.what.length > 10 && shot.view, `${shot.name} says what it shows and which view it is`)
    // A view that opens a panel must put something on the page before it counts.
    // One that replaces the home's own words (the yard, the crew map at night) must still say something (`fewer`).
    if (shot.clicks.length) assert.ok(shot.needs >= 50 || shot.fewer, `${shot.name} is not taken empty`)
  }
})

test('a browser is found where one is installed, the one named first', () => {
  assert.equal(findBrowser({}, () => false), '')
  assert.equal(findBrowser({}, (file) => file === '/usr/bin/chromium'), '/usr/bin/chromium')
  assert.equal(findBrowser({ BOTYARD_BROWSER: '/opt/mine' }, () => true), '/opt/mine')
})

test('it says so when it cannot work, before starting anything', async () => {
  await assert.rejects(takeShots({ names: ['nothing'], log: () => {} }), /No picture is called nothing\. There are: crewmap, crewmap-night, map, needs, job, run, crew, rules, setup, night, phone/)
  await assert.rejects(takeShots({ browser: '', log: () => {} }), /No browser was found/)
})
