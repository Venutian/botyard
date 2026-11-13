/**
 * Connectors: the outside services the crew may use, signed in to from Botyard.
 *
 * A connector is a service's own MCP server (its address), how Botyard signs in to it (the service's
 * sign-in page, a key the owner pastes, or nothing), the tools it offers, and which bots may use
 * which. Botyard keeps the keys; a bot never sees one. Each bot reaches a connector through Botyard's
 * own gateway (`/api/mcp/<connector>/<the bot's pass>`), which adds the key and lets through only
 * the tools the owner allowed that bot.
 *
 * The one rule about what a bot may do is the owner's: a tool that only reads is allowed to any bot
 * given the connector; a tool that changes something is off until the owner ticks it, and then only
 * for bots given "may change things".
 *
 * And whose account it is. A connector is the owner's own account (the default) or a business's
 * account the bots may act in. On the owner's own account a tool that changes something (sends,
 * posts, deletes, pays, publishes) is never called straight away: the call is held, a card in Needs
 * you shows exactly what would be sent, and only the owner's yes sends it. The bot is told on its job
 * what came of it. Reading is never held. A tool is taken as changing something unless the service
 * itself marks it read-only.
 *
 * This replaces the engine's Apps page, gallery, grants, profiles and per-bot gateways.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { keysDir } from './home.mjs'
import { crewFolder } from './models.mjs'
import { fileURLToPath } from 'node:url'
import { BUILTINS, StoreError, alwaysAsks, builtinTools, runBuiltin } from './store-apis.mjs'

export class ConnectorError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(here, 'connector-catalogue.json'), 'utf8'))
/** Kept outside every repository and outside the crew's folder; `owner-guard.py` refuses a bot's touch of it. */
export const keysFolder = () => process.env.BOTYARD_KEYS || keysDir()
/** Where each bot's list of connectors is written for its launcher to pick up. */
export const botConfigFolder = () => path.join(crewFolder(), 'connectors')

const TIME_LIMIT_MS = 20_000
const SIGN_IN_WINDOW_MS = 15 * 60_000
const REFRESH_EARLY_MS = 2 * 60_000
const PROTOCOL = '2025-06-18'
const CLIENT = { name: 'Botyard', version: '1' }
const LEVELS = new Set(['read', 'write'])
/** Whose account a connector is: the owner's own, or a business's the bots may act in. */
const OWNERS = new Set(['own', 'business'])
const ownerOf = (c) => (c.owner === 'business' ? 'business' : 'own')

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const b64url = (buf) => Buffer.from(buf).toString('base64url')

// ── the store ───────────────────────────────────────────────────────────────────────

const empty = () => ({ connectors: {}, passes: {}, held: {} })

export function readStore(folder = keysFolder()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(folder, 'connectors.json'), 'utf8'))
    return { connectors: raw.connectors || {}, passes: raw.passes || {}, held: raw.held || {} }
  } catch {
    return empty()
  }
}

