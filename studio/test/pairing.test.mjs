/**
 * Pairing a phone: the door's settings under the names the door reads, one key per phone, and the
 * map's Pair a phone, which opens the door at once with no restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureDoor, localAddresses, pairPhone, readDoor } from '../server/lib/pairing.mjs'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pair-'))
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

test('the first pairing writes the door settings with the names the door reads, open to the home network', () => {
  const dir = temp()
  const file = path.join(dir, 'phone.env')
  const devices = path.join(dir, 'devices.json')
  const { settings, made } = ensureDoor({ file, devices })
  assert.equal(made, true)
  assert.match(settings.BOTYARD_PHONE_TOKEN, /^[0-9a-f]{64}$/)
  assert.deepEqual([settings.BOTYARD_PHONE_HOST, settings.BOTYARD_PHONE_PORT], ['0.0.0.0', '5288'])
  assert.equal(JSON.parse(fs.readFileSync(devices, 'utf8')).sharedRetired, true, 'the shared token opens nothing')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by its owner alone')
  // A second pairing keeps the token.
  assert.equal(ensureDoor({ file, devices }).settings.BOTYARD_PHONE_TOKEN, settings.BOTYARD_PHONE_TOKEN)
})

test('a door file from an earlier copy, written with the old names, is read and written again with the new ones', () => {
  const dir = temp()
  const file = path.join(dir, 'phone.env')
  fs.writeFileSync(file, `BOTYARD_PHONE_TOKEN=${'b'.repeat(64)}\nSTUDIO_PHONE_HOST=0.0.0.0\nSTUDIO_PHONE_PORT=6100\n`)
  assert.equal(readDoor(file).BOTYARD_PHONE_PORT, '6100')
  ensureDoor({ file, devices: path.join(dir, 'devices.json') })
  const text = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /STUDIO_PHONE/)
  assert.match(text, /^BOTYARD_PHONE_HOST=0\.0\.0\.0$/m)
  assert.match(text, /^BOTYARD_PHONE_PORT=6100$/m)
  assert.match(text, new RegExp(`^BOTYARD_PHONE_TOKEN=${'b'.repeat(64)}$`, 'm'))
})

test('a pairing link carries the address, the port and a key of its own for each phone', () => {
  const dir = temp()
  const options = { file: path.join(dir, 'phone.env'), devices: path.join(dir, 'devices.json') }
  const one = pairPhone({ ...options, name: 'Phone one', host: '192.168.1.20' })
  const two = pairPhone({ ...options, name: 'Phone two', host: '192.168.1.20' })
  assert.match(one.link, /^botyard:\/\/connect\?host=192\.168\.1\.20%3A5288&token=[0-9a-f]{64}&device=[0-9a-f-]{36}$/)
  assert.notEqual(one.link, two.link)
  assert.deepEqual([one.first, two.first, two.phones], [true, false, 2])
  // Only a hash of each key is kept.
  assert.ok(!fs.readFileSync(options.devices, 'utf8').includes(new URL(one.link.replace('botyard:', 'http:')).searchParams.get('token')))
})

test('the address offered is one on the local network, a home network first, never a container or tunnel', () => {
  const at = (address, internal = false) => ({ address, family: 'IPv4', internal })
  assert.deepEqual(localAddresses({ lo: [at('127.0.0.1', true)], docker0: [at('172.17.0.1')], wg0: [at('10.88.0.1')], eth0: [at('10.0.0.5')], wlan0: [at('192.168.1.20'), at('169.254.3.3')] }), ['192.168.1.20', '10.0.0.5'])
  assert.throws(() => pairPhone({ file: path.join(temp(), 'p.env'), devices: path.join(temp(), 'd.json'), interfaces: {} }), /no address on a network/)
})

test('pairing from the map opens the closed door at once, and the new key gets in', async (t) => {
  const home = temp()
  const ports = { PORT: await freePort(), BOTYARD_ENGINE_PORT: await freePort(), BOTYARD_PHONE_PORT: await freePort(), BOTYARD_PREVIEW_PORT: await freePort() }
  const env = { PATH: process.env.PATH, HOME: home, BOTYARD_HOME: path.join(home, 'yard'), BOTYARD_PHONE_HOST: '127.0.0.1', BOTYARD_ENGINE_RUNS: 'off', BOTYARD_TIMETABLE: 'off', NODE_NO_WARNINGS: '1', BOTYARD_REFUSE_BOTS: 'off', ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])) }
  const child = spawn(process.execPath, [path.join(studio, 'server', 'studio.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGTERM'))
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const end = Date.now() + 60000
  while (!out.includes('Botyard →') && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 50))
  assert.match(out, /Botyard →/, out)
  const at = `http://127.0.0.1:${ports.PORT}/api/studio/pair`
  let state = await (await fetch(at)).json()
  assert.deepEqual([state.open, state.phones], [false, 0])
  const paired = await (await fetch(at, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test phone', host: '192.168.1.20' }) })).json()
  assert.equal(paired.open, true, paired.why)
  assert.equal(paired.port, ports.BOTYARD_PHONE_PORT)
  const key = new URL(paired.link.replace('botyard:', 'http:')).searchParams.get('token')
  const door = `http://127.0.0.1:${ports.BOTYARD_PHONE_PORT}/v1/first-run`
  assert.equal((await fetch(door)).status, 401, 'no key, no way in')
  const first = await fetch(door, { headers: { Authorization: `Bearer ${key}` } })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).steps.find((s) => s.id === 'phone').state, 'done')
  state = await (await fetch(at)).json()
  assert.deepEqual([state.open, state.phones], [true, 1])
  // The link is the key: a page on another site is not given one.
  const refused = await fetch(at, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })
  assert.equal(refused.status, 403)
})
