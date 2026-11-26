/**
 * Botyard's store rules (docs/store-rules.md): what Apple and Google turn an app away for, written for the crew in plain
 * words, each with its fix and the store's own page. Three levels:
 *   stop  blocks the release and is never waived (a store refuses it outright, or it leaks a secret);
 *   fix   blocks the release; the crew may waive one it proves does not apply, with evidence;
 *   look  does not block; listed on the release card.
 * Every rule reads the app (app.mjs) and the release (stores, features); none runs the app's code. A rule is kept
 * current by the weekly rules watch (crew/store-rules-watch.py), which reads the stores' own pages.
 */
import { findIn, lineOf, uses } from './app.mjs'

const APPLE_GUIDE = 'https://developer.apple.com/app-store/review/guidelines/'
const PLAY_POLICY = 'https://play.google/developer-content-policy/'

/** Play's lowest target API level for new apps and updates, by date (Google raises it every 31 August). */
export const PLAY_TARGET = [{ from: '2025-08-31', level: 35 }, { from: '2026-08-31', level: 36 }]
export const playTargetOn = (today) => PLAY_TARGET.filter((t) => t.from <= today).at(-1)?.level || 34

/** Protected things an iOS app may touch: the packages that touch them, the Info.plist key Apple needs, in words. */
export const PROTECTED = [
  { key: 'NSCameraUsageDescription', what: 'the camera', deps: ['expo-camera', 'react-native-vision-camera', 'expo-image-picker', 'react-native-image-picker', 'expo-barcode-scanner'] },
  { key: 'NSPhotoLibraryUsageDescription', what: 'the photo library', deps: ['expo-image-picker', 'expo-media-library', 'react-native-image-picker', '@react-native-camera-roll/camera-roll'] },
  { key: 'NSMicrophoneUsageDescription', what: 'the microphone', deps: ['expo-audio', 'react-native-audio-recorder-player', '@react-native-voice/voice', 'react-native-vision-camera'], source: /Audio\.Recording|useAudioRecorder|RecordingPresets/ },
  { key: 'NSLocationWhenInUseUsageDescription', what: 'the location', deps: ['expo-location', '@react-native-community/geolocation', 'react-native-geolocation-service', 'react-native-maps'], source: /getCurrentPositionAsync|watchPositionAsync|requestForegroundPermissionsAsync|getCurrentPosition\(/ },
  { key: 'NSContactsUsageDescription', what: 'the contacts', deps: ['expo-contacts', 'react-native-contacts'] },
  { key: 'NSCalendarsFullAccessUsageDescription', what: 'the calendar', deps: ['expo-calendar', 'react-native-calendar-events'], alt: ['NSCalendarsUsageDescription', 'NSCalendarsWriteOnlyAccessUsageDescription'] },
  { key: 'NSBluetoothAlwaysUsageDescription', what: 'Bluetooth', deps: ['react-native-ble-plx', 'react-native-ble-manager'] },
  { key: 'NSFaceIDUsageDescription', what: 'Face ID', deps: ['expo-local-authentication', 'react-native-biometrics', 'react-native-touch-id'] },
  { key: 'NSMotionUsageDescription', what: 'motion and fitness', deps: ['expo-sensors'], source: /Pedometer/ },
  { key: 'NSHealthShareUsageDescription', what: 'Health data', deps: ['react-native-health', '@kingstinct/react-native-healthkit'] },
  { key: 'NSUserTrackingUsageDescription', what: 'tracking across apps (App Tracking Transparency)', deps: ['react-native-fbsdk-next', 'react-native-google-mobile-ads', 'react-native-appsflyer', '@adjust/react-native-sdk', 'expo-tracking-transparency'] },
]
/** Expo config plugins that write their own purpose string when listed in the app's plugins. */
const PLUGIN_WRITES = { 'expo-camera': ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'], 'expo-image-picker': ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSMicrophoneUsageDescription'], 'expo-media-library': ['NSPhotoLibraryUsageDescription'], 'expo-location': ['NSLocationWhenInUseUsageDescription'], 'expo-contacts': ['NSContactsUsageDescription'], 'expo-calendar': ['NSCalendarsUsageDescription', 'NSCalendarsFullAccessUsageDescription'], 'expo-local-authentication': ['NSFaceIDUsageDescription'], 'expo-tracking-transparency': ['NSUserTrackingUsageDescription'], 'expo-sensors': ['NSMotionUsageDescription'], 'expo-audio': ['NSMicrophoneUsageDescription'] }
const pluginsOf = (app) => (app.expo?.config?.plugins || []).map((p) => (Array.isArray(p) ? p[0] : p))

