/**
 * Readiness before a store release (docs/launch.md): what the stores would refuse, checked before anything is sent.
 * Each check is pass, fail (blocks the release), warn (said on the owner's card) or yours (only the owner can do it).
 * Pure where it can be; the reads of the outside world come in through `io`, so tests give their own.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The stores' own limits on listing text, in characters. */
export const LIMITS = {
  play: { title: 30, short: 80, full: 4000, whatsNew: 500 },
  appstore: { name: 30, subtitle: 30, keywords: 100, description: 4000, promo: 170, whatsNew: 4000 },
}
const PLACEHOLDER = /\b(lorem ipsum|todo|tbd|placeholder|coming soon|xxx+|insert (text|here)|your app name)\b/i
/** Packages an app pays through: when one is in the app, the store must hold products for it. */
const BILLING = ['react-native-purchases', 'react-native-iap', 'expo-in-app-purchases', 'expo-iap', '@stripe/stripe-react-native']

/** The listing a writer left: JSON (as asked), or the JSON inside a fenced block of a longer note. */
export function parseListing(text) {
  const raw = String(text || '').trim()
  for (const tryThis of [raw, /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] || '']) {
    try { const v = JSON.parse(tryThis); if (v && typeof v === 'object') return v } catch { /* not this one */ }
  }
  return null
}

const item = (group, text, state, detail = '') => ({ group, text, state, detail })

/** The listing against each store's limits, with no empty field and no placeholder text. */
export function checkListing(listing, stores) {
  const out = []
  if (!listing) return [item('Listing', 'Store listing written as asked', 'fail', 'The listing is not JSON with a part for each store')]
  for (const store of stores) {
    const part = listing[store]
    if (!part) { out.push(item('Listing', `${store === 'play' ? 'Google Play' : 'App Store'} listing written`, 'fail', 'No part for this store')); continue }
    for (const [field, most] of Object.entries(LIMITS[store])) {
      const value = String(part[field] ?? (field === 'whatsNew' ? listing.whatsNew ?? '' : '')).trim()
      const name = `${store === 'play' ? 'Play' : 'App Store'} ${field}`
      if (!value && field !== 'promo') out.push(item('Listing', `${name} present`, 'fail', 'Empty'))
      else if (value.length > most) out.push(item('Listing', `${name} within ${most} characters`, 'fail', `${value.length} characters`))
      else if (PLACEHOLDER.test(value)) out.push(item('Listing', `${name} has no placeholder text`, 'fail', `It says "${PLACEHOLDER.exec(value)[0]}"`))
    }
  }
  if (!out.length) out.push(item('Listing', 'Every field present, within the store limits, with no placeholder text', 'pass'))
  return out
}

/** Width and height of a PNG or JPEG, read from its header; null when it is neither. */
export function imageSize(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      const size = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      i += 2 + size
    }
  }
  return null
}

const walk = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  } catch { return [] }
}

/** The store art in a folder: an icon, a feature graphic for Play, and enough screenshots at shapes the stores take. */
export function checkArt(folder, stores) {
  const files = walk(folder).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => ({ f, size: imageSize(f) })).filter((x) => x.size)
  if (!files.length) return [item('Art', 'Store images made', 'fail', folder ? `No images in ${folder}` : 'No art folder was left')]
  const out = []
  const is = (w, h) => files.some((x) => x.size.w === w && x.size.h === h)
  const shots = files.filter((x) => { const r = Math.max(x.size.w, x.size.h) / Math.min(x.size.w, x.size.h); return r >= 1.5 && r <= 2.4 && Math.min(x.size.w, x.size.h) >= 320 })
  if (stores.includes('play')) {
    out.push(item('Art', 'Play icon 512 x 512', is(512, 512) ? 'pass' : 'fail'))
    out.push(item('Art', 'Play feature graphic 1024 x 500', is(1024, 500) ? 'pass' : 'fail'))
  }
  if (stores.includes('appstore')) {
    const iphone = files.filter((x) => [[1290, 2796], [1320, 2868], [1284, 2778], [1242, 2688]].some(([w, h]) => (x.size.w === w && x.size.h === h) || (x.size.w === h && x.size.h === w)))
    out.push(item('Art', 'App Store iPhone screenshots at a size Apple takes (6.7 or 6.9 inch)', iphone.length >= 3 ? 'pass' : 'fail', `${iphone.length} found, at least 3 wanted`))
  }
  out.push(item('Art', 'Phone screenshots', shots.length >= 2 ? 'pass' : 'fail', `${shots.length} found, at least 2 wanted (Play needs 2 to 8)`))
  return out
}

/** Every check before a release, in groups, and whether anything blocks it. */
export async function readiness({ listing, artFolder, aab, appFolder, stores, io }) {
  const items = [...checkListing(listing, stores), ...checkArt(artFolder, stores)]
  // Addresses the stores open: they must answer.
  for (const [key, name] of [['privacyUrl', 'Privacy policy'], ['supportUrl', 'Support page']]) {
    const url = listing?.[key]
    if (!url) items.push(item('Legal', `${name} address in the listing`, key === 'privacyUrl' ? 'fail' : 'warn', 'Not given'))
    else items.push(item('Legal', `${name} answers (${url})`, (await io.answers(url)) ? 'pass' : 'fail'))
  }
  // The build: there, and newer than anything the store holds.
  if (stores.includes('play')) {
    const size = aab ? io.fileSize(aab) : 0
    items.push(item('Build', 'Android App Bundle built', size > 0 ? 'pass' : 'fail', aab || 'No .aab path was left'))
    const code = Number(io.versionCode?.(aab)) || 0
    const highest = await io.playHighestCode().catch(() => null)
    if (highest === null) items.push(item('Build', 'Version code higher than Play holds', 'warn', 'Play could not be read'))
    else items.push(item('Build', 'Version code higher than Play holds', !code ? 'warn' : code > highest ? 'pass' : 'fail', code ? `${code} against ${highest}` : `Play holds ${highest}; the bundle's own code could not be read`))
  }
  // Payments: an app that pays through a store needs products in it (test mode only is checked here).
  const deps = io.dependencies(appFolder)
  const pays = BILLING.filter((d) => deps.includes(d))
  if (!pays.length) items.push(item('Payments', 'The app takes no payment through a store', 'pass'))
  else if (stores.includes('play')) {
    const products = await io.playProducts().catch(() => null)
    items.push(item('Payments', `Play holds products for ${pays.join(', ')}`, products === null ? 'warn' : products > 0 ? 'pass' : 'fail', products === null ? 'Play could not be read' : `${products} product${products === 1 ? '' : 's'}`))
    items.push(item('Payments', 'A test purchase by a licence tester', 'yours', 'Buy once on the test phone with a tester account'))
  }
  for (const s of stores) items.push(item('Legal', `${s === 'play' ? 'Play content rating and Data safety' : 'App Store privacy answers'} up to date`, 'yours', 'Only you can submit these in the console; the crew drafts the answers'))
  const blocking = items.filter((i) => i.state === 'fail')
  return { items, ok: !blocking.length, blocking }
}

/** The readiness list as the owner's card and the trip page say it. */
export function readinessText(result) {
  const mark = { pass: 'OK', fail: 'FAIL', warn: 'CHECK', yours: 'YOURS' }
  return result.items.map((i) => `${mark[i.state]}  ${i.group}: ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('\n')
}
