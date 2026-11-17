/**
 * Who may call the page's own API, and reading what they send.
 *
 * The API can start work and change settings, so it answers one caller: the page this service
 * served. A request shows that in two headers a browser sets and a page cannot forge:
 *
 *   Host     must name this computer. A site elsewhere can point its own name at this computer's
 *            address; its requests still carry its own name here.
 *   Origin   must name this computer too, whenever a request changes something. A page on another
 *            site can send a request here blind; the browser says where it came from, and a
 *            changing request that does not say is not from a page at all.
 *
 * "This computer" is `localhost`, the loopback addresses, and the addresses of its own network
 * cards, so the map can be opened from another device on the same network when the service is
 * started to listen there.
 */
import os from 'node:os'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Every name this computer answers to, asked afresh: a network card can come and go. */
function ownNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1'])
  for (const cards of Object.values(os.networkInterfaces())) for (const card of cards || []) if (!card.internal) names.add(card.address.toLowerCase())
  return names
}

/** The host out of a `Host` or `Origin` header: no scheme, no port, no brackets. '' when it is not one. */
export function hostOf(header) {
  const text = String(header || '').trim().toLowerCase()
  if (!text) return ''
  try { return new URL(text.includes('://') ? text : `http://${text}`).hostname.replace(/^\[(.*)\]$/, '$1') } catch { return '' }
}

/** Does the request name this computer in `Host`? (A bot's call has no page, so no Origin to check.) */
export function ownHost(req, names = ownNames()) {
  return names.has(hostOf(req.headers.host)) && !['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-botyard-edge'].some((h) => req.headers[h] !== undefined)
}

/** Is this request from the page this service served? */
export function fromOwnPage(req, names = ownNames()) {
  if (!names.has(hostOf(req.headers.host))) return false
  const origin = req.headers.origin
  if (origin === undefined || origin === 'null') return READS.has(req.method)
  return names.has(hostOf(origin))
}

/** Everything a request sends, up to a size; past it the request is cut off and refused with status 413. */
export function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (part) => {
      size += part.length
      if (size <= limit) { parts.push(part); return }
      req.destroy()
      reject(Object.assign(new Error('That is more than may be sent here'), { status: 413 }))
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/** What a request sends, as JSON; nothing sent is an empty object. Not JSON is refused with status 400. */
export async function readJson(req, limit = 4 * 1024 * 1024) {
  const text = (await readBytes(req, limit)).toString('utf8').trim()
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw Object.assign(new Error('That was not JSON'), { status: 400 }) }
}

/** Answer with JSON that no browser or proxy keeps. */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
  res.end(text)
}
