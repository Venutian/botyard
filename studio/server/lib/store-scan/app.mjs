/**
 * An app as the store scan reads it (docs/store-rules.md): its platforms, its Expo config, its Android manifest and
 * Gradle files, its iOS Info.plist and privacy file, its packages, and its own source and web files, each with the
 * lines a rule may point at. Reads only; never runs the app's code.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Folders that are never part of what a store receives. */
export const SKIP = new Set(['node_modules', '.git', '.botyard', '.gradle', '.cxx', 'build', 'Pods', 'DerivedData', '.expo', 'dist', 'web-build', 'tmp', 'coverage', '__tests__', 'test', 'tests', 'e2e', 'fixtures', 'vendor'])
const SOURCE = /\.(jsx?|tsx?|mjs|kt|kts|java|swift|m|mm|dart)$/i
const WEB = /\.html?$/i
const MAX_FILES = 4000
const MAX_BYTES = 400 * 1024

const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
const json = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

/** Every file under `dir` the scan looks at, relative to `root`, with the skipped folders left out. */
export function filesOf(root, dir = root, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) filesOf(root, path.join(dir, e.name), out) } else out.push(path.relative(root, path.join(dir, e.name)))
  }
  return out
}

/** The `<key>…</key><string|true|false…>` pairs of a property list, by key. */
export function plistKeys(text) {
  const out = {}
  const re = /<key>([^<]+)<\/key>\s*(<string>([\s\S]*?)<\/string>|<(true|false)\s*\/>|<(array|dict)>)/g
  for (let m; (m = re.exec(text));) out[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] === 'true' : m[5]
  return out
}

/** The 1-based line of the first match of `re` in `text`, or 0. */
export function lineOf(text, re) {
  const m = re.exec(text)
  return m ? text.slice(0, m.index).split('\n').length : 0
}

/**
 * What can be read of a JavaScript Expo config without running it: the store ids, Info.plist strings and flags,
 * whether it has a privacy manifest, its Android permissions and its plugins.
 */
