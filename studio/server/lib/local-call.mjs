/**
 * Did a request start on this computer? One answer for every port Botyard listens on: the page's and
 * the engine's. Loopback, not handed on by a tunnel or a proxy, and asked for by this computer's own
 * name: a page on another site that points its name at 127.0.0.1 (DNS rebinding) still says its own
 * name in `Host`, and a page elsewhere that posts here says so in `Origin`.
 */
export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** A request that was passed on by something else did not start on this computer, whatever its socket says. */
export const PASSED_ON = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-botyard-edge']
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export const nameOf = (value) => { try { return new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname } catch { return '' } }

/** Why this request is not from this computer, or '' when it is. */
export function notFromHere(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return 'not from this computer'
  if (PASSED_ON.some((name) => req.headers[name] !== undefined)) return 'passed on by a proxy or a tunnel'
  if (!LOCAL_NAMES.has(nameOf(req.headers.host || ''))) return `asked for another name (${String(req.headers.host || 'none').slice(0, 60)})`
  const origin = req.headers.origin
  if (origin && origin !== 'null' && !LOCAL_NAMES.has(nameOf(origin))) return `sent from a page elsewhere (${String(origin).slice(0, 60)})`
  return ''
}

export const fromThisComputer = (req) => !notFromHere(req)
