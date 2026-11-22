/**
 * Two connectors Botyard carries itself, on the stores' own APIs: App Store Connect and Google Play
 * Console. Neither store runs an MCP server of its own, so their tools are answered here, inside the
 * gateway, with the key the owner pasted (kept in the keys folder like every connector's key).
 *
 * Reading is open to any bot given the connector: sales and downloads, ratings and reviews, crashes
 * and ANRs, builds and review status, the store listing. Every change (a reply to a review, an edit
 * to a listing, sending a version for review, a release or a rollout, uploading a build) is marked
 * `alwaysAsk`: on any account, own or business, it waits for the owner's yes on a card.
 *
 * What the stores' APIs do not offer is not offered here: Apple builds are uploaded with Apple's
 * own tools, not the API, and screenshots and prices are left to the owner in each console.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'

const LONGEST = 24_000
const TIME_LIMIT_MS = 30_000

export class StoreError extends Error {}

const b64url = (input) => Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')
const text = (value) => {
  const out = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return out.length > LONGEST ? `${out.slice(0, LONGEST)}\n… cut, ${out.length - LONGEST} more characters` : out
}
const need = (args, ...names) => {
  for (const name of names) if (args[name] === undefined || args[name] === '') throw new StoreError(`Say ${name}`)
}

async function fetchJson(fetcher, url, init = {}) {
  let res
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  } catch {
    throw new StoreError('The store could not be reached')
  }
  if (res.status === 204) return {}
  const type = res.headers.get('content-type') || ''
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let said = ''
    try { const j = JSON.parse(body); said = j.errors?.map((e) => e.detail || e.title).join('; ') || j.error?.message || j.error_description || '' } catch { said = '' }
    throw new StoreError(`The store answered ${res.status}${said ? `: ${said}` : ''}`)
  }
  if (type.includes('json')) return res.json()
  const bytes = Buffer.from(await res.arrayBuffer())
  return { file: bytes }
}

// ── App Store Connect ────────────────────────────────────────────────────────────────

const ASC = 'https://api.appstoreconnect.apple.com'

/** A token App Store Connect accepts: ES256, signed with the owner's .p8 key, good for twenty minutes. */
export function appleToken({ keyId, issuerId, privateKey }, now = Date.now()) {
  const iat = Math.floor(now / 1000)
  const head = b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' })
  const body = b64url({ iss: issuerId, iat, exp: iat + 19 * 60, aud: 'appstoreconnect-v1' })
  const signature = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${signature.toString('base64url')}`
}

const apple = (creds, fetcher, path, init = {}) => fetchJson(fetcher, `${ASC}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${appleToken(creds)}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
})
const rel = (type, id) => ({ data: { type, id } })

/** The reports Apple gives as gzipped tab-separated text, as rows. */
function tsv(file, max = 300) {
  const raw = (() => { try { return zlib.gunzipSync(file) } catch { return file } })().toString('utf8')
  const [head, ...rows] = raw.trim().split('\n')
  const keys = head.split('\t')
  return { rows: rows.length, shown: rows.slice(0, max).map((r) => Object.fromEntries(r.split('\t').map((v, i) => [keys[i], v]))) }
}

const APP_ID = { appId: { type: 'string', description: 'The app\'s id in App Store Connect (from asc_apps)' } }