/** Whole-file, through a temp file, readable by the owner alone. */
export function writeStore(store, folder = keysFolder()) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = path.join(folder, 'connectors.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

let chain = Promise.resolve()
/** One change to the store at a time: a token refresh and the owner's click must not overwrite each other. */
function change(folder, fn) {
  const run = chain.then(async () => {
    const store = readStore(folder)
    const result = await fn(store)
    writeStore(store, folder)
    return result
  })
  chain = run.catch(() => {})
  return run
}

// ── what the page sees ──────────────────────────────────────────────────────────────

const stateOf = (c, now) => {
  if (c.auth === 'signin' && !c.oauth?.accessToken) return c.pending && now - c.pending.at < SIGN_IN_WINDOW_MS ? 'signing-in' : 'signed-out'
  if (c.auth === 'key' && !c.key?.value) return 'signed-out'
  if (c.auth === 'builtin' && !c.secret) return 'signed-out'
  if (c.health && c.health.ok === false) return c.health.signIn ? 'signed-out' : 'trouble'
  return 'ready'
}
const STATE_WORDS = { ready: 'Ready', 'signed-out': 'Needs sign-in', 'signing-in': 'Waiting for you to sign in', trouble: 'Not answering' }

/** A connector without anything secret in it. */
export function connectorView(c, { crew = [], now = Date.now() } = {}) {
  const state = stateOf(c, now)
  const tools = (c.tools || []).map((t) => ({ name: t.name, about: t.about || '', reads: Boolean(t.readOnly), allowed: Boolean(t.readOnly) || (c.writes || []).includes(t.name) }))
  return {
    id: c.id,
    name: c.name,
    about: c.about || '',
    address: c.auth === 'builtin' ? 'Built into Botyard, on the store\'s own API' : c.url,
    how: c.auth,
    state,
    stateWords: STATE_WORDS[state],
    trouble: state === 'trouble' ? c.health?.error || '' : '',
    signedInAt: c.signedInAt || 0,
    checkedAt: c.health?.at || 0,
    account: c.account || '',
    owner: ownerOf(c),
    tools,
    reads: tools.filter((t) => t.reads).length,
    changes: tools.filter((t) => !t.reads).length,
    bots: crew.map((b) => ({ id: b.id, name: b.name, level: c.bots?.[b.id] || 'off' })),
  }
}

export function connectorList({ crew = [], folder = keysFolder(), now = Date.now(), engines = engineSignIns } = {}) {
  const store = readStore(folder)
  const mine = Object.values(store.connectors).sort((a, b) => a.name.localeCompare(b.name))
  const have = new Set(mine.map((c) => c.from).filter(Boolean))
  return {
    connectors: mine.map((c) => connectorView(c, { crew, now })),
    catalogue: CATALOGUE.filter((a) => !have.has(a.id)).map((a) => ({ id: a.id, name: a.name, about: a.about, kind: a.kind, official: a.official !== false, signs: a.signs || '', ways: a.ways.map((w) => ({ kind: w.kind, ownApp: Boolean(w.ownApp), appPage: w.appPage || '', fields: w.kind === 'builtin' ? BUILTINS[w.builtin].fields : [], keyLabel: w.keyLabel || '', keysPage: w.keysPage || '' })) })),
    engines: engines(),
  }
}

// ── the engines' own sign-ins ───────────────────────────────────────────────────────

const fileAge = (file) => { try { const s = fs.statSync(file); return s.size > 0 ? s.mtimeMs : 0 } catch { return 0 } }

/**
 * Whether each engine the bots run on is signed in, read from where each keeps its sign-in. Only
 * whether the file is there and when it was written: nothing in it is read out.
 */
export function engineSignIns({ home = os.homedir(), crew = crewFolder(), now = Date.now() } = {}) {
  const claudeToken = fileAge(path.join(crew, 'claude-token'))
  let desktop = 0
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'))
    desktop = Number(creds?.claudeAiOauth?.expiresAt) || 1
  } catch { /* not signed in through the app */ }
  const codex = fileAge(path.join(crew, 'codex-safe', 'auth.json')) || fileAge(path.join(home, '.codex', 'auth.json'))
  let free = []
  try { free = Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8')) || {}) } catch { /* none */ }
  return [
    {
      id: 'claude', name: 'Claude', for: 'The bots you put on Claude',
      ok: Boolean(claudeToken || desktop),
      words: claudeToken ? `Signed in with the crew's own token, made ${new Date(claudeToken).toISOString().slice(0, 10)} and good for a year` : desktop ? 'Signed in through the Claude app only: the bots stop when that sign-in ends' : 'Not signed in',
      fix: claudeToken ? '' : 'In a terminal run `claude setup-token`, then save the token it prints as $BOTYARD_HOME/crew/claude-token',
    },
    {
      id: 'codex', name: 'Codex', for: 'The bots you put on Codex',
      ok: Boolean(codex),
      words: codex ? `Signed in, last renewed ${new Date(codex).toISOString().slice(0, 10)}` : 'Not signed in',
      fix: codex ? '' : 'In a terminal run `codex login`',
    },
    {
      id: 'free', name: 'Free models (OpenCode)', for: 'The bots on free models',
      ok: true,
      words: free.length ? `Signed in to ${free.join(', ')}` : 'No provider is signed in; the models that need none still work',
      fix: '',
    },
  ]
}

// ── talking to a service ────────────────────────────────────────────────────────────

async function ask(fetcher, url, init = {}) {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  } catch (err) {
    throw new ConnectorError(502, err?.name === 'TimeoutError' ? 'The service took too long to answer' : 'The service could not be reached')
  }
}

async function json(fetcher, url, init) {
  const res = await ask(fetcher, url, init)
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

/** One answer of a service, whether it came as plain JSON or as an event stream. */
export function readAnswer(text, type = '') {
  if (!type.includes('text/event-stream')) { try { return JSON.parse(text) } catch { return null } }
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    if (data) { try { messages.push(JSON.parse(data)) } catch { /* a keep-alive line */ } }
  }
  return messages.find((m) => m && ('result' in m || 'error' in m)) || messages.at(-1) || null
}

const authHeaders = (c) => {
  if (c.auth === 'signin' && c.oauth?.accessToken) return { Authorization: `Bearer ${c.oauth.accessToken}` }
  if (c.auth === 'key' && c.key?.value) return { [c.key.header || 'Authorization']: `${c.key.prefix || ''}${c.key.value}` }
  return {}
}

