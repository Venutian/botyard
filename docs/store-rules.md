# Store rules: what Apple and Google turn an app away for

Botyard scans every store release before it is uploaded, with its own rules (`studio/server/lib/store-scan/`). The
scan reads the app and never runs it: the code its entry imports (so build scripts, docs and a server beside the app
are not read as the app), its Android and iOS projects, and its Expo config, `app.config.js` included. In a monorepo
it finds the app in `apps/<name>`. It takes well under a second.

## Levels

| Level | Means |
|---|---|
| **stop** | Blocks the release and is never waived: a store refuses it outright, or it leaks a secret. |
| **fix** | Blocks the release. The crew may waive one it proves does not apply (see Waivers). |
| **look** | Does not block; listed on the release card. |

A failed scan sends the release back to the builder with each finding, its file and line, and its fix. Past its
rounds it goes to the ruler, never to the owner (see "One card" in [launch.md](launch.md)).

## The rules

| Rule | Store | Level | What it finds |
|---|---|---|---|
| `play.target-api` | Play | stop | Target API level is below Play's minimum |
| `play.target-api-unknown` | Play | look | Target API level could not be read |
| `android.debuggable` | Play | stop | The release build is debuggable |
| `android.exported-missing` | Play | fix | A component with an intent filter does not say android:exported |
| `android.fgs-type` | Play | fix | A foreground service has no type |
| `secret.in-app` | Both | stop | A secret key ships inside the app |
| `apple.purpose.camera` | App Store | stop | No purpose string for the camera |
| `apple.purpose.photolibrary` | App Store | stop | No purpose string for the photo library |
| `apple.purpose.microphone` | App Store | stop | No purpose string for the microphone |
| `apple.purpose.locationwheninuse` | App Store | stop | No purpose string for the location |
| `apple.purpose.contacts` | App Store | stop | No purpose string for the contacts |
| `apple.purpose.calendarsfullaccess` | App Store | stop | No purpose string for the calendar |
| `apple.purpose.bluetoothalways` | App Store | stop | No purpose string for Bluetooth |
| `apple.purpose.faceid` | App Store | stop | No purpose string for Face ID |
| `apple.purpose.motion` | App Store | stop | No purpose string for motion and fitness |
| `apple.purpose.healthshare` | App Store | stop | No purpose string for Health data |
| `apple.purpose.usertracking` | App Store | stop | No purpose string for tracking across apps (App Tracking Transparency) |
| `apple.purpose-vague` | App Store | fix | A purpose string does not say why |
| `apple.privacy-manifest` | App Store | fix | No privacy manifest |
| `apple.tracking-prompt` | App Store | fix | A tracking or ads package without the tracking prompt |
| `both.privacy-link` | Both | fix | The app has no link to its privacy policy |
| `both.account-deletion` | Both | fix | People can sign up but cannot delete their account in the app |
| `apple.login-option` | App Store | fix | Third-party sign-in without a private sign-in option |
| `kids.ads-or-tracking` | Both | fix | An app for children carries ads or tracking packages |
| `play.restricted.query_all_packages` | Play | fix | Restricted permission: see every installed app |
| `play.restricted.read_sms` | Play | fix | Restricted permission: read text messages |
| `play.restricted.send_sms` | Play | fix | Restricted permission: send text messages |
| `play.restricted.receive_sms` | Play | fix | Restricted permission: receive text messages |
| `play.restricted.read_call_log` | Play | fix | Restricted permission: read the call log |
| `play.restricted.manage_external_storage` | Play | fix | Restricted permission: read and write all files |
| `play.restricted.request_install_packages` | Play | fix | Restricted permission: install other apps |
| `play.restricted.access_background_location` | Play | fix | Restricted permission: track location in the background |
| `play.restricted.use_exact_alarm` | Play | fix | Restricted permission: set exact alarms (only for alarm and calendar apps) |
| `play.restricted.read_media_images` | Play | fix | Restricted permission: read all photos (a photo picker needs no permission) |
| `play.restricted.read_media_video` | Play | fix | Restricted permission: read all videos (a photo picker needs no permission) |
| `android.overlay` | Play | look | Draws over other apps (SYSTEM_ALERT_WINDOW) |
| `both.payment-link` | Both | fix | A payment link outside the store |
| `both.restore-purchases` | Both | fix | In-app purchases without "Restore purchases" |
| `both.server-address` | Both | fix | The app talks to a computer the reviewer cannot reach |
| `both.ugc-safety` | Both | fix | People post for others to see, with no way to report or block |
| `both.ai-reporting` | Both | fix | AI answers with no way to flag a bad one |
| `both.unfinished` | Both | look | Words that say the app is unfinished |
| `android.cleartext` | Play | fix | Plain http traffic is allowed |
| `apple.ats-off` | App Store | look | App Transport Security is turned off |
| `android.backup` | Play | look | The app's data goes into backups unfiltered |
| `android.shrink` | Play | look | Release builds are not shrunk |
| `apple.encryption-answer` | App Store | look | The encryption question is not answered in the app |
| `web.trackers-consent` | Web | look | A web page loads trackers before consent |
| `access.font-scaling` | Both | look | Text does not grow with the phone's text size |
| `access.unlabelled-buttons` | Both | look | Buttons a screen reader cannot name |