const appleTools = [
  {
    name: 'asc_apps', readOnly: true,
    description: 'The apps in this App Store Connect account: id, name, bundle id, SKU.',
    input: {},
    run: async (creds, f) => (await apple(creds, f, '/v1/apps?limit=200&fields[apps]=name,bundleId,sku,primaryLocale')).data.map((a) => ({ id: a.id, ...a.attributes })),
  },
  {
    name: 'asc_versions', readOnly: true,
    description: 'An app\'s App Store versions and where each stands in review (waiting, in review, ready for sale, rejected).',
    input: APP_ID,
    run: async (creds, f, a) => { need(a, 'appId'); return (await apple(creds, f, `/v1/apps/${encodeURIComponent(a.appId)}/appStoreVersions?limit=20`)).data.map((v) => ({ id: v.id, ...v.attributes })) },
  },
  {
    name: 'asc_builds', readOnly: true,
    description: 'An app\'s latest uploaded builds and their processing state.',
    input: APP_ID,
    run: async (creds, f, a) => { need(a, 'appId'); return (await apple(creds, f, `/v1/builds?filter[app]=${encodeURIComponent(a.appId)}&sort=-uploadedDate&limit=20`)).data.map((b) => ({ id: b.id, ...b.attributes })) },
  },
  {
    name: 'asc_reviews', readOnly: true,
    description: 'An app\'s newest customer ratings and reviews.',
    input: { ...APP_ID, limit: { type: 'number', description: 'How many, up to 200' } },
    run: async (creds, f, a) => { need(a, 'appId'); return (await apple(creds, f, `/v1/apps/${encodeURIComponent(a.appId)}/customerReviews?sort=-createdDate&limit=${Math.min(200, Number(a.limit) || 50)}`)).data.map((r) => ({ id: r.id, ...r.attributes })) },
  },
  {
    name: 'asc_listing', readOnly: true,
    description: 'The store listing text of one App Store version, per language: description, keywords, promotional text, what\'s new.',
    input: { versionId: { type: 'string', description: 'The App Store version\'s id (from asc_versions)' } },
    run: async (creds, f, a) => { need(a, 'versionId'); return (await apple(creds, f, `/v1/appStoreVersions/${encodeURIComponent(a.versionId)}/appStoreVersionLocalizations`)).data.map((l) => ({ id: l.id, ...l.attributes })) },
  },
  {
    name: 'asc_crashes', readOnly: true,
    description: 'The crash and hang signatures Apple collected for one build, most frequent first.',
    input: { buildId: { type: 'string', description: 'The build\'s id (from asc_builds)' } },
    run: async (creds, f, a) => { need(a, 'buildId'); return (await apple(creds, f, `/v1/builds/${encodeURIComponent(a.buildId)}/diagnosticSignatures?limit=50`)).data.map((d) => ({ id: d.id, ...d.attributes })) },
  },
  {
    name: 'asc_sales', readOnly: true,
    description: 'Daily sales and downloads summary for a day (units, proceeds, by app and country).',
    input: { vendorNumber: { type: 'string', description: 'The account\'s vendor number (Payments and Financial Reports)' }, date: { type: 'string', description: 'The day, YYYY-MM-DD; reports come a day or two late' } },
    run: async (creds, f, a) => {
      need(a, 'vendorNumber', 'date')
      const got = await apple(creds, f, `/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[version]=1_0&filter[vendorNumber]=${encodeURIComponent(a.vendorNumber)}&filter[reportDate]=${encodeURIComponent(a.date)}`)
      return got.file ? tsv(got.file) : got
    },
  },
  // Changes: each waits for the owner's yes on a card, whoever's account it is.
  {
    name: 'asc_reply_to_review', alwaysAsk: true,
    description: 'Post a public reply to a customer review.',
    input: { reviewId: { type: 'string' }, reply: { type: 'string', description: 'The reply, as the public will read it' } },
    run: async (creds, f, a) => {
      need(a, 'reviewId', 'reply')
      const body = { data: { type: 'customerReviewResponses', attributes: { responseBody: a.reply }, relationships: { review: rel('customerReviews', a.reviewId) } } }
      return (await apple(creds, f, '/v1/customerReviewResponses', { method: 'POST', body: JSON.stringify(body) })).data
    },
  },
  {
    name: 'asc_edit_listing', alwaysAsk: true,
    description: 'Change the listing text of one language of an App Store version. Only the fields given change.',
    input: { localizationId: { type: 'string', description: 'From asc_listing' }, description: { type: 'string' }, keywords: { type: 'string' }, promotionalText: { type: 'string' }, whatsNew: { type: 'string' } },
    run: async (creds, f, a) => {
      need(a, 'localizationId')
      const attributes = Object.fromEntries(['description', 'keywords', 'promotionalText', 'whatsNew'].filter((k) => typeof a[k] === 'string').map((k) => [k, a[k]]))
      if (!Object.keys(attributes).length) throw new StoreError('Give at least one field to change')
      return (await apple(creds, f, `/v1/appStoreVersionLocalizations/${encodeURIComponent(a.localizationId)}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'appStoreVersionLocalizations', id: a.localizationId, attributes } }) })).data
    },
  },
  {
    name: 'asc_submit_for_review', alwaysAsk: true,
    description: 'Send an App Store version to Apple for review.',
    input: { ...APP_ID, versionId: { type: 'string' }, platform: { type: 'string', description: 'IOS, MAC_OS, TV_OS or VISION_OS; IOS if not said' } },
    run: async (creds, f, a) => {
      need(a, 'appId', 'versionId')
      const made = await apple(creds, f, '/v1/reviewSubmissions', { method: 'POST', body: JSON.stringify({ data: { type: 'reviewSubmissions', attributes: { platform: a.platform || 'IOS' }, relationships: { app: rel('apps', a.appId) } } }) })
      const submission = made.data.id
      await apple(creds, f, '/v1/reviewSubmissionItems', { method: 'POST', body: JSON.stringify({ data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', submission), appStoreVersion: rel('appStoreVersions', a.versionId) } } }) })
      return (await apple(creds, f, `/v1/reviewSubmissions/${submission}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submission, attributes: { submitted: true } } }) })).data
    },
  },
  {
    name: 'asc_release', alwaysAsk: true,
    description: 'Release an approved App Store version that is waiting for its developer to release it.',
    input: { versionId: { type: 'string' } },
    run: async (creds, f, a) => { need(a, 'versionId'); return (await apple(creds, f, '/v1/appStoreVersionReleaseRequests', { method: 'POST', body: JSON.stringify({ data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: rel('appStoreVersions', a.versionId) } } }) })).data },
  },
  {
    name: 'asc_phased_release', alwaysAsk: true,
    description: 'Pause, resume or complete a phased (staged) release.',
    input: { phasedReleaseId: { type: 'string' }, state: { type: 'string', enum: ['PAUSED', 'ACTIVE', 'COMPLETE'] } },
    run: async (creds, f, a) => {
      need(a, 'phasedReleaseId', 'state')
      if (!['PAUSED', 'ACTIVE', 'COMPLETE'].includes(a.state)) throw new StoreError('state is PAUSED, ACTIVE or COMPLETE')
      return (await apple(creds, f, `/v1/appStoreVersionPhasedReleases/${encodeURIComponent(a.phasedReleaseId)}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'appStoreVersionPhasedReleases', id: a.phasedReleaseId, attributes: { phasedReleaseState: a.state } } }) })).data
    },
  },
]

// ── Google Play Console ──────────────────────────────────────────────────────────────

const PLAY = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'
const PLAY_UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications'
const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1/apps'
const SCOPES = ['https://www.googleapis.com/auth/androidpublisher', 'https://www.googleapis.com/auth/playdeveloperreporting', 'https://www.googleapis.com/auth/devstorage.read_only']
const tokens = new Map()

/** A Google access token for the service account, made from its key and kept until it nears its end. */
export async function googleToken(account, fetcher, now = Date.now()) {
  const kept = tokens.get(account.client_email)
  if (kept && kept.until - now > 60_000) return kept.token
  const iat = Math.floor(now / 1000)
  const aud = account.token_uri || 'https://oauth2.googleapis.com/token'
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) })}.${b64url({ iss: account.client_email, scope: SCOPES.join(' '), aud, iat, exp: iat + 3600 })}`
  const assertion = `${unsigned}.${crypto.sign('sha256', Buffer.from(unsigned), account.private_key).toString('base64url')}`
  const got = await fetchJson(fetcher, aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
  if (!got.access_token) throw new StoreError('Google did not accept the service account key')
  tokens.set(account.client_email, { token: got.access_token, until: now + (Number(got.expires_in) || 3600) * 1000 })
  return got.access_token
}

async function google(creds, fetcher, url, init = {}) {
  const token = await googleToken(creds.account, fetcher)
  return fetchJson(fetcher, url, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } })
}

const pkgOf = (creds, a) => encodeURIComponent(a.packageName || creds.packageName || '')
const PKG = { packageName: { type: 'string', description: 'The app\'s package name; the one saved with the key if not said' } }

/** Play changes go through an edit: opened, changed, committed; one that is only read is thrown away. */
async function inEdit(creds, f, a, work, { commit = false } = {}) {
  const pkg = pkgOf(creds, a)
  if (!pkg) throw new StoreError('Say packageName')
  const edit = await google(creds, f, `${PLAY}/${pkg}/edits`, { method: 'POST', body: '{}' })
  try {
    const out = await work(`${PLAY}/${pkg}/edits/${edit.id}`, pkg, edit.id)
    if (commit) await google(creds, f, `${PLAY}/${pkg}/edits/${edit.id}:commit`, { method: 'POST', body: '{}' })
    else await google(creds, f, `${PLAY}/${pkg}/edits/${edit.id}`, { method: 'DELETE' }).catch(() => {})
    return out
  } catch (err) {
    await google(creds, f, `${PLAY}/${pkg}/edits/${edit.id}`, { method: 'DELETE' }).catch(() => {})
    throw err
  }
}

const day = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return { year: y, month: m, day: d } }

const playTools = [
  {
    name: 'play_reviews', readOnly: true,
    description: 'The app\'s newest Google Play reviews with their star ratings (the last week, as Google keeps them).',
    input: { ...PKG },
    run: async (creds, f, a) => (await google(creds, f, `${PLAY}/${pkgOf(creds, a)}/reviews?maxResults=100`)).reviews || [],
  },
  {
    name: 'play_tracks', readOnly: true,
    description: 'Each release track (internal, closed, open, production): its releases, version codes, status and rollout share.',
    input: { ...PKG },
    run: async (creds, f, a) => inEdit(creds, f, a, async (at) => (await google(creds, f, `${at}/tracks`)).tracks || []),
  },
  {
    name: 'play_listing', readOnly: true,
    description: 'The store listing text per language: title, short and full description.',
    input: { ...PKG },
    run: async (creds, f, a) => inEdit(creds, f, a, async (at) => (await google(creds, f, `${at}/listings`)).listings || []),
  },
  {
    name: 'play_vitals', readOnly: true,
    description: 'Daily crash rate and ANR rate between two days, from Android vitals.',
    input: { ...PKG, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
    run: async (creds, f, a) => {
      need(a, 'from', 'to')
      const spec = { timelineSpec: { aggregationPeriod: 'DAILY', startTime: { ...day(a.from), timeZone: { id: 'America/Los_Angeles' } }, endTime: { ...day(a.to), timeZone: { id: 'America/Los_Angeles' } } } }
      const base = `${REPORTING}/${pkgOf(creds, a)}`
      const [crashes, anrs] = await Promise.all([
        google(creds, f, `${base}/crashRateMetricSet:query`, { method: 'POST', body: JSON.stringify({ ...spec, metrics: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'] }) }),
        google(creds, f, `${base}/anrRateMetricSet:query`, { method: 'POST', body: JSON.stringify({ ...spec, metrics: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'] }) }),
      ])
      return { crashes: crashes.rows || [], anrs: anrs.rows || [] }
    },
  },
  {
    name: 'play_installs', readOnly: true,
    description: 'A month\'s installs and uninstalls overview from the account\'s Google Play reports bucket.',
    input: { ...PKG, bucket: { type: 'string', description: 'The reports bucket, pubsite_prod_…, from Play Console > Download reports' }, month: { type: 'string', description: 'YYYYMM' } },
    run: async (creds, f, a) => {
      const bucket = a.bucket || creds.bucket
      if (!bucket) throw new StoreError('Say bucket (pubsite_prod_…), or save it with the key')
      need(a, 'month')
      const name = `stats/installs/installs_${a.packageName || creds.packageName}_${a.month}_overview.csv`
      const got = await google(creds, f, `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`)
      // Google writes these reports in UTF-16.
      const raw = got.file ? (got.file[0] === 0xff && got.file[1] === 0xfe ? got.file.subarray(2).toString('utf16le') : got.file.toString('utf8')) : text(got)
      const [head, ...rows] = raw.trim().split(/\r?\n/)
      const keys = head.split(',')
      return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [keys[i], v])))
    },
  },
  // Changes: each waits for the owner's yes on a card, whoever's account it is.
  {
    name: 'play_reply_to_review', alwaysAsk: true,
    description: 'Post a public reply to a Google Play review.',
    input: { ...PKG, reviewId: { type: 'string' }, reply: { type: 'string', description: 'The reply, as the public will read it (up to 350 characters)' } },
    run: async (creds, f, a) => { need(a, 'reviewId', 'reply'); return google(creds, f, `${PLAY}/${pkgOf(creds, a)}/reviews/${encodeURIComponent(a.reviewId)}:reply`, { method: 'POST', body: JSON.stringify({ replyText: a.reply }) }) },
  },
  {
    name: 'play_edit_listing', alwaysAsk: true,
    description: 'Change the store listing text of one language. Only the fields given change.',
    input: { ...PKG, language: { type: 'string', description: 'Like en-US' }, title: { type: 'string' }, shortDescription: { type: 'string' }, fullDescription: { type: 'string' } },
    run: async (creds, f, a) => {
      need(a, 'language')
      const patch = Object.fromEntries(['title', 'shortDescription', 'fullDescription'].filter((k) => typeof a[k] === 'string').map((k) => [k, a[k]]))
      if (!Object.keys(patch).length) throw new StoreError('Give at least one field to change')
      return inEdit(creds, f, a, (at) => google(creds, f, `${at}/listings/${encodeURIComponent(a.language)}`, { method: 'PATCH', body: JSON.stringify(patch) }), { commit: true })
    },
  },
  {
    name: 'play_release', alwaysAsk: true,
    description: 'Put version codes on a track: release, staged rollout share, halt or complete.',
    input: { ...PKG, track: { type: 'string', description: 'internal, alpha, beta or production' }, versionCodes: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['completed', 'inProgress', 'halted', 'draft'] }, userFraction: { type: 'number', description: 'For inProgress: the share of users, like 0.1' }, releaseNotes: { type: 'string', description: 'What\'s new, en-US' } },
    run: async (creds, f, a) => {
      need(a, 'track', 'versionCodes', 'status')
      const release = { versionCodes: a.versionCodes.map(String), status: a.status, ...(a.status === 'inProgress' ? { userFraction: Number(a.userFraction) } : {}), ...(a.releaseNotes ? { releaseNotes: [{ language: 'en-US', text: a.releaseNotes }] } : {}) }
      return inEdit(creds, f, a, (at) => google(creds, f, `${at}/tracks/${encodeURIComponent(a.track)}`, { method: 'PUT', body: JSON.stringify({ track: a.track, releases: [release] }) }), { commit: true })
    },
  },
  {
    name: 'play_upload_bundle', alwaysAsk: true,
    description: 'Upload an Android App Bundle (.aab) from this computer. It is not on any track until play_release puts it there.',
    input: { ...PKG, path: { type: 'string', description: 'The .aab file\'s full path on this computer' } },
    run: async (creds, f, a) => {
      need(a, 'path')
      if (!/\.aab$/i.test(a.path)) throw new StoreError('Give the path of an .aab file')
      const bytes = fs.readFileSync(a.path)
      return inEdit(creds, f, a, (at, pkg, edit) => google(creds, f, `${PLAY_UPLOAD}/${pkg}/edits/${edit}/bundles?uploadType=media`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } }), { commit: true })
    },
  },
]

/**
 * For a release's readiness check: how many products and subscriptions Play holds for an app, read only.
 * Not a bot's tool; the release track's own script asks it with the owner's key.
 */
export async function playProductCount(creds, fetcher, packageName) {
  const pkg = encodeURIComponent(packageName)
  const [items, subs] = await Promise.all([
    google(creds, fetcher, `${PLAY}/${pkg}/inappproducts?maxResults=100`).then((r) => (r.inappproduct || []).length),
    google(creds, fetcher, `${PLAY}/${pkg}/subscriptions?pageSize=100`).then((r) => (r.subscriptions || []).length).catch(() => 0),
  ])
  return items + subs
}

// ── the two connectors ───────────────────────────────────────────────────────────────

export const BUILTINS = {
  'app-store-connect': {
    name: 'App Store Connect',
    fields: [
      { id: 'issuerId', label: 'Issuer ID', hint: 'Users and Access > Integrations > App Store Connect API, above the keys' },
      { id: 'keyId', label: 'Key ID', hint: 'The key\'s ID in the same list' },
      { id: 'privateKey', label: 'The .p8 key file\'s text', long: true, hint: 'Open the downloaded AuthKey_….p8 and paste all of it, BEGIN and END lines too' },
    ],
    check(creds) {
      try { crypto.createPrivateKey(creds.privateKey) } catch { throw new StoreError('That is not a .p8 key: paste the whole file, BEGIN and END lines too') }
      if (!/^[A-Z0-9]{6,20}$/.test(creds.keyId || '')) throw new StoreError('The Key ID is ten letters and digits, like 2X9R4HXF34')
      if (!/^[0-9a-f-]{36}$/i.test(creds.issuerId || '')) throw new StoreError('The Issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a')
      return creds
    },
    tools: appleTools,
  },
  'google-play': {
    name: 'Google Play Console',
    fields: [
      { id: 'serviceAccount', label: 'Service account key (JSON)', long: true, hint: 'A Google Cloud service account invited in Play Console > Users and permissions; paste its whole .json key file' },
      { id: 'packageName', label: 'Package name', hint: 'Like com.example.app; bots can still name another app of the account' },
      { id: 'bucket', label: 'Reports bucket (optional)', optional: true, hint: 'pubsite_prod_… from Play Console > Download reports, for installs' },
    ],
    check(creds) {
      let account
      try { account = typeof creds.serviceAccount === 'string' ? JSON.parse(creds.serviceAccount) : creds.serviceAccount } catch { throw new StoreError('That is not a service account key: paste the whole .json file') }
      if (!account?.client_email || !account?.private_key) throw new StoreError('That JSON has no client_email and private_key: it is not a service account key')
      try { crypto.createPrivateKey(account.private_key) } catch { throw new StoreError('The service account key\'s private_key cannot be read') }
      if (creds.packageName && !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(creds.packageName)) throw new StoreError('A package name looks like com.example.app')
      return { account, packageName: creds.packageName || '', bucket: creds.bucket || '' }
    },
    tools: playTools,
  },
}

/** The tools of a built-in connector as an MCP server lists them. */
export const builtinTools = (kind) => (BUILTINS[kind]?.tools || []).map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.input || {} },
  annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
}))

/** Whether a tool of a built-in connector always waits for the owner's yes. */
export const alwaysAsks = (kind, name) => Boolean(BUILTINS[kind]?.tools.find((t) => t.name === name)?.alwaysAsk)

/** Run one tool with the stored key; the answer is what a bot reads. */
export async function runBuiltin(kind, creds, name, args = {}, { fetcher = fetch } = {}) {
  const tool = BUILTINS[kind]?.tools.find((t) => t.name === name)
  if (!tool) return { content: [{ type: 'text', text: `There is no tool called ${name}` }], isError: true }
  try {
    const out = await tool.run(creds, fetcher, args || {})
    return { content: [{ type: 'text', text: text(out) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof StoreError ? err.message : `It did not work: ${err.message}` }], isError: true }
  }
}