/**
 * Where a service's sign-in lives, found the way the MCP rules say: the server names its sign-in
 * server (in its 401 or at a well-known address), and that one lists its own addresses.
 */
export async function findSignIn(url, { fetcher = fetch, always = false } = {}) {
  const target = new URL(url)
  let metaUrl = ''
  const probe = await ask(fetcher, url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } }) })
  if (probe.ok && !always) return null // it answers without a sign-in
  metaUrl = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') || '')?.[1] || ''
  const candidates = [metaUrl, `${target.origin}/.well-known/oauth-protected-resource${target.pathname === '/' ? '' : target.pathname}`, `${target.origin}/.well-known/oauth-protected-resource`].filter(Boolean)
  let resource = null
  for (const candidate of candidates) { resource = await json(fetcher, candidate); if (resource) break }
  const issuer = resource?.authorization_servers?.[0] || target.origin
  const at = new URL(issuer)
  const tail = at.pathname === '/' ? '' : at.pathname
  let server = null
  for (const candidate of [`${at.origin}/.well-known/oauth-authorization-server${tail}`, `${at.origin}/.well-known/openid-configuration${tail}`, `${at.origin}${tail}/.well-known/openid-configuration`]) {
    server = await json(fetcher, candidate)
    if (server?.authorization_endpoint) break
  }
  if (!server?.authorization_endpoint || !server.token_endpoint) throw new ConnectorError(422, 'This service does not say how to sign in. If it gives keys, add it with a key instead')
  return {
    issuer: server.issuer || issuer,
    authorizationUrl: server.authorization_endpoint,
    tokenUrl: server.token_endpoint,
    registrationUrl: server.registration_endpoint || '',
    resource: resource?.resource || url,
    scope: (resource?.scopes_supported || server.scopes_supported || []).join(' '),
  }
}

async function tokenCall(fetcher, c, fields) {
  const body = new URLSearchParams({ client_id: c.oauth.clientId, ...fields })
  if (c.oauth.clientSecret) body.set('client_secret', c.oauth.clientSecret)
  if (c.oauth.resource) body.set('resource', c.oauth.resource)
  const res = await ask(fetcher, c.oauth.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body })
  const out = await res.json().catch(() => null)
  if (!res.ok || !out?.access_token) throw new ConnectorError(401, out?.error_description || out?.error || 'The service refused the sign-in')
  c.oauth.accessToken = out.access_token
  if (out.refresh_token) c.oauth.refreshToken = out.refresh_token
  c.oauth.expiresAt = out.expires_in ? Date.now() + Number(out.expires_in) * 1000 : 0
}

/** The connector with a key that is still good, renewed first when it is about to run out. */
async function fresh(id, { folder, fetcher, now = Date.now() }) {
  const c = readStore(folder).connectors[id]
  if (!c) throw new ConnectorError(404, 'That connector is not set up here')
  const o = c.oauth
  if (c.auth !== 'signin' || !o?.accessToken || !o.expiresAt || o.expiresAt - now > REFRESH_EARLY_MS) return c
  if (!o.refreshToken) return c
  return change(folder, async (store) => {
    const live = store.connectors[id]
    if (!live) throw new ConnectorError(404, 'That connector is not set up here')
    // Another call may have renewed it while this one waited its turn.
    if (live.oauth.expiresAt - Date.now() > REFRESH_EARLY_MS) return live
    try {
      await tokenCall(fetcher, live, { grant_type: 'refresh_token', refresh_token: live.oauth.refreshToken })
    } catch (err) {
      live.health = { ok: false, at: Date.now(), error: 'Its sign-in ran out', signIn: true }
      live.oauth.accessToken = ''
    }
    return live
  })
}

/** One question to the service's MCP server, with the connector's key. */
async function rpc(c, method, params, { fetcher, session = '' } = {}) {
  const id = method.startsWith('notifications/') ? undefined : randomUUID()
  const res = await ask(fetcher, c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, ...(session ? { 'Mcp-Session-Id': session } : {}), ...authHeaders(c) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) }),
  })
  if (res.status === 401 || res.status === 403) throw new ConnectorError(401, 'The service says the sign-in is not valid any more')
  const text = await res.text()
  if (!res.ok) throw new ConnectorError(502, `The service answered ${res.status}`)
  const answer = id ? readAnswer(text, res.headers.get('content-type') || '') : null
  if (answer?.error) throw new ConnectorError(502, answer.error.message || 'The service refused the question')
  return { result: answer?.result, session: res.headers.get('mcp-session-id') || session }
}

