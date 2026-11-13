/**
 * The one unit Botyard installs. Pinned: it starts the one entry, it leaves each run's keeper
 * alone on a restart, and `--dry` prints it without touching the computer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AGENT, UNIT, carried, plistText, unitText } from '../tools/install.mjs'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the unit runs the one entry and stops only Botyard itself', () => {
  const text = unitText({ studio: '/srv/yard/studio', node: '/opt/node/bin/node', home: '/home/someone' })
  assert.equal(UNIT, 'botyard.service')
  assert.match(text, /^WorkingDirectory=\/srv\/yard\/studio$/m)
  assert.match(text, /^ExecStart="\/opt\/node\/bin\/node" server\/studio\.mjs$/m)
  assert.match(text, /^KillMode=process$/m)
  assert.match(text, /^Restart=on-failure$/m)
  assert.match(text, /^WantedBy=default\.target$/m)
  assert.match(text, /^Environment="PATH=\/opt\/node\/bin:\/home\/someone\/\.local\/bin:\/home\/someone\/\.npm-global\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"$/m)
})

test('a home or a port chosen for the install is carried into the unit, and nothing else is', () => {
  const variables = carried({ BOTYARD_HOME: '/data/studio', PORT: '6000', SECRET_TOKEN: 'never', HOME: '/home/x' })
  assert.deepEqual(variables, { BOTYARD_HOME: '/data/studio', PORT: '6000' })
  const text = unitText({ studio: '/s', node: '/n/node', home: '/h', variables })
  assert.match(text, /^Environment="BOTYARD_HOME=\/data\/studio"$/m)
  assert.doesNotMatch(text, /never/)
})

test('a path is written so systemd reads it as it is, and a line break is refused', () => {
  assert.match(unitText({ studio: '/srv/100%/studio', node: '/n/node', home: '/h' }), /^WorkingDirectory=\/srv\/100%%\/studio$/m)
  assert.throws(() => unitText({ studio: '/srv/a\nExecStart=/bin/evil', node: '/n/node', home: '/h' }), /line break/)
})

test('--dry prints the unit for this checkout and changes nothing', () => {
  const out = execFileSync(process.execPath, [path.join(studio, 'tools', 'install.mjs'), '--dry'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent-home' } })
  assert.match(out, new RegExp(`^WorkingDirectory=${studio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.match(out, /^KillMode=process$/m)
})

test('the macOS launch agent starts the one entry at login, starts it again if it fails, and leaves the runs\' keepers alone', () => {
  const text = plistText({ studio: '/Users/someone/botyard/studio', node: '/opt/homebrew/bin/node', home: '/Users/someone', variables: { BOTYARD_HOME: '/Volumes/Work & Play/yard' } })
  assert.equal(AGENT, 'org.botyard')
  assert.match(text, /<key>Label<\/key><string>org\.botyard<\/string>/)
  assert.match(text, /<array><string>\/opt\/homebrew\/bin\/node<\/string><string>\/Users\/someone\/botyard\/studio\/server\/studio\.mjs<\/string><\/array>/)
  assert.match(text, /<key>WorkingDirectory<\/key><string>\/Users\/someone\/botyard\/studio<\/string>/)
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(text, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/, 'stopping the agent does not stop a bot in the middle of its work')
  // The tools a Mac usually has them in, and what was chosen for this install; a name is written safely.
  assert.match(text, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/local\/bin:/)
  assert.match(text, /<key>BOTYARD_HOME<\/key><string>\/Volumes\/Work &amp; Play\/yard<\/string>/)
  assert.match(text, /<key>StandardErrorPath<\/key><string>\/Volumes\/Work &amp; Play\/yard\/launcher\/server-error\.log<\/string>/)
  assert.equal((text.match(/<dict>/g) || []).length, (text.match(/<\/dict>/g) || []).length)
})
