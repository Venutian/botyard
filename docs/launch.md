# Launch: getting each product from built to live, and knowing where it stands

Botyard's **Launch** page answers two questions for every product: where is it on each store or channel right
now, and what is the next step, and who does it wait on. Releasing is a [track](tracks.md) like any other
work, with the owner's yes at a gate before anything goes to review, goes live or costs money.

## Words

| Word | Means |
|---|---|
| **channel** | One place a product is released: Google Play, the App Store, a web address, a Steam branch, an itch.io channel, a game portal, a GitHub release. |
| **plan** | Which channels a product has, with its ids there (package name, bundle id, app id, address, repository). One file, written once per product. |
| **cell** | One product on one channel: a state, a version, when it was read, how it was read, the next step and who it waits on. |
| **check** | A small script that reads one cell's true state. Checks run on a timer and on the owner's "Check now". |
| **readiness** | A product's checklist for its next release: listing, build, signing, payments, monitoring, legal. |
| **release** | One trip along a release track for one product and version. |

## What the page shows

- **The board.** One row per product, one column per channel. Each cell shows one plain state ("Internal
  testing 2.0.1 (17)", "In review", "Live 2.0.0", "Halted at 20%", "Draft waits for you"), the time it was
  read, and a mark that says how it was known: **read** (from the store's own API or the live thing),
  **told** (typed by a person, with its age; it turns amber when old) or **not known** (no key, or no API).
  A cell never shows green for something that was not read.
- **Next step, and who it waits on.** The owner (a key to add, a yes to give, a form only a person may fill),
  the crew (a build, a fix), or the store (processing, review). One line per product on the board.
- **Readiness.** Per product, a checklist with pass, fail, not known and "yours" (only the owner can do it),
  grouped as below.
- **History.** Every change of a cell's state and every release step, with its time: built, uploaded,
  processed, sent for review, approved, released, halted, rolled back. "Nothing has moved for N hours"
  becomes a line under Needs you.
- **Drift.** The version the crew last released against what each channel holds now, in plain words
  ("Play is one version behind").

## How each channel is read

| Channel | Read by | States it can show | Not readable (told by a person, or inferred and marked so) |
|---|---|---|---|
| Google Play | The store's publishing API with a service-account key: every track's releases, version codes, status and rollout share. An edit is opened only to read and is always discarded. | Not in the console, internal, closed or open testing, production draft, rolling out at N%, halted, complete. | Google's review: not exposed. "Probably in review" is shown as a guess after a production commit, with a one-tap "I see it live" for the owner. |
| App Store | The store's API with a team key (issuer, key id, private key; a short-lived token is made per read). | No record, build processing, build ready, in TestFlight, waiting for review, in review, rejected, pending release, phased release day N of 7, live. | Creating the first app record and accepting agreements (the owner, in the console). |
| Web | A request to the live address, and a version marker the build writes (`/version.json` or a meta tag). | Live with version, down, behind. | none |
| GitHub release | The repository's releases. | No release, draft waiting, published (with tag and assets). | none |
| itch.io | The public latest-build endpoint per channel, no key. | Latest version per channel, none. | Whether the page is public. |
| Steam | The publisher API with a publisher key: builds and branches. | Build on each branch, which build is live on the default branch. | Store page and build review, "coming soon", wishlists: told by the owner. |
| Game portals | No API. | Told: submitted, in QA, basic launch (day N, plays so far from our own counts), full launch. | All of it. The page keeps the portal's submission kit ready instead. |

## What Botyard automates, and what always waits for the owner

**Automated, with no question:** builds; tests; reading every store; uploads to a store's own testing lane
(Play internal testing as a draft release, TestFlight to the internal group); a web preview; a GitHub draft
release with its files; a push to a non-default Steam branch or an itch channel that is not public; dry runs
that validate a store edit without committing it.

**Always the owner's yes, on a card that names the product, version, channel and what will happen:** sending
for review; releasing to production or raising a rollout; publishing a GitHub release; making a web money
product live; setting the default Steam branch; making an itch page public; any price, payout, purchase or
spend; accepting terms. A "yes" is logged with who and when.

**Only the owner can do, so the page says so plainly and links to the right console page:** adding each store's
key once on its key row; creating the first app record where a store has no API for it; content rating,
privacy and data-safety forms; tax and bank details; agreements. Bots never type a key.

Safe defaults: uploads go to testing lanes; Play releases start as drafts; App Store releases are manual with
phased release on. Going live is never a default.

## Readiness checklist

- **Listing:** name, short and full descriptions, screenshots and icon at the store's sizes, release notes,
  support and marketing addresses answering, category set.
- **Build:** uploaded and processed; version and build number higher than the last release; target SDK at
  the store's minimum; the test phone's smoke test passed; the store's own validation passes.
- **Signing:** store keys work (the check button lists what each key may do); upload key and certificates
  present and not near expiry; export compliance answered.
- **Payments (test mode only):** every product in the app exists in the store and maps to an entitlement; a
  test purchase seen; for web payments, products and prices exist, the webhook answers, a test checkout passed,
  and no secret key ships in the build. Going live with payments is the owner's card.
- **Monitoring:** crash reporting and analytics keys in the build; the release name matches; after a rollout,
  crash-free sessions at or above the target and events arriving from the new version. A halt plan exists.
- **Legal:** privacy policy live and linked from the listing and the app; account deletion path when the app
  has accounts; subscription terms on the paywall; licences and rights for made assets.

## The release track

A built-in track, `release-app`, per product and version:

1. **Build** (bot, the `builder`): builds the app's next release for the stores in the plan (Play when
   it has a package, the App Store when it has a bundle id), raises the version and build number above
   what each store holds, and commits the raise on the job's branch. Leaves the AAB and the numbers.
2. **Write the listing** (bot, the `writer`): the store listing as JSON, within each store's limits.
3. **Make the store images** (bot, the `artist`): screenshots from the real app on the test phone, at
   each store's sizes.
4. **Score them** (bot, the `reviewer`, or the `writer` when there is no reviewer): the listing and
   images against the store kit bar.
5. **Check what a store would refuse** (script): the listing fields and limits, image sizes, the
   privacy and support pages, the bundle and its version code against Play, and the store products for
   an app that takes payments.
6. **Upload to testing** (script): Play internal testing as a draft release, TestFlight to the internal
   group.
7. **The owner decides** (gate): the release is built, its listing and images are scored, the checks
   pass and it is on the stores' testing lanes. Yes sends it for review: the listing goes onto each
   store, Play gets a staged rollout, the App Store version goes to Apple.
8. **Send for review** (script): the listing onto each store, a staged Play rollout, the App Store
   version to Apple.
9. **Watch the review** (script): reads the state until approved or rejected; a rejection goes back to
   the crew with the store's words.

On a fail the track goes back with what failed: the score to the listing (two rounds), the readiness
check or the watch to the build (with its rounds); a failed build goes back to the build once, and then
to the owner.

Web products and Botyard's own GitHub releases use a short form: build, tests, preview or draft, the owner's
gate, publish, check the live version.

## Starting a release

**Prepare release** on a product's row (page and phone) starts one trip on `release-app` for that product, with its
package and bundle id from the plan. The plan's `release.inputs` name the studio's own bots: `builder`, `writer`
(the listing), `artist` (the store images) and `reviewer` (who scores them). One release runs at a time per product;
the board follows it to its trip and says when it waits for the owner.

The checks before any upload (`studio/server/lib/release-checks.mjs`): every listing field present and within each
store's limits, no placeholder text; Play icon 512 x 512, feature graphic 1024 x 500, 2 to 8 phone screenshots; at
least 3 App Store iPhone screenshots at a size Apple takes; privacy and support pages answering; the bundle built and
its version code above what Play holds; for an app that takes payments through a store, products in that store. What
only the owner can do (a test purchase with a tester account, the content rating, data safety and privacy forms) is
listed as theirs, never failed.

## Where the files are

- The plan: `launch-plan.json` in Botyard's data folder (`~/.botyard/`), one entry per product; a studio may
  keep its own copy elsewhere and link it there.
- What the checks read: `launch-state.json` in the same folder, with the history beside it.
- Keys: the key rows Botyard already has for each store; checks and release steps read them, bots do not.

## Left out on purpose

Prices, payouts and store agreements are never automated. Steam's and the portals' review states are told,
not guessed. The page does not depend on any build service to report store state: it reads the stores.