/** Reads what the service offers and marks which tools only read. Stored with the connector. */
export async function loadTools(id, { folder = keysFolder(), fetcher = fetch } = {}) {
  const c = await fresh(id, { folder, fetcher })
  let tools = []
  let health
  let account = c.account || ''
  if (c.auth === 'builtin') {
    // Its tools are Botyard's own; the key is proved by one read from the store.
    tools = builtinTools(c.builtin)
    const first = BUILTINS[c.builtin].tools.find((t) => t.readOnly)
    const tried = await runBuiltin(c.builtin, c.secret, first.name, {}, { fetcher })
    health = tried.isError ? { ok: false, at: Date.now(), error: tried.content[0].text, signIn: /answered 401|answered 403|not accept/.test(tried.content[0].text) } : { ok: true, at: Date.now() }
    account = BUILTINS[c.builtin].name
  } else try {
    const hello = await rpc(c, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, { fetcher })
    account = hello.result?.serverInfo?.title || hello.result?.serverInfo?.name || account
    await rpc(c, 'notifications/initialized', undefined, { fetcher, session: hello.session }).catch(() => {})
    let cursor
    for (let page = 0; page < 20; page++) {
      const { result } = await rpc(c, 'tools/list', cursor ? { cursor } : {}, { fetcher, session: hello.session })
      tools.push(...(result?.tools || []))
      cursor = result?.nextCursor
      if (!cursor) break
    }
    health = { ok: true, at: Date.now() }
  } catch (err) {
    health = { ok: false, at: Date.now(), error: err.message, signIn: err.status === 401 }
  }
  return change(folder, (store) => {
    const live = store.connectors[id]
    if (!live) throw new ConnectorError(404, 'That connector is not set up here')
    live.health = health
    live.account = account
    if (health.ok) {
      live.tools = tools.map((t) => ({ name: t.name, about: String(t.description || t.title || '').replace(/\s+/g, ' ').slice(0, 240), readOnly: t.annotations?.readOnlyHint === true }))
      // A tool the service no longer has cannot stay ticked.
      live.writes = (live.writes || []).filter((name) => live.tools.some((t) => t.name === name))
    }
    return live
  })
}

// ── setting one up ──────────────────────────────────────────────────────────────────

/**
 * Adds a connector from the catalogue (`from`) or by its address. With a key it is ready at once;
 * with a sign-in it waits for `startSignIn`.
 */
export async function addConnector(input, { folder = keysFolder(), fetcher = fetch, crew = [] } = {}) {
  const known = CATALOGUE.find((a) => a.id === input.from)
  const built = known?.ways.find((w) => w.kind === 'builtin')
  if (built) return addBuiltin(known, built, input, { folder, fetcher, crew })
  const wanted = input.key ? 'key' : input.how
  const way = known ? known.ways.find((w) => w.kind === wanted) || known.ways.find((w) => w.kind !== 'key') || known.ways[0] : null
  const url = String(way?.url || input.address || '').trim()
  let parsed
  try { parsed = new URL(url) } catch { throw new ConnectorError(400, 'Give the address of the service\'s MCP server, starting with https://') }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new ConnectorError(400, 'The address must start with https://')
  const name = String(input.name || known?.name || parsed.hostname).trim().slice(0, 60)
  const key = String(input.key || '').trim()
  let auth = way?.kind === 'open' ? 'open' : key ? 'key' : way?.kind === 'key' ? 'key' : 'signin'
  let oauth = null
  if (auth === 'key' && !key) throw new ConnectorError(400, `Paste the ${way?.keyLabel || 'key'} first`)
  if (auth === 'signin') {
    // A service that registers no app by itself is signed in to through the owner's own app with it.
    const clientId = String(input.clientId || '').trim()
    if (way?.ownApp && !clientId) throw new ConnectorError(400, `${known?.name || 'This service'} needs an app of your own on its side: paste its client ID (and secret, if it gave one)`)
    const found = await findSignIn(url, { fetcher, always: Boolean(way?.ownApp) })
    if (!found) auth = 'open'
    else {
      oauth = found
      if (way?.scope) oauth.scope = way.scope
      if (way?.extra) oauth.extra = way.extra
      if (way?.resource === false) oauth.resource = ''
      if (clientId) Object.assign(oauth, { clientId, clientSecret: String(input.clientSecret || '').trim(), ownApp: true })
    }
  }
  const id = await change(folder, (store) => {
    let id = slug(name) || 'service'
    for (let n = 2; store.connectors[id]; n++) id = `${slug(name)}-${n}`
    store.connectors[id] = {
      id, name, about: known?.about || '', url, auth, from: known?.id || '',
      ...(auth === 'key' ? { key: { header: way?.header || 'Authorization', prefix: way?.prefix ?? 'Bearer ', value: key } } : {}),
      ...(oauth ? { oauth } : {}),
      owner: OWNERS.has(input.owner) ? input.owner : 'own',
      tools: [], writes: [], bots: {}, addedAt: Date.now(), ...(auth !== 'signin' ? { signedInAt: Date.now() } : {}),
    }
    return id
  })
  if (auth !== 'signin') await loadTools(id, { folder, fetcher })
  return connectorView(readStore(folder).connectors[id], { crew })
}