export function configFromText(text) {
  const str = (re) => re.exec(text)?.[2]
  const infoPlist = {}
  for (const m of text.matchAll(/\b(NS\w+UsageDescription|ITSAppUsesNonExemptEncryption|NSUserTrackingUsageDescription)\s*:\s*(?:(['"`])([\s\S]*?)\2|(true|false))/g)) infoPlist[m[1]] = m[4] ? m[4] === 'true' : m[3]
  const plugins = []
  const block = /plugins\s*:\s*\[([\s\S]*?)\n\s*\]\s*,?\s*\n/.exec(text)?.[1] || ''
  for (const m of block.matchAll(/^\s*\[?\s*['"]([@\w./-]+)['"]/gm)) plugins.push(m[1])
  const perms = /permissions\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] || ''
  return {
    ios: { bundleIdentifier: str(/bundleIdentifier\s*:\s*(['"`])([^'"`]+)\1/), infoPlist, ...(/privacyManifests\s*:/.test(text) ? { privacyManifests: {} } : {}) },
    android: { package: str(/\bpackage\s*:\s*(['"`])([\w.]+)\1/), permissions: [...perms.matchAll(/['"]([\w.]+)['"]/g)].map((m) => m[1]) },
    plugins,
  }
}

/** An object without its undefined values, so a value the text did not give never hides the base's. */
const defined = (o = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const merge = (base = {}, over = {}) => ({ ...base, ...over, ios: { ...base.ios, ...defined(over.ios), infoPlist: { ...base.ios?.infoPlist, ...over.ios?.infoPlist } }, android: { ...base.android, ...defined(over.android) }, plugins: over.plugins?.length ? over.plugins : base.plugins })

/**
 * The Expo config: app.json, or what can be read of app.config.js/ts, on top of the monorepo root's app.json when the
 * app sits in apps/<name> (a root that holds the store ids for the build service).
 */
function expoOf(root, outer) {
  const base = outer && outer !== root ? json(path.join(outer, 'app.json'))?.expo : null
  const app = json(path.join(root, 'app.json'))
  if (app) return { config: merge(base || {}, app.expo || app), text: read(path.join(root, 'app.json')), file: 'app.json' }
  for (const f of ['app.config.ts', 'app.config.js']) {
    const text = read(path.join(root, f))
    if (text) return { config: merge(base || {}, configFromText(text)), text, file: f }
  }
  return base ? { config: base, text: '', file: path.join(path.relative(root, outer), 'app.json') } : null
}

/** The Android target SDK from Gradle, gradle.properties, or the Expo SDK's default; null when it cannot be told. */
function targetSdkOf(root, gradle, deps) {
  const direct = /targetSdk(?:Version)?\s*[=(]?\s*(\d{2})/.exec(gradle.text)
  if (direct) return { value: Number(direct[1]), from: gradle.file }
  for (const f of ['android/build.gradle', 'android/gradle.properties', 'android/build.gradle.kts']) {
    const m = /targetSdk(?:Version)?\s*[=:]?\s*(?:Integer\.parseInt\(.*?\)\s*:\s*)?['"]?(\d{2})/.exec(read(path.join(root, f)))
    if (m) return { value: Number(m[1]), from: f }
  }
  // Expo's own defaults, when nothing above sets it (expo-build-properties may, in app.json).
  const props = /"targetSdkVersion"\s*:\s*(\d{2})/.exec(read(path.join(root, 'app.json')))
  if (props) return { value: Number(props[1]), from: 'app.json' }
  const expo = /(\d+)\./.exec(String(deps.expo || '').replace(/^[^\d]*/, ''))
  const BY_EXPO = { 50: 34, 51: 34, 52: 35, 53: 35, 54: 36, 55: 36 }
  if (expo && BY_EXPO[expo[1]]) return { value: BY_EXPO[expo[1]], from: `Expo SDK ${expo[1]}'s default` }
  return null
}

/** Folders whose code never ships in the app, for an app whose entry cannot be found. */
const NOT_SHIPPED = /^(scripts|tools|docs|server|api|backend|functions|e2e|store|marketing|studio|crew|desktop|edge|bin)\//
const EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.native.tsx', '.native.ts', '.ios.tsx', '.android.tsx', '.native.js']
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

/**
 * The app's own JavaScript that ships: every file reached by imports from its entry (package.json main, index, App,
 * and expo-router's app/ folder), so build scripts, docs and server code beside the app are not read as the app.
 * Null when no entry is found.
 */
export function shippedOf(root, files, pkg) {
  const have = new Set(files)
  const resolve = (from, spec) => {
    let base
    if (spec.startsWith('.')) base = path.join(path.dirname(from), spec)
    else if (/^[@~]\//.test(spec)) base = spec.slice(2)
    else if (/^src\//.test(spec)) base = spec
    else return null
    for (const b of [base, path.join('src', base)]) {
      for (const ext of [...EXTS, ...EXTS.slice(1).map((e) => `/index${e}`)]) {
        const f = path.normalize(b + ext)
        if (have.has(f) && SOURCE.test(f)) return f
      }
    }
    return null
  }
  const entries = []
  const main = String(pkg.main || '')
  if (main && !main.includes('node_modules') && !/^expo(-router)?\//.test(main)) entries.push(resolve('index.js', `./${main.replace(/^\.\//, '')}`))
  for (const f of ['index.js', 'index.ts', 'index.tsx', 'App.tsx', 'App.ts', 'App.js', 'App.jsx', 'src/App.tsx', 'src/App.js']) if (have.has(f)) entries.push(f)
  if (main.startsWith('expo-router') || pkg.dependencies?.['expo-router']) entries.push(...files.filter((f) => /^(src\/)?app\//.test(f) && SOURCE.test(f)))
  const todo = entries.filter(Boolean)
  if (!todo.length) return null
  const seen = new Set()
  while (todo.length) {
    const f = todo.pop()
    if (seen.has(f)) continue
    seen.add(f)
    const text = read(path.join(root, f))
    IMPORT.lastIndex = 0
    for (let m; (m = IMPORT.exec(text));) {
      const next = resolve(f, m[1] || m[2] || m[3] || m[4])
      if (next && !seen.has(next)) todo.push(next)
    }
  }
  return seen
}

/** The app's own folder: `root`, or the one app inside a monorepo (apps/<name>, packages/<name>) when root has none. */
export function appRootOf(root) {
  // A root app.json that only carries build settings (an EAS project id) is not the app; its app is in apps/.
  const rootPkg = json(path.join(root, 'package.json')) || {}
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies }
  const isApp = ['android', 'ios'].some((f) => fs.existsSync(path.join(root, f)))
    || (['app.json', 'app.config.js', 'app.config.ts'].some((f) => fs.existsSync(path.join(root, f))) && Boolean(rootDeps.expo || rootDeps['react-native']))
  if (isApp) return root
  for (const group of ['apps', 'packages']) {
    let names = []
    try { names = fs.readdirSync(path.join(root, group)) } catch { continue }
    const found = names.map((n) => path.join(root, group, n)).filter((d) => ['app.json', 'app.config.js', 'app.config.ts'].some((f) => fs.existsSync(path.join(d, f))))
    if (found.length) return found.find((d) => /mobile|app/.test(path.basename(d))) || found[0]
  }
  return root
}

/** Reads the app in `folder` (or the one app inside it). */
export function readApp(folder) {
  const root = appRootOf(folder)
  const files = filesOf(root)
  const pkg = json(path.join(root, 'package.json')) || {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const expo = expoOf(root, folder)
  const manifestFile = files.find((f) => /(^|\/)src\/main\/AndroidManifest\.xml$/.test(f)) || files.find((f) => f.endsWith('AndroidManifest.xml'))
  const gradleFile = ['android/app/build.gradle', 'android/app/build.gradle.kts'].find((f) => files.includes(f)) || ''
  const plistFile = files.find((f) => /^ios\/[^/]+\/Info\.plist$/.test(f)) || files.find((f) => f.endsWith('Info.plist') && !/Tests?\//.test(f))
  const gradle = { file: gradleFile, text: gradleFile ? read(path.join(root, gradleFile)) : '' }
  const plist = plistFile ? { file: plistFile, text: read(path.join(root, plistFile)) } : null
  const expoIos = expo?.config?.ios || {}
  const expoAndroid = expo?.config?.android || {}
  // What ships: the JavaScript its entry reaches, and the native code of its Android and iOS projects.
  const shipped = shippedOf(root, files, pkg)
  const native = (f) => /^android\/app\/src\/main\//.test(f) || (/^ios\//.test(f) && !/Pods\//.test(f))
  const source = files.filter((f) => SOURCE.test(f) && !/\.(test|spec)\./.test(f) && !/\/generated\//.test(f) && !/(^|\/)[\w.-]+\.config\.(m?js|ts)$/.test(f)
    && (native(f) || (shipped ? shipped.has(f) : !NOT_SHIPPED.test(f) && !/^(android|ios)\//.test(f))))
    .map((f) => ({ file: f, text: fs.statSync(path.join(root, f)).size <= MAX_BYTES ? read(path.join(root, f)) : '' }))
  const web = files.filter((f) => WEB.test(f)).map((f) => ({ file: f, text: read(path.join(root, f)) }))
  const android = Boolean(manifestFile || gradleFile || (expo && (expoAndroid.package || !expoIos.bundleIdentifier)))
  const ios = Boolean(plistFile || expoIos.bundleIdentifier || files.some((f) => f.endsWith('.xcodeproj/project.pbxproj')))
  return {
    root, appDir: path.relative(folder, root), files, deps, pkg, expo, shippedFrom: shipped ? 'imports' : 'folders',
    platforms: { android, ios, web: web.length > 0 || Boolean(deps['react-native-web']) },
    manifest: manifestFile ? { file: manifestFile, text: read(path.join(root, manifestFile)) } : null,
    gradle,
    gradleProps: read(path.join(root, 'android', 'gradle.properties')),
    targetSdk: targetSdkOf(root, gradle, deps),
    // Info.plist keys, from the native file or Expo's ios.infoPlist (both, the native file winning).
    plist: { file: plist?.file || expo?.file || '', text: plist?.text || '', keys: { ...(expoIos.infoPlist || {}), ...(plist ? plistKeys(plist.text) : {}) } },
    privacyManifest: files.some((f) => f.endsWith('PrivacyInfo.xcprivacy')) || Boolean(expoIos.privacyManifests),
    androidPermissions: [...new Set([...(manifestFile ? [...read(path.join(root, manifestFile)).matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]) : []), ...(expoAndroid.permissions || []).map((p) => (p.includes('.') ? p : `android.permission.${p}`))])],
    source,
    web,
  }
}

/** Where `re` first matches in the app's own source (and web files when `web`): { file, line, text } or null. */
export function findIn(app, re, { web = false, files = null } = {}) {
  for (const f of files || [...app.source, ...(web ? app.web : [])]) {
    re.lastIndex = 0
    const line = lineOf(f.text, re)
    if (line) return { file: f.file, line, text: f.text.split('\n')[line - 1].trim().slice(0, 160) }
  }
  return null
}

/** True when any of the packages is in the app. */
export const uses = (app, names) => names.some((n) => (n.endsWith('*') ? Object.keys(app.deps).some((d) => d.startsWith(n.slice(0, -1))) : n in app.deps))