/** Restricted Android permissions: Play asks for a declaration, and most apps are refused them. */
export const RESTRICTED = [
  { perm: 'android.permission.QUERY_ALL_PACKAGES', what: 'see every installed app', source: 'https://support.google.com/googleplay/android-developer/answer/10158779' },
  { perm: 'android.permission.READ_SMS', what: 'read text messages', source: 'https://support.google.com/googleplay/android-developer/answer/10208820' },
  { perm: 'android.permission.SEND_SMS', what: 'send text messages', source: 'https://support.google.com/googleplay/android-developer/answer/10208820' },
  { perm: 'android.permission.RECEIVE_SMS', what: 'receive text messages', source: 'https://support.google.com/googleplay/android-developer/answer/10208820' },
  { perm: 'android.permission.READ_CALL_LOG', what: 'read the call log', source: 'https://support.google.com/googleplay/android-developer/answer/10208820' },
  { perm: 'android.permission.MANAGE_EXTERNAL_STORAGE', what: 'read and write all files', source: 'https://support.google.com/googleplay/android-developer/answer/10467955' },
  { perm: 'android.permission.REQUEST_INSTALL_PACKAGES', what: 'install other apps', source: 'https://support.google.com/googleplay/android-developer/answer/12085295' },
  { perm: 'android.permission.ACCESS_BACKGROUND_LOCATION', what: 'track location in the background', source: 'https://support.google.com/googleplay/android-developer/answer/9799150' },
  { perm: 'android.permission.USE_EXACT_ALARM', what: 'set exact alarms (only for alarm and calendar apps)', source: 'https://developer.android.com/about/versions/14/changes/schedule-exact-alarms' },
  { perm: 'android.permission.READ_MEDIA_IMAGES', what: 'read all photos (a photo picker needs no permission)', source: 'https://support.google.com/googleplay/android-developer/answer/14115180' },
  { perm: 'android.permission.READ_MEDIA_VIDEO', what: 'read all videos (a photo picker needs no permission)', source: 'https://support.google.com/googleplay/android-developer/answer/14115180' },
]

const TRACKERS = ['react-native-fbsdk-next', 'react-native-google-mobile-ads', 'react-native-appsflyer', '@adjust/react-native-sdk', 'react-native-branch', '@segment/analytics-react-native', '@amplitude/analytics-react-native', 'mixpanel-react-native', '@react-native-firebase/analytics', 'expo-firebase-analytics']
const ADS = ['react-native-google-mobile-ads', 'react-native-fbsdk-next', 'react-native-applovin-max', 'react-native-unity-ads', 'expo-ads-admob']
const LOGIN = ['@react-native-google-signin/google-signin', 'react-native-fbsdk-next', 'expo-auth-session', '@invertase/react-native-apple-authentication', 'expo-apple-authentication']
const BILLING = ['react-native-purchases', 'react-native-iap', 'expo-iap', 'expo-in-app-purchases']
const AI = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', 'ai', '@mistralai/mistralai', 'groq-sdk']
const PAY_LINK = /https?:\/\/(buy\.stripe\.com|checkout\.stripe\.com|(www\.)?paypal\.(com|me)|ko-fi\.com|(www\.)?buymeacoffee\.com|(www\.)?patreon\.com|[\w-]+\.gumroad\.com|[\w-]+\.lemonsqueezy\.com)/i

const at = (file, line = 0, detail = '') => ({ file, line, detail })
const manifestHit = (app, re, detail) => { const line = app.manifest ? lineOf(app.manifest.text, re) : 0; return line ? at(app.manifest.file, line, detail) : null }
const has = (app, f) => (app.features || []).includes(f)