/** A connector Botyard carries itself: its key's fields are checked, kept with it, and never shown again. */
async function addBuiltin(known, way, input, { folder, fetcher, crew }) {
  const def = BUILTINS[way.builtin]
  const given = Object.fromEntries(def.fields.map((f) => [f.id, String(input.fields?.[f.id] ?? input[f.id] ?? '').trim()]))
  const missing = def.fields.find((f) => !f.optional && !given[f.id])
  if (missing) throw new ConnectorError(400, `Paste the ${missing.label} first`)
  let secret
  try { secret = def.check(given) } catch (err) { throw new ConnectorError(400, err instanceof StoreError ? err.message : 'That key could not be read') }
  const id = await change(folder, (store) => {
    let id = known.id
    for (let n = 2; store.connectors[id]; n++) id = `${known.id}-${n}`
    store.connectors[id] = {
      id, name: known.name, about: known.about, url: `builtin:${way.builtin}`, auth: 'builtin', builtin: way.builtin, from: known.id, secret,
      owner: OWNERS.has(input.owner) ? input.owner : 'own', tools: [], writes: [], bots: {}, addedAt: Date.now(), signedInAt: Date.now(),
    }
    return id
  })
  await loadTools(id, { folder, fetcher })
  return connectorView(readStore(folder).connectors[id], { crew })
}

/** The address of the service's sign-in page for the owner to open; the answer comes back to `finishSignIn`. */
export async function startSignIn(id, { redirectUri, folder = keysFolder(), fetcher = fetch } = {}) {
  const c = readStore(folder).connectors[id]
  if (!c) throw new ConnectorError(404, 'That connector is not set up here')
  if (c.auth !== 'signin') throw new ConnectorError(409, 'This connector does not use a sign-in page')
  const oauth = { ...c.oauth }
  // Botyard introduces itself to the service once per return address.
  if (oauth.ownApp) oauth.redirectUri = redirectUri
  else if (!oauth.clientId || oauth.redirectUri !== redirectUri) {
    if (!oauth.registrationUrl) throw new ConnectorError(422, 'This service wants an app registered with it by hand. Add it with a key instead')
    const res = await ask(fetcher, oauth.registrationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: CLIENT.name, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    })
    const made = await res.json().catch(() => null)
    if (!res.ok || !made?.client_id) throw new ConnectorError(502, made?.error_description || 'The service would not register Botyard')
    Object.assign(oauth, { clientId: made.client_id, clientSecret: made.client_secret || '', redirectUri })
  }
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(24))
  const go = new URL(oauth.authorizationUrl)
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: oauth.clientId, redirect_uri: redirectUri, state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...(oauth.resource ? { resource: oauth.resource } : {}), ...(oauth.scope ? { scope: oauth.scope } : {}), ...(oauth.extra || {}) })) go.searchParams.set(k, v)
  await change(folder, (store) => {
    const live = store.connectors[id]
    if (!live) throw new ConnectorError(404, 'That connector is not set up here')
    live.oauth = { ...live.oauth, ...oauth }
    live.pending = { state, verifier, at: Date.now() }
  })
  return { url: go.toString() }
}

/** The service sent the owner back with a code: trade it for the keys and read the tools. */
export async function finishSignIn({ state, code, error }, { folder = keysFolder(), fetcher = fetch } = {}) {
  const store = readStore(folder)
  const c = Object.values(store.connectors).find((x) => x.pending?.state && x.pending.state === state)
  if (!c) throw new ConnectorError(400, 'This sign-in was not started from Botyard, or it was started too long ago. Start it again from the Connectors page')
  if (Date.now() - c.pending.at > SIGN_IN_WINDOW_MS) throw new ConnectorError(400, 'That took longer than a quarter of an hour. Start the sign-in again from the Connectors page')
  if (error || !code) {
    await change(folder, (s) => { if (s.connectors[c.id]) delete s.connectors[c.id].pending })
    throw new ConnectorError(400, error === 'access_denied' ? 'You said no on the service\'s page, so nothing was connected' : `The service did not sign you in (${error || 'no code'})`)
  }
  await change(folder, async (s) => {
    const live = s.connectors[c.id]
    await tokenCall(fetcher, live, { grant_type: 'authorization_code', code, redirect_uri: live.oauth.redirectUri, code_verifier: live.pending.verifier })
    delete live.pending
    live.signedInAt = Date.now()
    live.health = { ok: true, at: Date.now() }
  })
  await loadTools(c.id, { folder, fetcher })
  return { id: c.id, name: c.name }
}

