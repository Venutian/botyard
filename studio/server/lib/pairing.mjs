/**
 * Pairing a phone with this yard: the door's settings, one key per phone, and the link the phone
 * scans. Used by the map's Pair a phone step and by `npm run pair`.
 *
 * The door's settings live in `config/phone.env`. The first pairing makes them: until then the door
 * stays closed. It is opened on every network address of this computer (`0.0.0.0`) so that a phone
 * on the same Wi-Fi can reach it; each phone still needs its own key to get past it.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addDevice, devicesFile, readDevices } from './devices.mjs'
import { configDir } from './home.mjs'

export const DOOR_PORT = 5288
/** Earlier copies of `npm run pair` wrote these names, which the door never read. */
const OLD_NAMES = { STUDIO_PHONE_HOST: 'BOTYARD_PHONE_HOST', STUDIO_PHONE_PORT: 'BOTYARD_PHONE_PORT' }

export const doorFile = (env = process.env) => path.join(configDir(env), 'phone.env')

export function readDoor(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  const out = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0 || line.trimStart().startsWith('#')) continue
    const name = line.slice(0, at).trim()
    out[OLD_NAMES[name] || name] ??= line.slice(at + 1).trim()
  }
  return out
}

/**
 * The door's settings, made on the first pairing. A file from an earlier copy, written with the old
 * names, is written again with the names the door reads. Returns the settings and whether they were new.
 */
export function ensureDoor({ file = doorFile(), devices = devicesFile() } = {}) {
  const had = fs.existsSync(file)
  const now = readDoor(file)
  const stale = had && Object.keys(OLD_NAMES).some((name) => new RegExp(`^${name}=`, 'm').test(fs.readFileSync(file, 'utf8')))
  if (!had || stale || !now.BOTYARD_PHONE_TOKEN) {
    const settings = {
      // The door will not start without a token of its own. Every phone gets its own key, so the
      // shared one is marked retired at once and is never handed to anything.
      BOTYARD_PHONE_TOKEN: now.BOTYARD_PHONE_TOKEN || randomBytes(32).toString('hex'),
      BOTYARD_PHONE_HOST: now.BOTYARD_PHONE_HOST || '0.0.0.0',
      BOTYARD_PHONE_PORT: now.BOTYARD_PHONE_PORT || String(DOOR_PORT),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, Object.entries({ ...now, ...settings }).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  if (!fs.existsSync(devices)) {
    fs.mkdirSync(path.dirname(devices), { recursive: true, mode: 0o700 })
    fs.writeFileSync(devices, JSON.stringify({ sharedRetired: true, devices: [] }, null, 2), { mode: 0o600 })
  }
  return { settings: readDoor(file), made: !had }
}

/** This computer's addresses on the local network, the likeliest first. */
export function localAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces)
    .filter(([name]) => !/^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|wg)/i.test(name))
    .flatMap(([, entries]) => entries || [])
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal && !entry.address.startsWith('169.254.'))
    .map((entry) => entry.address)
    // A home network (192.168.x.x) before the others.
    .sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')))
}

/** The link the phone's camera reads. It holds the phone's key: shown once, never stored. */
export function pairLink({ host, port, device, edge = null }) {
  const target = host.includes(':') ? host : `${host}:${port}`
  let link = `botyard://connect?host=${encodeURIComponent(target)}&token=${device.key}&device=${device.id}`
  if (edge) link += `&edge=${encodeURIComponent(edge.studio)}&gate=${edge.gate}`
  return link
}

/** Make a key for one more phone, and the link that carries it. */
export function pairPhone({ name = '', host = '', port: given = 0, file = doorFile(), devices = devicesFile(), edge = null, interfaces } = {}) {
  const { settings, made } = ensureDoor({ file, devices })
  const address = host || localAddresses(interfaces)[0]
  if (!address) throw new Error('This computer has no address on a network, so a phone cannot reach it. Connect it to your Wi-Fi first')
  // A port set where the service was started wins over the file, as it does for the door itself.
  const port = Number(given) || Number(settings.BOTYARD_PHONE_PORT) || DOOR_PORT
  const device = addDevice(devices, name || 'New phone')
  return { link: pairLink({ host: address, port, device, edge }), host: address, port, deviceId: device.id, first: made, phones: readDevices(devices).devices.length }
}
