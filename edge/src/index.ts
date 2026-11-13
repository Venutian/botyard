/**
 * Botyard's door on the internet, so the app works away from home with nothing to switch on.
 *
 * The PC opens a Cloudflare Tunnel that has no public address. Only this Worker reaches through it,
 * over Workers VPC, and it lets a request through only with the gate secret the PC handed the app.
 * Anything else gets a plain 404 here at Cloudflare and never touches the PC.
 *
 *   studio.<domain>  the phone door's API, for requests carrying the gate secret
 *   play.<domain>    playable builds, for links the door signed and the browser that opened one
 *
 * The door still checks the device key on every request. This gate is the second lock.
 */
interface Env {
  DOOR: Fetcher;
  PLAY: Fetcher;
  GATE: string;
}

const DOOR_ORIGIN = 'http://127.0.0.1:5288';
const PLAY_ORIGIN = 'http://127.0.0.1:5290';
const GATE_HEADER = 'x-botyard-gate';
const BUILD_COOKIE = 'studio-preview';
const SIGN_COOKIE = 'botyard-play';
const BUILD_KEY = /^[0-9a-f]{32}$/;
const MIN_GATE = 32;
const DAY_S = 24 * 60 * 60;

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** Compares without leaking how much matched. */
function same(given: string, expected: string) {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The signature the door puts on a build link, so a link opens that build and no other. */
async function sign(secret: string, key: string) {
  const hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(`play:${key}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookie(header: string | null, name: string) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header || '')?.[1] || '';
}

async function studio(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/') || !same(request.headers.get(GATE_HEADER) || '', env.GATE)) return notFound();
  const headers = new Headers(request.headers);
  headers.delete(GATE_HEADER);
  // The door sees every request coming from the tunnel; these say it came this way and from where.
  headers.set('x-botyard-edge', '1');
  headers.set('x-botyard-client', request.headers.get('cf-connecting-ip') || '');
  return env.DOOR.fetch(`${DOOR_ORIGIN}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
}

async function play(request: Request, env: Env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  const url = new URL(request.url);
  const open = /^\/open\/([0-9a-f]{32})$/.exec(url.pathname);
  if (open) {
    const signature = await sign(env.GATE, open[1]);
    if (!same(url.searchParams.get('g') || '', signature)) return notFound();
    const res = await env.PLAY.fetch(`${PLAY_ORIGIN}/open/${open[1]}`, { redirect: 'manual' });
    const answer = new Response(res.body, res);
    // The build's own cookie picks the build; this one proves the browser opened a signed link for it.
    answer.headers.append('Set-Cookie', `${SIGN_COOKIE}=${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAY_S}`);
    return answer;
  }
  const header = request.headers.get('cookie');
  const key = cookie(header, BUILD_COOKIE);
  if (!BUILD_KEY.test(key) || !same(cookie(header, SIGN_COOKIE), await sign(env.GATE, key))) return notFound();
  return env.PLAY.fetch(`${PLAY_ORIGIN}${url.pathname}${url.search}`, {
    method: request.method,
    headers: { cookie: `${BUILD_COOKIE}=${key}` },
    redirect: 'manual',
  });
}

export default {
  async fetch(request: Request, env: Env) {
    if (!env.GATE || env.GATE.length < MIN_GATE) return notFound();
    const host = new URL(request.url).hostname;
    if (host.startsWith('studio.')) return studio(request, env);
    if (host.startsWith('play.')) return play(request, env);
    return notFound();
  },
} satisfies ExportedHandler<Env>;