/** Which bots may use it, and which of its changing tools are allowed at all. */
export async function setAccess(id, { bots, writes, owner } = {}, { folder = keysFolder(), crew = [], out = botConfigFolder() } = {}) {
  await change(folder, (store) => {
    const c = store.connectors[id]
    if (!c) throw new ConnectorError(404, 'That connector is not set up here')
    if (owner !== undefined) {
      if (!OWNERS.has(owner)) throw new ConnectorError(400, 'Say whether it is your own account or a business account')
      c.owner = owner
    }
    if (bots && typeof bots === 'object') {
      for (const [bot, level] of Object.entries(bots)) {
        if (LEVELS.has(level)) c.bots[bot] = level
        else delete c.bots[bot]
      }
    }
    if (Array.isArray(writes)) c.writes = writes.map(String).filter((name) => c.tools.some((t) => t.name === name && !t.readOnly))
    for (const bot of Object.keys(c.bots)) store.passes[bot] ||= b64url(randomBytes(24))
  })
  writeBotConfigs({ folder, crew, out })
  return connectorView(readStore(folder).connectors[id], { crew })
}

export async function removeConnector(id, { folder = keysFolder(), crew = [], out = botConfigFolder() } = {}) {
  await change(folder, (store) => {
    if (!store.connectors[id]) throw new ConnectorError(404, 'That connector is not set up here')
    delete store.connectors[id]
  })
  writeBotConfigs({ folder, crew, out })
  return { ok: true }
}

// ── what a bot gets ─────────────────────────────────────────────────────────────────

/** A bot's file name in the crew folder, the same one its skills file uses: `lead-bot`. */
export const botSlug = (name) => slug(name)

/**
 * Writes, for every bot, the list of connectors it was given: `<bot>.claude.json` in the shape
 * Claude Code reads with `--mcp-config`, and `<bot>.opencode.json` in OpenCode's. A bot with none
 * gets an empty list, so a connector taken away is gone at its next run.
 */
export function writeBotConfigs({ folder = keysFolder(), out = botConfigFolder(), crew = [], base = process.env.BOTYARD_GATEWAY || 'http://127.0.0.1:5274' } = {}) {
  const store = readStore(folder)
  fs.mkdirSync(out, { recursive: true })
  for (const bot of crew) {
    const mine = Object.values(store.connectors).filter((c) => LEVELS.has(c.bots?.[bot.id]) && store.passes[bot.id])
    const address = (c) => `${base}/api/mcp/${c.id}/${store.passes[bot.id]}`
    const files = {
      [`${botSlug(bot.name)}.claude.json`]: { mcpServers: Object.fromEntries(mine.map((c) => [c.id, { type: 'http', url: address(c) }])) },
      [`${botSlug(bot.name)}.opencode.json`]: { mcp: Object.fromEntries(mine.map((c) => [c.id, { type: 'remote', url: address(c), enabled: true }])) },
    }
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(out, name)
      const text = JSON.stringify(body, null, 1)
      let had = ''
      try { had = fs.readFileSync(file, 'utf8') } catch { /* first time */ }
      if (had !== text) fs.writeFileSync(file, text, { mode: 0o600 })
    }
  }
}

// ── the owner's own accounts: a change waits for a yes ─────────────────────────────

const MAX_SHOWN = 3200
const GATE_MARK = '\n\n<!-- botyard-script: Connector gate -->'

/** What a call would send, as the owner reads it on the card: every field, nothing left out but length. */
export function whatWouldBeSent(args = {}) {
  const lines = []
  for (const [key, value] of Object.entries(args || {})) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
    lines.push(`${key}: ${text}`)
  }
  const all = lines.join('\n') || '(nothing: the call has no fields)'
  return all.length > MAX_SHOWN ? `${all.slice(0, MAX_SHOWN)}\n… and ${all.length - MAX_SHOWN} more characters` : all
}

/**
 * How a held call reaches the owner and how the bot hears back, through the engine: the card is a
 * yes-or-no on the job the bot is running, and the outcome is a comment on it, which wakes the bot.
 */
