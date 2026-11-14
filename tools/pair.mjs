/**
 * Shows a QR code that pairs a device with this PC. The first pairing also makes the settings of
 * the phone's door, which stays closed until a phone has been paired. The map's Setup does the same
 * with no terminal: Setup, then Pair a phone.
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
import fs from 'node:fs'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import { configDir } from '../studio/server/lib/home.mjs'
import { pairPhone } from '../studio/server/lib/pairing.mjs'

const folder = configDir()
const words = process.argv.slice(2)
const nameAt = words.indexOf('--name')
const name = nameAt >= 0 ? words[nameAt + 1] : 'New device'
const flags = new Set(words.filter((word) => word === '--edge' || word === '--link'))
const addresses = words.filter((word, index) => !flags.has(word) && (nameAt < 0 || (index !== nameAt && index !== nameAt + 1)))

let edge = null
if (flags.has('--edge')) {
  const edgeFile = path.join(folder, 'edge.json')
  const got = fs.existsSync(edgeFile) ? JSON.parse(fs.readFileSync(edgeFile, 'utf8')) : {}
  const studio = String(got.studio || '').replace(/^(?!https:\/\/)/, 'https://').replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+$/.test(studio) || !/^[0-9a-f]{64}$/.test(got.gate || '')) {
    console.error(`--edge needs ${edgeFile} with a studio address and a 64-character gate (see edge/README.md).`)
    process.exit(1)
  }
  edge = { studio, gate: got.gate }
}

let paired
try {
  paired = pairPhone({ name, host: addresses[0] || '', edge })
} catch (err) {
  console.error(`${err.message}. Or pass an address: npm run pair -- 192.168.1.20`)
  process.exit(1)
}
console.log(`Pairing with ${paired.host}:${paired.port}. Scan this with your phone camera:\n`)
qrcode.generate(paired.link, { small: true })
if (flags.has('--link')) console.log(`\nOr open this link on the phone (it is the key: keep it to yourself):\n${paired.link}`)
if (paired.first) console.log('\nThis was the first pairing, so the phone\'s door was closed until now.\nStart Botyard again and it opens: systemctl --user restart botyard.service, or stop `npm start` and start it again.\nPairing from the map\'s Setup opens the door at once, with no restart.')