Each rule names the store's own page for it, in `rules.mjs`. Play's lowest target level follows the date
(`PLAY_TARGET`): 35 from 31 August 2025, 36 from 31 August 2026.

The scan also holds the store listing to each store's words (`checkListingWords` in `release-checks.mjs`): Play titles
and short descriptions claim no rank or price, carry no emoji and are not in capitals; neither store's text names the
other platform; App Store names and subtitles are not keyword lists, and keywords leave out the name's words and
repeat none.

## Waivers

The crew may waive a **fix** it has proven does not apply, in the app's `store/waivers.json`:

```json
[{ "rule": "android.cleartext", "file": "android/app/src/main/AndroidManifest.xml",
   "why": "the app talks to the owner's own PC on the home network", "proof": "the only http address is the paired PC",
   "by": "Reviewer", "until": "2027-03-31" }]
```

A waiver covers one rule at one file, needs its why, proof, who and an end date within 180 days, and is listed on
the owner's card. A **stop** is never waived; a waiver for one is refused and said.

## What only the owner states and does

Some duties only a person can state. They apply by the countries the app ships to (the product's `regions` in the
launch plan; US, GB, DE and SE when none are named) and what it does (its `features`: `accounts`, `personal_data`,
`kids`, `ugc`, `ai`, `commerce`, `subscriptions`), from the day each applies (`owner.mjs`):

| Statement | Where | For apps that | From |
|---|---|---|---|
| The privacy policy is true and live | everywhere | all | 2018-05-25 |
| Personal data is handled as the GDPR asks | EU | personal_data, accounts | 2018-05-25 |
| Trader status is set for the EU | EU | all | 2025-02-17 |
| Security holes are reported in time (Cyber Resilience Act) | EU | all | 2026-09-11 |
| People know when they deal with AI (AI Act, Article 50) | EU | ai | 2026-08-02 |
| Shopping, banking, booking and e-book parts are accessible (European Accessibility Act) | EU | commerce, banking, booking, ebooks | 2025-06-28 |
| Children's data is handled as COPPA asks | US | kids | 2025-06-23 |
| The app reads the phone's age signal where California asks (Digital Age Assurance Act) | US | all | 2027-01-01 |

The release card lists the ones not stated yet; the owner's yes states them, and they are kept per app in the yard
(`config/store-statements.json`) for a year, or until a statement's revision changes. The card also lists the
store-console forms only the owner can fill (Data safety, privacy, content and age rating, target audience and ads,
agreements, developer identity), which the yes confirms are done, and what is coming in the next 120 days.

## Running it

```sh
node studio/tools/store-scan.mjs <app folder> --stores play,appstore --regions SE,DE,US --features accounts,ai
node studio/tools/store-scan.mjs --plan          # every product in the launch plan, one verdict for all
```

Exit 0 when nothing blocks, 2 when something does, 1 when it could not scan; `--json` for data. The crew's
`store-rules` skill teaches builders the same rules while they build, so a release passes the first time.

## Kept current

Once a week (`store-rules-watch` on the timetable, Mondays 07:00) the lead is asked to read Apple's, Google's and the
EU's own change pages and land any change to the rules, statements and dates, each with its official page, through
the usual build and check. Nothing is added that an official page does not say.