export function engineCards() {
  const engine = import('./engine.mjs')
  return {
    async place({ bot, title, prompt }) {
      const { call, companyId } = await engine
      const runs = await call(`/companies/${await companyId()}/live-runs`)
      const job = (runs || []).find((r) => r.agentId === bot && r.issueId)?.issueId
      if (!job) return null
      const card = await call(`/issues/${job}/interactions`, { method: 'POST', body: { kind: 'request_confirmation', title, continuationPolicy: 'none', payload: { prompt, acceptLabel: 'Yes, send it', rejectLabel: 'No' } } })
      return { job, card: card.id }
    },
    async tell(job, text) {
      const { call } = await engine
      await call(`/issues/${job}/comments`, { method: 'POST', body: { body: `${text}${GATE_MARK}` } })
    },
  }
}

/** Hold a call on the owner's own account: a card for the owner, a plain answer for the bot. */
async function hold(c, bot, message, { folder, cards }) {
  const tool = message.params?.name
  const args = message.params?.arguments || {}
  const title = `${c.name}: ${tool}, on your own account`
  const prompt = `A bot wants to use your own ${c.name} account. It is not done until you say yes.\n\nWhat it would do: ${tool}\n\nExactly what would be sent:\n${whatWouldBeSent(args)}`
  let placed = null
  try { placed = await cards.place({ bot, title, prompt }) } catch { placed = null }
  if (!placed) return refuse(message.id, `${c.name} is the owner's own account, and "${tool}" changes something, so it needs the owner's yes on a card. Botyard could not find the job you are on to put the card on. Ask the owner in a comment instead, saying exactly what you would send.`)
  await change(folder, (store) => {
    store.held ||= {}
    store.held[placed.card] = { card: placed.card, job: placed.job, connector: c.id, tool, args, bot, at: Date.now() }
  })
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [{ type: 'text', text: `Not done yet. ${c.name} is the owner's own account, so "${tool}" waits for the owner's yes on a card in Needs you, showing exactly what would be sent. Do not call it again. When the owner answers, the outcome is written on your job and you are woken.` }],
    },
  }
}

/**
 * The owner answered a card. If it held a call, the call is made on a yes and not on a no, and the
 * bot is told on its job either way. Any other card is left alone.
 * @returns {Promise<null | { sent: boolean, error?: string }>}
 */
export async function settleHeld(cardId, verb, { reason = '', folder = keysFolder(), fetcher = fetch, cards = engineCards() } = {}) {
  const held = readStore(folder).held?.[cardId]
  if (!held || (verb !== 'accept' && verb !== 'reject')) return null
  await change(folder, (store) => { delete store.held[cardId] })
  const name = readStore(folder).connectors[held.connector]?.name || held.connector
  if (verb === 'reject') {
    await cards.tell(held.job, `The owner said no to ${name} "${held.tool}". It was not sent.${reason ? ` Their reason: ${reason}` : ''}`)
    return { sent: false }
  }
  try {
    const c = await fresh(held.connector, { folder, fetcher })
    let result
    if (c.auth === 'builtin') result = await runBuiltin(c.builtin, c.secret, held.tool, held.args, { fetcher })
    else {
      const hello = await rpc(c, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, { fetcher })
      await rpc(c, 'notifications/initialized', undefined, { fetcher, session: hello.session }).catch(() => {})
      result = (await rpc(c, 'tools/call', { name: held.tool, arguments: held.args }, { fetcher, session: hello.session })).result
    }
    const said = (result?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 6000)
    await cards.tell(held.job, `The owner said yes, and ${name} "${held.tool}" was ${result?.isError ? 'sent, but the service answered with an error' : 'done'}.${said ? `\n\nWhat ${name} answered:\n${said}` : ''}`)
    return { sent: !result?.isError }
  } catch (err) {
    await cards.tell(held.job, `The owner said yes to ${name} "${held.tool}", but it could not be sent: ${err.message}`).catch(() => {})
    return { sent: false, error: err.message }
  }
}

/** A built-in connector answers the bot's MCP questions here, as a remote server would. */
async function builtinAnswer(c, message, allowed, { fetcher }) {
  const json = (body, status = 200) => ({ status, headers: { 'Content-Type': 'application/json' }, body: body === '' ? '' : JSON.stringify(body) })
  if (!message) return json('', 202)
  const answer = async (one) => {
    if (one?.id === undefined) return null
    if (one.method === 'initialize') return { jsonrpc: '2.0', id: one.id, result: { protocolVersion: one.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: c.name, version: '1' } } }
    if (one.method === 'ping') return { jsonrpc: '2.0', id: one.id, result: {} }
    if (one.method === 'tools/list') return { jsonrpc: '2.0', id: one.id, result: { tools: builtinTools(c.builtin).filter((t) => allowed.has(t.name)) } }
    if (one.method === 'tools/call') return { jsonrpc: '2.0', id: one.id, result: await runBuiltin(c.builtin, c.secret, one.params?.name, one.params?.arguments, { fetcher }) }
    return { jsonrpc: '2.0', id: one.id, error: { code: -32601, message: `${one.method} is not offered` } }
  }
  if (Array.isArray(message)) return json((await Promise.all(message.map(answer))).filter(Boolean))
  const out = await answer(message)
  return out ? json(out) : json('', 202)
}

