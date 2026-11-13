#!/usr/bin/env node
/**
 * Away access: the phone reaches this PC through a WireGuard tunnel. No account, no service in
 * between, nothing to pay for. WireGuard does not answer anyone without the phone's key, so the
 * port it opens on the router shows nothing to a scan.
 *
 * Usage: node tools/away.mjs make          makes the PC's key and settings, once
 *        node tools/away.mjs show          prints what to enter in the WireGuard app on the phone
 *        node tools/away.mjs phone <key>   takes the public key the phone's WireGuard app made
 *        sudo sh tools/away-install.sh     installs WireGuard and starts the PC's end, once
 *        node tools/away.mjs keep          keeps the router's port open; a timer runs this
 *        node tools/away.mjs close         closes the router's port
 *
 * The phone makes its own key and only its public half comes here, so no private key is ever
 * shown, sent or copied. The router's port is opened over UPnP, and only on the router this PC
 * routes through.
 */
import { generateKeyPairSync } from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from '../studio/server/lib/home.mjs'

const FOLDER = path.join(configDir(), 'away')
const PC_CONF = path.join(FOLDER, 'pc.conf')
const PHONE_KEY = path.join(FOLDER, 'phone.pub')
const OLD_PHONE_CONF = path.join(FOLDER, 'phone.conf')
const STATE = path.join(FOLDER, 'away.json')
const INSTALLED = '/etc/wireguard/botyard.conf'
const INTERFACE = 'botyard'
const PC = '10.88.0.1'
const PHONE = '10.88.0.2'
const PORT = 51820
const LEASE_S = 3600
const ONLY_PERMANENT_LEASES = 725
const LABEL = 'Botyard away access'
// A WireGuard key: 32 bytes in base64, which always ends in one of these letters and an equals sign.
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
const ANSWER_MS = 5000
const SEARCH_MS = 2500
const SEARCH = Buffer.from([
  'M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2',
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', '',
].join('\r\n'))

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function save(state) {
  const next = `${STATE}.${process.pid}.tmp`
  fs.writeFileSync(next, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(next, STATE)
}

/** The router this PC sends its traffic through, from the kernel's routing table. */
function defaultGateway() {
  for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/)
    if (destination === '00000000' && gateway && gateway !== '00000000') {
      return Buffer.from(gateway, 'hex').reverse().join('.')
    }
  }
  return null
}

/** The router's UPnP control address. Only the default gateway counts, so another device cannot pose as it. */
async function findRouter() {
  const gateway = defaultGateway()
  if (!gateway) return null
  const socket = dgram.createSocket('udp4')
  const locations = new Set()
  socket.on('message', (message, from) => {
    const location = /^location:\s*(\S+)/im.exec(message.toString())?.[1]
    if (location && from.address === gateway) locations.add(location)
  })
  await new Promise((resolve) => socket.bind(() => {
    socket.send(SEARCH, 1900, '239.255.255.250')
    setTimeout(resolve, SEARCH_MS)
  }))
  socket.close()
  for (const location of locations) {
    if (new URL(location).hostname !== gateway) continue
    const description = await (await fetch(location, { signal: AbortSignal.timeout(ANSWER_MS) })).text()
    for (const kind of ['WANIPConnection', 'WANPPPConnection']) {
      const found = new RegExp(`<serviceType>(urn:schemas-upnp-org:service:${kind}:\\d)</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>`).exec(description)
      if (found) return { gateway, service: found[1], control: new URL(found[2], location).href }
    }
  }
  return null
}

async function ask(router, action, args = {}) {
  const fields = Object.entries(args).map(([name, value]) => `<${name}>${value}</${name}>`).join('')
  const body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${router.service}">${fields}</u:${action}></s:Body></s:Envelope>`
  const res = await fetch(router.control, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${router.service}#${action}"` },
    body,
    signal: AbortSignal.timeout(ANSWER_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const code = Number(/<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1]) || res.status
    throw Object.assign(new Error(`The router refused ${action} (${code})`), { code })
  }
  return text
}

const field = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] || ''

/** This PC's address on the home network, as the router sees it. */
function localAddress(gateway) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.on('error', reject)
    socket.connect(9, gateway, () => {
      const { address } = socket.address()
      socket.close()
      resolve(address)
    })
  })
}

async function internetAddress(router) {
  const address = field(await ask(router, 'GetExternalIPAddress'), 'NewExternalIPAddress')
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? address : ''
}

async function mappedTo(router) {
  try {
    return field(await ask(router, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: PORT, NewProtocol: 'UDP' }), 'NewInternalClient')
  } catch {
    return ''
  }
}

async function openPort(router, local) {
  const mapping = (lease) => ({
    NewRemoteHost: '', NewExternalPort: PORT, NewProtocol: 'UDP', NewInternalPort: PORT, NewInternalClient: local,
    NewEnabled: 1, NewPortMappingDescription: LABEL, NewLeaseDuration: lease,
  })
  try {
    await ask(router, 'AddPortMapping', mapping(LEASE_S))
  } catch (err) {
    if (err.code !== ONLY_PERMANENT_LEASES) throw err
    await ask(router, 'AddPortMapping', mapping(0))
  }
  return (await mappedTo(router)) === local
}

/** Closes the port only if it still leads to this PC, so another device's opening is left alone. */
async function closePort(router, local) {
  if ((await mappedTo(router)) !== local) return false
  await ask(router, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: PORT, NewProtocol: 'UDP' })
  return true
}

