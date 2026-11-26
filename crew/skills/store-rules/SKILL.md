---
name: store-rules
description: What Apple's App Store and Google Play turn an app away for, and how to build so a release passes the first time - permissions and purpose strings, privacy files, account deletion, payments, children, user posts and AI answers, target levels, secrets, listing words, accessibility. Use when building or changing a mobile app that ships to a store, before asking for a release, and when a release's store-rules scan sent work back to you.
---

# Building so the stores say yes

Every release on Botyard's Launch page is scanned against the store rules before it is uploaded, and again in any
round after a fix. A **STOP** or a **FIX** sends the release back to the builder with each finding, its file and its
fix. Build so the scan finds nothing: it is cheaper than a round, and far cheaper than a store's rejection.

## Run the scan yourself

```sh
bash <this skill's folder>/scripts/store-scan.sh <app folder> --stores play,appstore --regions SE,DE,US --features accounts,ai
```

`--stores` is where it ships; `--regions` the countries; `--features` what the app does that rules and laws name:
`accounts`, `personal_data`, `kids`, `ugc` (people post for others), `ai`, `commerce`, `subscriptions`. It reads the
app (the code its entry imports, its native projects, its Expo config, including `app.config.js`), never runs it, and
exits 0 when nothing blocks. `--json` gives the findings as data. A monorepo is fine: it finds `apps/<name>`.

## While you build

- **Every protected thing iOS touches needs its purpose string** (camera, photos, microphone, location, contacts,
  calendar, Bluetooth, Face ID, motion, Health, tracking). Write what the person gets: "Scan a receipt to add it to
  your expenses". Never "This app needs camera access", never "Not used." (remove the key and the package instead).
- **iOS privacy file:** keep `ios.privacyManifests` (Expo) or `PrivacyInfo.xcprivacy` with the required-reason APIs
  and the data collected. React Native itself uses UserDefaults and file timestamps.
- **Tracking or ads** need App Tracking Transparency before any tracking, and the store privacy answers to match.
- **Accounts:** if people can sign up, they can delete the account and its data in the app, not only sign out.
  Google or Facebook sign-in on iOS needs Sign in with Apple beside it.
- **Payments:** digital goods, tips and unlocks go through the store's own billing. A Stripe, PayPal, Ko-fi or Patreon
  link in the app is only for physical goods and services. In-app purchases need "Restore purchases".
- **Children:** an app for children carries no third-party ads or analytics.
- **People post for others:** report and block on posts and people, and a filter.
- **AI answers:** people can report a bad answer in the app; say plainly that they are talking to an AI.
- **Android:** target the level Play asks for now (36 since 31 August 2026); give each foreground service its type;
  say `android:exported` on every component with an intent filter; avoid restricted permissions (all files, SMS,
  call log, every installed app, install apps, background location, exact alarms, all photos and videos) unless the
  app cannot work without one, and then expect a declaration with a video.
- **Never ship a secret** (a live payment key, a private key, a cloud service account) inside the app; it goes on a
  server the app calls.
- **Release builds** talk to the live server: localhost, 10.0.2.2 and tunnels only behind `__DEV__`.
- **A link to the privacy policy** where people find it in the app.
- **Nothing unfinished on screen:** no "coming soon", "lorem ipsum", "beta".
- **Accessibility:** a label and role on icon-only buttons; text that grows with the phone's size (no
  `allowFontScaling={false}`).

## Store listing words

Play titles and short descriptions claim no rank or price ("best", "#1", "top", "free", "sale", "new"), carry no
emoji and are not in capitals. Neither store's text names the other platform. App Store names and subtitles read as
names, not keyword lists; keywords leave out words already in the name and say each word once.

## When the scan sent work back

Fix each finding in the app and say in your report which file changed. For a **FIX** you can prove does not apply
(a payment link that sells a physical thing, plain http to a computer on the owner's own network), add a waiver to
the app's `store/waivers.json`:

```json
[{ "rule": "android.cleartext", "file": "android/app/src/main/AndroidManifest.xml",
   "why": "the app talks to the owner's own PC on the home network", "proof": "the only http address is the paired PC, set at pairing",
   "by": "<your name>", "until": "<a date within 180 days>" }]
```

A waiver covers one rule at one file, needs its proof, and ends on its date. A **STOP** is fixed, never waived. The
rule ids and what each checks are in Botyard's `docs/store-rules.md`.

## What is never yours

The owner states the legal points and fills the store-console forms (privacy and Data safety answers, content and
age rating, agreements, trader status) on the release's one card. Draft the answers in your report when the app
changed what it collects; never sign in to a store console or fill a form there.
