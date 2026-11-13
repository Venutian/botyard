/**
 * Folder names come from one place. These pin where each folder is, that a home chosen by hand
 * holds everything, and that the folders with keys in them are closed to everyone but the owner.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configDir, crewDir, crewScripts, dataDir, home, keysDir, places, projectsDir, repoRoot, runLogs, studioRoot } from '../server/lib/home.mjs'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'))

test('a home chosen by hand holds everything', () => {
  const root = temp()
  const env = { BOTYARD_HOME: path.join(root, 'mine'), HOME: root }
  assert.equal(home(env), path.join(root, 'mine'))
  assert.equal(dataDir(env), path.join(root, 'mine'))
  assert.equal(runLogs(env), path.join(root, 'mine', 'run-logs'))
  assert.equal(crewDir(env), path.join(root, 'mine', 'crew'))
  assert.equal(keysDir(env), path.join(root, 'mine', 'keys'))
  assert.equal(configDir(env), path.join(root, 'mine', 'config'))
  assert.equal(projectsDir(env), path.join(root, 'mine', 'projects'))
  for (const dir of [home(env), runLogs(env), crewDir(env), keysDir(env), configDir(env), projectsDir(env)]) assert.ok(fs.statSync(dir).isDirectory(), dir)
})

test('with no home chosen it is ~/.botyard, whatever else is on the computer', () => {
  const root = temp()
  // Folders an earlier setup might have left are not looked at: there is one home.
  fs.mkdirSync(path.join(root, '.config', 'botyard-keys'), { recursive: true })
  const all = places({ HOME: root })
  assert.equal(all.home, path.join(root, '.botyard'))
  assert.equal(all.data, all.home)
  for (const [name, dir] of Object.entries(all)) assert.ok(dir === all.home || dir.startsWith(all.home + path.sep), `${name} is inside the home`)
  assert.equal(places({ HOME: root, BOTYARD_HOME: '  ' }).home, all.home)
})

test('the folders that hold keys are the owner\'s alone, also when they were there already and open', { skip: process.platform === 'win32' }, () => {
  const root = temp()
  const env = { BOTYARD_HOME: root }
  fs.mkdirSync(path.join(root, 'keys'), { mode: 0o755 })
  assert.equal(fs.statSync(keysDir(env)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(configDir(env)).mode & 0o777, 0o700)
})

test('places() only says where: it makes nothing', () => {
  const root = temp()
  places({ BOTYARD_HOME: path.join(root, 'none') })
  assert.equal(fs.existsSync(path.join(root, 'none')), false)
})

test('the code\'s own folders are the checkout', () => {
  assert.ok(fs.existsSync(path.join(studioRoot(), 'package.json')))
  assert.equal(crewScripts(), path.join(repoRoot(), 'crew'))
})