/** WireGuard keys are Curve25519 keys in base64. Node makes them; WireGuard need not be installed yet. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const raw = (key, part) => Buffer.from(key.export({ format: 'jwk' })[part], 'base64url').toString('base64')
  return { secret: raw(privateKey, 'd'), shared: raw(publicKey, 'x') }
}

async function make(again) {
  if (!again && (fs.existsSync(STATE) || fs.existsSync(INSTALLED))) {
    throw new Error('Away access is already made. Run with --again to make a new PC key; the phone then needs it.')
  }
  const router = await findRouter()
  if (!router) throw new Error('No router answered over UPnP. Turn on UPnP on the router, or open UDP port 51820 to this PC by hand.')
  const endpoint = await internetAddress(router)
  if (!endpoint) throw new Error('The router did not say its internet address.')
  const lan = await localAddress(router.gateway)
  const pc = keyPair()
  fs.mkdirSync(FOLDER, { recursive: true, mode: 0o700 })
  fs.chmodSync(FOLDER, 0o700)
  // The phone's half is added by tools/away-install.sh, from the public key the phone made.
  fs.writeFileSync(PC_CONF, [
    '# Botyard away access, the PC end. tools/away-install.sh moves this to /etc/wireguard/botyard.conf.',
    '[Interface]',
    `Address = ${PC}/24`,
    `ListenPort = ${PORT}`,
    `PrivateKey = ${pc.secret}`,
    '',
  ].join('\n'), { mode: 0o600 })
  for (const stale of [PHONE_KEY, OLD_PHONE_CONF]) fs.rmSync(stale, { force: true })
  save({ address: PC, phone: PHONE, port: PORT, interface: INTERFACE, pcKey: pc.shared, lan, endpoint, phoneEndpoint: endpoint, mapped: false, checkedAt: new Date().toISOString() })
  console.log(`Made. This home's internet address is ${endpoint}.`)
  console.log('Next: node tools/away.mjs show, and enter that in the WireGuard app on the phone.')
}

/** What to enter in the phone's WireGuard app. None of it is secret. */
function show() {
  const state = readJson(STATE)
  if (!state?.pcKey) throw new Error('Run node tools/away.mjs make first.')
  console.log([
    'In the WireGuard app on the phone: tap +, then Create from scratch.',
    '  Name          Botyard',
    '  Private key   tap the generate button',
    `  Addresses     ${PHONE}/32`,
    'Then Add peer:',
    `  Public key    ${state.pcKey}`,
    `  Endpoint      ${state.endpoint}:${PORT}`,
    // Only the PC goes through the tunnel; the rest of the phone's traffic is untouched. The router
    // loops the home address back, so this also works on home Wi-Fi.
    `  Allowed IPs   ${PC}/32`,
    'Save, then copy the tunnel\'s own Public key and give it to:  node tools/away.mjs phone <key>',
    `Pairing the app from away, use the PC address ${PC}:5288.`,
  ].join('\n'))
}

/** The phone's public key, from its WireGuard app. tools/away-install.sh adds it to the PC's end. */
function phone(key) {
  const state = readJson(STATE)
  if (!state?.pcKey) throw new Error('Run node tools/away.mjs make first.')
  if (!KEY.test(key || '')) throw new Error('That is not a WireGuard public key. It is 44 characters and ends with =.')
  if (key === state.pcKey) throw new Error('That is the PC\'s key. Copy the Public key shown under the phone tunnel\'s Interface.')
  // Written whole and then renamed, because the install step may be waiting to read it.
  fs.writeFileSync(`${PHONE_KEY}.tmp`, `${key}\n`, { mode: 0o600 })
  fs.renameSync(`${PHONE_KEY}.tmp`, PHONE_KEY)
  save({ ...state, phoneKey: key, phoneEndpoint: state.endpoint })
  console.log(fs.existsSync(INSTALLED) ? 'Saved. Run sudo sh tools/away-install.sh again to let the phone in.' : 'Saved. The install step adds it.')
}

async function keep() {
  const state = readJson(STATE)
  if (!state) return console.log('Away access is not set up.')
  const router = await findRouter()
  if (!router) {
    save({ ...state, mapped: false, checkedAt: new Date().toISOString() })
    return console.log('No router answered over UPnP.')
  }
  const local = await localAddress(router.gateway)
  const endpoint = (await internetAddress(router)) || state.endpoint
  // The port opens only while the tunnel is up, so it never leads to nothing.
  const up = fs.existsSync(`/sys/class/net/${INTERFACE}`)
  const mapped = up ? await openPort(router, local) : (await closePort(router, local), false)
  save({ ...state, lan: local, endpoint, mapped, checkedAt: new Date().toISOString() })
  console.log(`${up ? 'Tunnel up' : 'Tunnel down'}; port ${PORT} ${mapped ? `open to ${local}` : 'closed'}; home address ${endpoint}${endpoint !== state.phoneEndpoint ? ' (the phone still has the old one)' : ''}`)
}

async function close() {
  const router = await findRouter()
  if (!router) return console.log('No router answered over UPnP.')
  console.log((await closePort(router, await localAddress(router.gateway))) ? 'Closed.' : 'It was not open to this PC.')
}

const [command, flag] = process.argv.slice(2)
const commands = { make: () => make(flag === '--again'), show, phone: () => phone(flag), keep, close }
try {
  if (!commands[command]) throw new Error('Usage: node tools/away.mjs make | show | phone <key> | keep | close')
  await commands[command]()
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