/** Accounts: the app signs people up (its features say so, or its code does). */
export const hasAccounts = (app) => has(app, 'accounts') || Boolean(findIn(app, /createUserWithEmailAndPassword|auth\.signUp|signUpWith|createAccount\(|\bsign ?up\b|\bregister\(/i))

export const RULES = [
  // ── Build and upload: what a store refuses before anyone reviews it ──
  {
    id: 'play.target-api', store: 'play', level: 'stop', area: 'build', title: "Target API level is below Play's minimum",
    fix: "Raise targetSdkVersion to the level Play asks for now (in Expo, upgrade the SDK or set it with expo-build-properties), then test the app's behaviour changes on that Android version.",
    source: 'https://developer.android.com/google/play/requirements/target-sdk',
    test: (app, c) => (app.targetSdk && app.targetSdk.value < playTargetOn(c.today) ? at(app.targetSdk.from, 0, `targets ${app.targetSdk.value}; Play asks for ${playTargetOn(c.today)}`) : null),
  },
  {
    id: 'play.target-api-unknown', store: 'play', level: 'look', area: 'build', title: 'Target API level could not be read',
    fix: 'Set targetSdkVersion in android/app/build.gradle or with expo-build-properties, so it can be checked before upload.',
    source: 'https://developer.android.com/google/play/requirements/target-sdk',
    test: (app) => (app.platforms.android && !app.targetSdk ? at('', 0, 'no targetSdkVersion found') : null),
  },
  {
    id: 'android.debuggable', store: 'play', level: 'stop', area: 'build', title: 'The release build is debuggable',
    fix: 'Remove android:debuggable="true" from the manifest; release builds are never debuggable.',
    source: 'https://developer.android.com/studio/publish/preparing',
    test: (app) => manifestHit(app, /android:debuggable="true"/),
  },
  {
    id: 'android.exported-missing', store: 'play', level: 'fix', area: 'build', title: 'A component with an intent filter does not say android:exported',
    fix: 'Add android:exported="true" or "false" to every activity, service and receiver that has an intent-filter (required from Android 12).',
    source: 'https://developer.android.com/about/versions/12/behavior-changes-12#exported',
    test: (app) => {
      if (!app.manifest) return null
      const tags = [...app.manifest.text.matchAll(/<(activity|service|receiver)\b([^>]*)>([\s\S]*?)<\/\1>/g)]
      const bad = tags.find((m) => /<intent-filter/.test(m[3]) && !/android:exported=/.test(m[2]))
      return bad ? at(app.manifest.file, app.manifest.text.slice(0, bad.index).split('\n').length, bad[1]) : null
    },
  },
  {
    id: 'android.fgs-type', store: 'play', level: 'fix', area: 'build', title: 'A foreground service has no type',
    fix: 'Give each foreground service an android:foregroundServiceType and its FOREGROUND_SERVICE_<TYPE> permission (required from Android 14), and declare the type in Play Console.',
    source: 'https://developer.android.com/about/versions/14/changes/fgs-types-required',
    test: (app) => (app.androidPermissions.includes('android.permission.FOREGROUND_SERVICE') && app.manifest && /<service\b(?![^>]*foregroundServiceType)[^>]*>/.test(app.manifest.text) && !app.androidPermissions.some((p) => /FOREGROUND_SERVICE_/.test(p))
      ? manifestHit(app, /<service\b(?![^>]*foregroundServiceType)/) : null),
  },
  {
    id: 'secret.in-app', store: 'both', level: 'stop', area: 'security', title: 'A secret key ships inside the app',
    fix: 'Move the key to a server the app calls; rotate the key now, since every copy of the app already holds it.',
    source: 'https://developer.android.com/privacy-and-security/risks/hardcoded-cryptographic-secrets',
    test: (app) => findIn(app, /\b(sk_live_[0-9a-zA-Z]{10,}|rk_live_[0-9a-zA-Z]{10,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|"type"\s*:\s*"service_account")/),
  },
  // ── Privacy ──
  ...PROTECTED.map((p) => ({
    id: `apple.purpose.${p.key.replace(/^NS|UsageDescription$/g, '').toLowerCase()}`, store: 'apple', level: 'stop', area: 'privacy', title: `No purpose string for ${p.what}`,
    fix: `Add ${p.key} to Info.plist (in Expo: ios.infoPlist, or the package's config plugin) saying in one plain sentence why the app uses ${p.what}. Without it the app crashes when it asks, and Apple rejects it (5.1.1).`,
    source: 'https://developer.apple.com/documentation/bundleresources/protected-resources',
    test: (app) => {
      if (!app.platforms.ios || !uses(app, p.deps)) return null
      if (p.source && !findIn(app, p.source)) return null
      const keys = [p.key, ...(p.alt || [])]
      if (keys.some((k) => app.plist.keys[k])) return null
      if (pluginsOf(app).some((name) => (PLUGIN_WRITES[name] || []).some((k) => keys.includes(k)))) return null
      return at(app.plist.file || 'Info.plist', 0, `${p.deps.find((d) => d in app.deps)} is in the app`)
    },
  })),
  {
    id: 'apple.purpose-vague', store: 'apple', level: 'fix', area: 'privacy', title: 'A purpose string does not say why',
    fix: 'Write each purpose string as what the person gets: "Scan a receipt to add it to your expenses", not "This app needs camera access".',
    source: `${APPLE_GUIDE}#5.1.1`,
    test: (app) => {
      const vague = Object.entries(app.plist.keys).find(([k, v]) => /UsageDescription$/.test(k) && typeof v === 'string' && (v.trim().length < 25 || /^(this app|the app|\$\(PRODUCT_NAME\)) (needs|requires|wants|would like)/i.test(v.trim()) || /^allow \$\(PRODUCT_NAME\) to access/i.test(v.trim())))
      return vague ? at(app.plist.file, app.plist.text ? lineOf(app.plist.text, new RegExp(`<key>${vague[0]}</key>`)) : 0, `${vague[0]}: "${vague[1]}"`) : null
    },
  },
  {
    id: 'apple.privacy-manifest', store: 'apple', level: 'fix', area: 'privacy', title: 'No privacy manifest',
    fix: 'Add PrivacyInfo.xcprivacy (in Expo: ios.privacyManifests) with the required-reason APIs the app and its packages use (React Native itself uses UserDefaults and file timestamps) and what data it collects.',
    source: 'https://developer.apple.com/documentation/bundleresources/privacy-manifest-files',
    test: (app) => (app.platforms.ios && !app.privacyManifest ? at(app.expo?.file || '', 0, 'no PrivacyInfo.xcprivacy and no ios.privacyManifests') : null),
  },
  {
    id: 'apple.tracking-prompt', store: 'apple', level: 'fix', area: 'privacy', title: 'A tracking or ads package without the tracking prompt',
    fix: 'Ask with App Tracking Transparency before any tracking (expo-tracking-transparency), add NSUserTrackingUsageDescription, and answer the App Store privacy questions to match.',
    source: 'https://developer.apple.com/documentation/apptrackingtransparency',
    test: (app) => (app.platforms.ios && uses(app, TRACKERS) && !app.plist.keys.NSUserTrackingUsageDescription && !pluginsOf(app).includes('expo-tracking-transparency') ? at('package.json', 0, TRACKERS.filter((t) => t in app.deps).join(', ')) : null),
  },
  {
    id: 'both.privacy-link', store: 'both', level: 'fix', area: 'privacy', title: 'The app has no link to its privacy policy',
    fix: 'Put a "Privacy policy" link where people can find it (settings or about), opening the same address as the store listing.',
    source: `${APPLE_GUIDE}#5.1.1`,
    test: (app) => (app.source.length && !findIn(app, /privacy/i) ? at('', 0, 'the word "privacy" is nowhere in the app') : null),
  },
  {
    id: 'both.account-deletion', store: 'both', level: 'fix', area: 'privacy', title: 'People can sign up but cannot delete their account in the app',
    fix: 'Add "Delete account" in the app (settings), which deletes the account and its data, not only signs out; Play also needs a web address for it in the Data safety form.',
    source: 'https://developer.apple.com/support/offering-account-deletion-in-your-app/',
    test: (app) => (hasAccounts(app) && !findIn(app, /delete (my |your )?account|deleteAccount|deleteUser|account deletion/i) ? findIn(app, /createUserWithEmailAndPassword|auth\.signUp|signUpWith|createAccount\(|\bsign ?up\b/i) || at('', 0, 'the app has accounts') : null),
  },
  {
    id: 'apple.login-option', store: 'apple', level: 'fix', area: 'privacy', title: 'Third-party sign-in without a private sign-in option',
    fix: 'Offer Sign in with Apple (expo-apple-authentication) next to Google or Facebook sign-in (4.8).',
    source: `${APPLE_GUIDE}#4.8`,
    test: (app) => (app.platforms.ios && uses(app, ['@react-native-google-signin/google-signin', 'react-native-fbsdk-next']) && !uses(app, ['expo-apple-authentication', '@invertase/react-native-apple-authentication']) ? at('package.json', 0, 'Google or Facebook sign-in, no Sign in with Apple') : null),
  },
  {
    id: 'kids.ads-or-tracking', store: 'both', level: 'fix', area: 'privacy', title: 'An app for children carries ads or tracking packages',
    fix: "Remove third-party analytics and ads from an app made for children, or use only providers certified for families, and answer Play's target audience form to match.",
    source: 'https://support.google.com/googleplay/android-developer/answer/9893335',
    test: (app) => (has(app, 'kids') && uses(app, [...TRACKERS, ...ADS]) ? at('package.json', 0, [...TRACKERS, ...ADS].filter((t) => t in app.deps).join(', ')) : null),
  },
  // ── Permissions ──
  ...RESTRICTED.map((r) => ({
    id: `play.restricted.${r.perm.split('.').pop().toLowerCase()}`, store: 'play', level: 'fix', area: 'permissions', title: `Restricted permission: ${r.what}`,
    fix: `Remove ${r.perm.split('.').pop()} unless it is the app's core feature; if it is, fill Play's permission declaration with a video of the feature.`,
    source: r.source,
    test: (app) => (app.androidPermissions.includes(r.perm) ? manifestHit(app, new RegExp(r.perm.replace(/\./g, '\\.'))) || at(app.expo?.file || '', 0, r.perm) : null),
  })),
  {
    id: 'android.overlay', store: 'play', level: 'look', area: 'permissions', title: 'Draws over other apps (SYSTEM_ALERT_WINDOW)',
    fix: 'Remove it unless the app needs it; Play looks hard at overlays, above all with accessibility services.',
    source: PLAY_POLICY,
    test: (app) => (app.androidPermissions.includes('android.permission.SYSTEM_ALERT_WINDOW') ? manifestHit(app, /SYSTEM_ALERT_WINDOW/) || at('', 0, 'SYSTEM_ALERT_WINDOW') : null),
  },
  // ── Payments ──
  {
    id: 'both.payment-link', store: 'both', level: 'fix', area: 'payments', title: 'A payment link outside the store',
    fix: "Digital goods and tips inside the app go through the store's billing (Play Billing, Apple in-app purchase). Remove the link from the app, or keep it only for physical goods and services, and say which in a waiver.",
    source: 'https://support.google.com/googleplay/android-developer/answer/9858738',
    test: (app) => findIn(app, PAY_LINK),
  },
  {
    id: 'both.restore-purchases', store: 'both', level: 'fix', area: 'payments', title: 'In-app purchases without "Restore purchases"',
    fix: 'Add a "Restore purchases" button on the paywall or in settings (3.1.1), and the terms and privacy links beside a subscription.',
    source: `${APPLE_GUIDE}#3.1.1`,
    test: (app) => (uses(app, BILLING) && !findIn(app, /restore/i) ? at('package.json', 0, BILLING.filter((b) => b in app.deps).join(', ')) : null),
  },
  // ── Content ──
  {
    id: 'both.server-address', store: 'both', level: 'fix', area: 'content', title: 'The app talks to a computer the reviewer cannot reach',
    fix: 'Point the release build at the live server; keep localhost, 10.0.2.2 and tunnel addresses behind __DEV__ only.',
    source: `${APPLE_GUIDE}#2.1`,
    test: (app) => {
      // Only an address the app connects to: a fetch, a client's base address, or a constant named for a server.
      const hit = findIn(app, /(fetch\(|axios|baseURL|base_url|BASE_URL|API_URL|apiUrl|API_BASE|SERVER_URL|serverUrl|ENDPOINT|endpoint|WS_URL|new WebSocket\()[^\n]{0,80}https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+|[\w-]+\.ngrok(-free)?\.(io|app)|[\w-]+\.trycloudflare\.com)\b/)
      return hit && !/__DEV__|isDev|development/.test(hit.text) ? hit : null
    },
  },
  {
    id: 'both.ugc-safety', store: 'both', level: 'fix', area: 'content', title: 'People post for others to see, with no way to report or block',
    fix: 'Add report and block on posts and people, a filter for objectionable content, and a way to reach you (1.2).',
    source: `${APPLE_GUIDE}#1.2`,
    test: (app) => (has(app, 'ugc') && !findIn(app, /\breport\b/i) ? at('', 0, 'the app has posts by people; no "report" found') : null),
  },
  {
    id: 'both.ai-reporting', store: 'both', level: 'fix', area: 'content', title: 'AI answers with no way to flag a bad one',
    fix: "Let people report an offensive AI answer from inside the app, and keep a filter on what the model is asked and gives (Play's AI-generated content policy).",
    source: 'https://support.google.com/googleplay/android-developer/answer/13985936',
    test: (app) => ((has(app, 'ai') || uses(app, AI)) && !findIn(app, /\b(report|flag)\b/i) ? at('package.json', 0, AI.filter((a) => a in app.deps).join(', ') || 'AI feature') : null),
  },
  {
    id: 'both.unfinished', store: 'both', level: 'look', area: 'content', title: 'Words that say the app is unfinished',
    fix: 'Take out "coming soon", "beta", "lorem ipsum" and "TODO" from what people see; Apple rejects apps that look unfinished (2.1, 2.3).',
    source: `${APPLE_GUIDE}#2.1`,
    test: (app) => findIn(app, />[^<{]*\b(coming soon|lorem ipsum|placeholder text)\b[^<]*</i, { files: app.source.filter((f) => /\.(jsx|tsx)$/.test(f.file)) }),
  },
  // ── Security and network ──
  {
    id: 'android.cleartext', store: 'play', level: 'fix', area: 'security', title: 'Plain http traffic is allowed',
    fix: 'Remove android:usesCleartextTraffic="true"; if one address needs http, allow only it in a network security config.',
    source: 'https://developer.android.com/privacy-and-security/security-config',
    test: (app) => manifestHit(app, /android:usesCleartextTraffic="true"/),
  },
  {
    id: 'apple.ats-off', store: 'apple', level: 'look', area: 'security', title: 'App Transport Security is turned off',
    fix: 'Remove NSAllowsArbitraryLoads; allow only the addresses that need it, with a reason Apple accepts.',
    source: 'https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity',
    test: (app) => (app.plist.text && /<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(app.plist.text) ? at(app.plist.file, lineOf(app.plist.text, /NSAllowsArbitraryLoads/)) : null),
  },
  {
    id: 'android.backup', store: 'play', level: 'look', area: 'security', title: "The app's data goes into backups unfiltered",
    fix: 'Set android:allowBackup="false", or keep it with dataExtractionRules that leave out tokens and private data.',
    source: 'https://developer.android.com/identity/data/autobackup',
    test: (app) => (app.manifest && /android:allowBackup="true"/.test(app.manifest.text) && !/dataExtractionRules|fullBackupContent/.test(app.manifest.text) ? manifestHit(app, /android:allowBackup="true"/) : null),
  },
  {
    id: 'android.shrink', store: 'play', level: 'look', area: 'build', title: 'Release builds are not shrunk',
    fix: 'Turn on minifyEnabled and shrinkResources for release (in Expo: android.enableProguardInReleaseBuilds with expo-build-properties); a smaller app installs more often.',
    source: 'https://developer.android.com/build/shrink-code',
    test: (app) => {
      if (!app.gradle.text) return null
      const on = /minifyEnabled\s+true|isMinifyEnabled\s*=\s*true/.test(app.gradle.text) || /android\.enableMinifyInReleaseBuilds\s*=\s*true/.test(app.gradleProps || '')
        || /"(enableProguardInReleaseBuilds|enableMinifyInReleaseBuilds)"\s*:\s*true/.test(app.expo?.text || '')
      return on ? null : at(app.gradle.file, lineOf(app.gradle.text, /minifyEnabled/), 'off in release')
    },
  },
  {
    id: 'apple.encryption-answer', store: 'apple', level: 'look', area: 'build', title: 'The encryption question is not answered in the app',
    fix: 'Set ITSAppUsesNonExemptEncryption to false (in Expo: ios.config.usesNonExemptEncryption) when the app only uses HTTPS and the system\'s own encryption, so each upload does not wait on it.',
    source: 'https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations',
    test: (app) => (app.platforms.ios && !('ITSAppUsesNonExemptEncryption' in app.plist.keys) && !/usesNonExemptEncryption/.test(app.expo?.text || '') ? at(app.plist.file || app.expo?.file || '') : null),
  },
  {
    id: 'web.trackers-consent', store: 'web', level: 'look', area: 'privacy', title: 'A web page loads trackers before consent',
    fix: 'Load analytics and ad pixels only after the visitor agrees (EU and UK law), or use a cookieless analytics tool.',
    source: 'https://commission.europa.eu/resources-partners/europa-web-guide/design-content-and-development/privacy-security-and-legal-notices/cookies-and-similar-technologies_en',
    test: (app) => {
      const hit = findIn(app, /googletagmanager\.com\/gtag|connect\.facebook\.net|fbq\(|hotjar\.com|clarity\.ms/, { files: app.web })
      return hit && !findIn(app, /consent|cookie banner|cookieconsent/i, { files: app.web }) ? hit : null
    },
  },
  // ── Accessibility ──
  {
    id: 'access.font-scaling', store: 'both', level: 'look', area: 'access', title: 'Text does not grow with the phone\'s text size',
    fix: 'Remove allowFontScaling={false} (or cap it with maxFontSizeMultiplier) so people who need bigger text get it.',
    source: 'https://developer.apple.com/design/human-interface-guidelines/accessibility',
    test: (app) => findIn(app, /allowFontScaling=\{false\}/),
  },
  {
    id: 'access.unlabelled-buttons', store: 'both', level: 'look', area: 'access', title: 'Buttons a screen reader cannot name',
    fix: 'Give each icon-only button an accessibilityLabel and accessibilityRole="button", so VoiceOver and TalkBack say what it does.',
    source: 'https://developer.android.com/guide/topics/ui/accessibility/apps',
    test: (app) => {
      const files = app.source.filter((f) => /\.(jsx|tsx)$/.test(f.file))
      const all = files.reduce((n, f) => n + (f.text.match(/<(Pressable|TouchableOpacity|TouchableHighlight)\b/g) || []).length, 0)
      const named = files.reduce((n, f) => n + (f.text.match(/<(Pressable|TouchableOpacity|TouchableHighlight)\b[^>]*accessibilityLabel/g) || []).length, 0)
      return all >= 5 && named / all < 0.5 ? at(findIn(app, /<(Pressable|TouchableOpacity|TouchableHighlight)\b(?![^>]*accessibilityLabel)/, { files })?.file || '', 0, `${all - named} of ${all} buttons have no label`) : null
    },
  },
]

/** The rules that apply to a release to these stores (web rules always look at the web files). */
export const rulesFor = (stores) => RULES.filter((r) => r.store === 'both' || r.store === 'web' || (r.store === 'play' && stores.includes('play')) || (r.store === 'apple' && stores.includes('appstore')))
