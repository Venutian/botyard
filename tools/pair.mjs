/**
 * Shows a QR code that pairs a device with this PC. The first pairing also makes the settings of
 * the phone's door, which stays closed until a phone has been paired.
 * Each code holds a new key for that device, so
 * it can be cut off alone later. The door keeps only a hash of the key, and the key stays on this
 * screen.
 *
 * Usage: npm run pair                          uses this PC's address on the local network
 *        npm run pair -- <host>                uses another address
 *        npm run pair -- --name "Pixel 9"      names the device in the app's device list
 *        npm run pair -- --edge                also puts the Cloudflare way in the code (config/edge.json),
 *                                              so a phone away from home can pair through it
 *        npm run pair -- --link                prints the link as text too, to open on the phone itself
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import { configDir } from '../studio/server/lib/home.mjs'

// The door's own settings and its keyring are in the yard's home: $BOTYARD_HOME/config.
const folder = configDir()
const envFile = path.join(folder, 'phone.env')
const devicesFile = path.join(folder, 'devices.json')

/**
 * The first pairing of a yard makes the door's settings: until then Botyard starts with the phone's
 * door closed. The door will not start without a token of its own, so one is made here; it is marked
 * retired at once, because every phone gets its own key and nothing ever needs the shared one.
 */
let first = false
if (!fs.existsSync(envFile)) {
  first = true
  fs.writeFileSync(envFile, `BOTYARD_PHONE_TOKEN=${randomBytes(32).toString('hex')}\nSTUDIO_PHONE_HOST=0.0.0.0\nSTUDIO_PHONE_PORT=5288\n`, { mode: 0o600 })
  if (!fs.existsSync(devicesFile)) fs.writeFileSync(devicesFile, JSON.stringify({ sharedRetired: true, devices: [] }, null, 2), { mode: 0o600 })
}
const settings = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split('\n').filter((line) => line.includes('=')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1).trim()]
  }),
)

function localAddress() {
  const addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth)/.test(name))
    .flatMap(([, entries]) => entries)
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
  return addresses[0]?.address
}

const words = process.argv.slice(2)
const nameAt = words.indexOf('--name')
const name = nameAt >= 0 ? words[nameAt + 1] : 'New device'
const flags = new Set(words.filter((word) => word === '--edge' || word === '--link'))
const addresses = words.filter((word, index) => !flags.has(word) && (nameAt < 0 || (index !== nameAt && index !== nameAt + 1)))

const port = settings.BOTYARD_PHONE_PORT || '5288'
const host = addresses[0] || localAddress()
if (!host) {
  console.error('No network address found. Pass one: npm run pair -- 100.x.y.z')
  process.exit(1)
}

function addDevice() {
  const state = fs.existsSync(devicesFile) ? JSON.parse(fs.readFileSync(devicesFile, 'utf8')) : { sharedRetired: false, devices: [] }
  const key = randomBytes(32).toString('hex')
  const id = randomUUID()
  state.devices.push({ id, name, hash: createHash('sha256').update(key).digest('hex'), createdAt: new Date().toISOString(), lastSeen: '' })
  const temporary = `${devicesFile}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, devicesFile)
  return { id, key }
}

const target = host.includes(':') ? host : `${host}:${port}`
const device = addDevice()
let link = `botyard://connect?host=${encodeURIComponent(target)}&token=${device.key}&device=${device.id}`
if (flags.has('--edge')) {
  const edgeFile = path.join(folder, 'edge.json')
  const edge = fs.existsSync(edgeFile) ? JSON.parse(fs.readFileSync(edgeFile, 'utf8')) : {}
  const studio = String(edge.studio || '').replace(/^(?!https:\/\/)/, 'https://').replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+$/.test(studio) || !/^[0-9a-f]{64}$/.test(edge.gate || '')) {
    console.error(`--edge needs ${edgeFile} with a studio address and a 64-character gate (see edge/README.md).`)
    process.exit(1)
  }
  link += `&edge=${encodeURIComponent(studio)}&gate=${edge.gate}`
}
console.log(`Pairing with ${target}. Scan this with your phone camera:\n`)
qrcode.generate(link, { small: true })
if (flags.has('--link')) console.log(`\nOr open this link on the phone (it is the key: keep it to yourself):\n${link}`)
if (first) console.log('\nThis was the first pairing, so the phone\'s door was closed until now.\nStart Botyard again and it opens: systemctl --user restart botyard.service, or stop `npm start` and start it again.')
