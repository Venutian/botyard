import assert from 'node:assert/strict'
import { normalizeHost, pickWay, unreachable, wayLabel, ways } from '../src/connection.ts'

assert.equal(normalizeHost('192.168.0.15:5288'), 'http://192.168.0.15:5288')
assert.equal(normalizeHost('https://studio.example.org/'), 'https://studio.example.org')
assert.equal(normalizeHost(' 10.88.0.1:5288 '), 'http://10.88.0.1:5288')

assert.equal(wayLabel('home'), 'home Wi-Fi')
assert.equal(wayLabel('away'), 'WireGuard')
assert.equal(wayLabel('edge'), 'Cloudflare')

const full = {
  host: '192.168.0.15:5288',
  away: '10.88.0.1:5288',
  edge: { host: 'https://studio.example.org', gate: 'a'.repeat(64) },
}
assert.deepEqual(ways(full).map((way) => way.name), ['home', 'away', 'edge'])
assert.deepEqual(ways(full).map((way) => way.base), [
  'http://192.168.0.15:5288',
  'http://10.88.0.1:5288',
  'https://studio.example.org',
])
assert.equal(ways(full)[2].headers['X-Botyard-Gate'], 'a'.repeat(64))
assert.deepEqual(ways({ host: 'http://10.88.0.1:5288', away: '10.88.0.1:5288' }).map((way) => way.name), ['home'])

assert.equal(
  unreachable(full),
  'Cannot reach the studio on home Wi-Fi, WireGuard or Cloudflare. Check the PC is on and the phone has internet.',
)
assert.equal(
  unreachable({ host: '192.168.0.15:5288' }),
  'Cannot reach the studio on home Wi-Fi. Check the PC is on and on this network.',
)
assert.equal(
  unreachable({ host: '192.168.0.15:5288', away: '10.88.0.1:5288' }),
  'Cannot reach the studio on home Wi-Fi or WireGuard. Check the PC is on, and turn WireGuard on when you are away from home.',
)

// Away from home, on mobile data, home Wi-Fi and WireGuard never answer and Cloudflare takes its
// time. The app must knock home first, then WireGuard, then Cloudflare, and reach Cloudflare
// inside the five seconds the app promises.
const knocked = []
const started = Date.now()
const chosen = await pickWay(ways(full), (way) => {
  knocked.push(way.name)
  if (way.name !== 'edge') return new Promise(() => {}) // out of reach, so it never answers
  return new Promise((resolve) => setTimeout(() => resolve(way), 900))
})
assert.deepEqual(knocked, ['home', 'away', 'edge'])
assert.equal(chosen.name, 'edge')
assert.ok(Date.now() - started < 5000, `Cloudflare took ${Date.now() - started} ms`)

// A way that answers straight away wins, and the others are not knocked at all.
const first = []
const winner = await pickWay(ways(full), (way) => {
  first.push(way.name)
  return Promise.resolve(way)
})
assert.deepEqual(first, ['home'])
assert.equal(winner.name, 'home')

// A way that fails hands over to the next at once, rather than waiting for its head start.
const tried = []
const startedAgain = Date.now()
const second = await pickWay(ways(full), (way) => {
  tried.push(way.name)
  if (way.name === 'home') return Promise.reject(new Error('no answer'))
  return Promise.resolve(way)
})
assert.deepEqual(tried, ['home', 'away'])
assert.equal(second.name, 'away')
assert.ok(Date.now() - startedAgain < 400, `the next way waited ${Date.now() - startedAgain} ms`)

// When no way answers, the app says so rather than waiting for each in turn.
await assert.rejects(
  () => pickWay(ways(full), () => Promise.reject(new Error('no answer'))),
  /Cannot reach the studio/,
)

console.log('connection tests pass')
