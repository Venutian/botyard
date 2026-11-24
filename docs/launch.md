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

**Always the owner's yes, on a card that names the product, version, channel and what will happen:** a store
release (one card for the whole of it: sending for review, Apple's release once approved, Play's staged rollout and
its raises; see "One card" below); publishing a GitHub release; making a web money
product live; setting the default Steam branch; making an itch page public; any price, payout, purchase or
spend; accepting terms. A "yes" is logged with who and when.

**Only the owner can do, so the page says so plainly and links to the right console page:** adding each store's
key once on its key row; creating the first app record where a store has no API for it; content rating,
privacy and data-safety forms; tax and bank details; agreements. Bots never type a key.

Safe defaults: uploads go to testing lanes; nothing goes to review or live without the release card's yes. After
that yes, Apple releases the version by itself once approved, phased over seven days, and Play's rollout is raised
step by step while crashes stay under Google's line. Going live is never a default; it is what the one yes asks for.

## One card

A store release asks the owner once. Every step before the card either passes or is fixed by the crew: a failure
goes back to the step that makes the change with its findings, and past its rounds to the ruler (the `ruler` input,
else the crew's lead), who decides in the owner's place. Only the ruler's ASK OWNER (a spend, a sign-in, a key, a
form only a person may fill) puts a second question to the owner. The card shows the store-rules result, the store
checks and what is on the testing lanes, and says everything its yes does:

- the listing goes onto each store and the release is sent for review;
- the App Store version is set to go live by itself once approved, as a phased release over seven days;
- Play's production release starts at 20% and is raised to 50% after a day and to everyone after three days, while
  the user-perceived crash rate stays under 1.09% and the ANR rate under 0.47% (Google's bad-behaviour lines);
  above a line the rollout halts by itself and the release goes to the ruler;
- it states what the store-rules register asks the owner to state, and confirms the console steps only the owner
  can fill (data safety, privacy and age-rating answers, agreements). The statements are kept per app in
  `config/store-attestations.json` and are not asked again until a rule changes or a year passes.

## Store rules

Before the store checks, the release is scanned against what Apple and Google reject, with the
[App Store Compliance Playbook](https://github.com/mjmirza/app-store-compliance)'s guard and fleet sweep
(`studio/server/lib/store-rules.mjs`). The playbook is not part of Botyard and is not copied into it: its licence is
the OpenRoots Agent License 2.3 (free for individuals, nonprofits and companies under USD 20 million a year in
revenue; AI training needs a separate licence), not Botyard's. Each yard fetches it once into
`~/.botyard/tools/app-store-compliance` at one pinned commit (`RULES_PIN`), and refuses any other commit; a new pin is a
Botyard change, reviewed like any other.

- The scan reads a copy of the built app without dependencies, build output, other worktrees or built packages.
- A **critical** or **high** finding blocks: the release goes back to the builder with each finding, its file and its
  fix. A scan that did not see the whole app blocks too.
- The crew may waive a **high** finding it has proven false, in the app's `store/waivers.json` (the playbook's waiver
  form: finding id, severity and file as printed, a reason, evidence, a reviewer and an expiry within 180 days). A
  **critical** finding is fixed, never waived. Waivers are listed on the owner's card.
- **Medium** findings are listed to look at; they do not block.
- The countries come from the product's `regions` in the plan (US, GB, DE and SE when none are named), and what the
  app does that laws name from its `features` (`personal_data`, `subscriptions`, `kids`, ...).

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

1. **Build** (script): the product's build command; leaves the artifact and its version and build number.
2. **Tests** (script): the product's test command.
3. **Readiness** (script): the checklist above; a fail goes back to the crew with what failed.
4. **Upload to testing** (script): the store's testing lane; leaves the store's build id.
5. **Wait for processing** (script): until the store has the build, or a time limit.
6. **Store rules** (script): the scan above; a block goes back to the builder.
7. **The owner's one card** (gate): the store-rules result, the store checks, what is on the testing lanes, and
   everything the yes does (see "One card").
8. **Send for review** (script): the listing onto each store; Apple's version set to release itself once approved.
9. **Watch the review** (script): reads the state until approved or rejected; a rejection goes back to the
   crew with the store's words.
10. **Go live** (script): Play's rollout raised step by step while the crash and ANR rates hold, halted by itself
    when they do not; Apple's phased release runs by itself.

Web products and Botyard's own GitHub releases use a short form: build, tests, preview or draft, the owner's
gate, publish, check the live version.

## Starting a release

**Prepare release** on a product's row (page and phone) starts one trip on `release-app` for that product, with its
package and bundle id from the plan. The plan's `release.inputs` name the studio's own bots: `builder`, `writer`
(the listing), `artist` (the store images), `reviewer` (who scores them) and `ruler` (who decides a failure past its
rounds; the crew's lead when the plan names none). A product's `regions` and `features` go to the store-rules scan. One release runs at a time per product;
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