const allowedFor = (c, level) => new Set((c.tools || []).filter((t) => t.readOnly || (level === 'write' && (c.writes || []).includes(t.name))).map((t) => t.name))
const refuse = (id, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } })

/**
 * A bot's call to a connector, passed on with Botyard's key and the owner's limits: the list of
 * tools shows only the allowed ones, and a call to any other is refused here and never sent.
 * Returns what to answer the bot: `{ status, headers, body }`.
 */
export async function gateway(id, pass, { method = 'POST', body = '', headers = {} } = {}, { folder = keysFolder(), fetcher = fetch, cards = engineCards() } = {}) {
  const store = readStore(folder)
  const bot = Object.keys(store.passes).find((b) => store.passes[b] === pass)
  const known = store.connectors[id]
  const level = bot && known?.bots?.[bot]
  if (!known || !LEVELS.has(level)) return { status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refuse(null, 'This bot was not given this connector. The owner gives connectors in Botyard, under Connectors')) }
  // The stream a server may open towards its client is not needed for calling tools.
  if (method === 'GET') return { status: 405, headers: { Allow: 'POST, DELETE' }, body: '' }
  const c = await fresh(id, { folder, fetcher })
  const allowed = allowedFor(c, level)
  let message = null
  if (method === 'POST') {
    try { message = JSON.parse(body) } catch { return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refuse(null, 'That was not JSON')) } }
    for (const one of Array.isArray(message) ? message : [message]) {
      if (one?.method === 'tools/call' && !allowed.has(one.params?.name)) {
        const tool = (c.tools || []).find((t) => t.name === one.params?.name)
        return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refuse(one.id, tool ? `The owner has not allowed "${tool.name}" for you: it changes things. Ask on a card saying what you would do with it` : `"${one.params?.name}" is not a tool of ${c.name}`)) }
      }
    }
  }
  // On the owner's own account, a change is held for the owner's yes and never sent from here.
  // A store's submissions, releases, listings and replies always wait for the owner's yes, whoever's account it is.
  const asks = (one) => one?.method === 'tools/call' && c.auth === 'builtin' && alwaysAsks(c.builtin, one.params?.name)
  if (message && (ownerOf(c) === 'own' || (Array.isArray(message) ? message.some(asks) : asks(message)))) {
    const changing = (one) => one?.method === 'tools/call' && !(c.tools || []).find((t) => t.name === one.params?.name)?.readOnly
    if (Array.isArray(message) && message.some(changing)) return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refuse(null, 'Call a tool that changes something on its own, not in a batch: it waits for the owner\'s yes')) }
    if (!Array.isArray(message) && changing(message)) return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await hold(c, bot, message, { folder, cards })) }
  }
  if (c.auth === 'builtin') return builtinAnswer(c, message, allowed, { fetcher })
  const pass2 = {}
  for (const name of ['mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (headers[name]) pass2[name] = headers[name]
  const res = await ask(fetcher, c.url, {
    method,
    headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json, text/event-stream', ...pass2, ...authHeaders(c) },
    ...(method === 'POST' ? { body } : {}),
  })
  const type = res.headers.get('content-type') || 'application/json'
  let text = await res.text()
  if (res.status === 401) {
    await change(folder, (s) => { if (s.connectors[id]) s.connectors[id].health = { ok: false, at: Date.now(), error: 'Its sign-in ran out', signIn: true } })
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refuse(message?.id, `${c.name} needs the owner to sign in again in Botyard. Carry on without it and say so in your report`)) }
  }
  // The list of tools is cut to what this bot may use.
  if (res.ok && message && !Array.isArray(message) && message.method === 'tools/list') {
    const answer = readAnswer(text, type)
    if (answer?.result?.tools) {
      answer.result.tools = answer.result.tools.filter((t) => allowed.has(t.name))
      text = type.includes('text/event-stream') ? `event: message\ndata: ${JSON.stringify(answer)}\n\n` : JSON.stringify(answer)
    }
  }
  const back = { 'Content-Type': type }
  if (res.headers.get('mcp-session-id')) back['Mcp-Session-Id'] = res.headers.get('mcp-session-id')
  return { status: res.status, headers: back, body: text }
}
