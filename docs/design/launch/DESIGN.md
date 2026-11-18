# Launch: the design

The Launch page, designed again for the owner's three points (18 Nov 2026): the sideways scroll with free width
on the screen, grey on grey with nothing pointing at what waits for the owner, and the noise (a time in every
cell, a dash for every channel a product is not on, the next step crammed under the name).

Everything here uses the demo yard's made-up studio (Lighthouse Labs) and its products. `Lantern Run` is a
made-up browser game added to the demo's launch plan only, so the board shows all eight channels the way a full
studio's board does (`demo-data.mjs`).

## Files

| File | What it is |
|---|---|
| `before/before-{1920,1440,390}-{day,night}.png` | Today's page in the demo, with the demo data below |
| `mock/direction-a-yours-first.html` | **Chosen.** Steps that wait for you first, then the board across the whole deck |
| `mock/direction-b-product-lines.html` | Direction B: one line per product, only its own channels, next step on the right |
| `mock/direction-c-release-line.html` | Direction C: columns are the steps of a release; each channel sits where it has got to |
| `mock/base.css`, `mock/glyphs.js`, `mock/data.js` | Shared: Botyard's fonts and plate tokens, the state marks, the made-up data |
| `renders/direction-*-{1920,1440,390}-{day,night}.png` | Every direction at each size and theme; `-390-*-full.png` is the whole phone page |
| `renders/chosen-state-{checking,clear,empty,focus}-*.png` | The chosen direction's other states |
| `render.mjs` | Renders all of it headless and prints the sideways overflow of each picture |
| `demo-data.mjs` | Writes the made-up launch plan and state the before shots used |

Rerun: `node docs/design/launch/render.mjs` (mock-ups) and `node docs/design/launch/render.mjs before URL` (a
running demo started with the two `BOTYARD_LAUNCH_*` variables `demo-data.mjs` names). Needs `npm install` in
`studio/` once, for the fonts.

Measured: today's page scrolls sideways by 14px at 1920 and at 1440 (`grid-wrap`), because the sheet stops at
about 1040px over a 1920 screen. All three directions: 0 sideways overflow at 1920, 1440 and 390, both themes.

## The three directions, and the pick

**A. Yours first, then the board (chosen).** A yellow block at the top lists every step that waits for the
owner, one line each (product, channel, the step, one button), grouped by product. Under it the board: products
by channels across the whole deck, one state per cell, blank where a product is not on a channel.

**B. One line per product.** Each product a plate with only its own channels and its next step on the right; a
product that waits for you is painted and sorts first. Rejected: with three of five products waiting, half the
page is yellow and yellow stops meaning anything; it shows only the first step per product ("and 2 more on its
page"); the plates stacked are the card stack the bar lists as slop; and rows reorder whenever a step is done,
so nothing stays where the eye left it.

**C. The release line.** Columns are steps (not read yet, your yes, in review, live, down), each channel a tag
in its step, with "your yes" one yellow lane down the board. The most distinctive, and calm. Rejected: the
server sends no step per cell, so a builder would have to invent one from free-text states (guessing, which the
page must never do); and owner steps that are not a yes (add a key, say where it stands) land in "not read yet",
outside the yellow lane, so the lane under-counts what waits for you.

**Why A.** It answers the owner's first question (what do I have to do) completely, in one place, with the
button for each, and the second (where does each product stand) on a board that keeps every product and channel
in the same place every visit. It needs no new data: every cell the server sends already has `waits` and
`next`. It is the category's own shape (Vercel's and Railway's lists of what needs action over a status grid),
in Botyard's plates. It is not a restyle of today's page: today's page has no action list, puts the next step
inside the product cell, times in every cell, dashes, and a capped sheet; A changes the structure, the width,
the cells and the colour logic.

## Layout

The page is one sheet with a head and a scrolling body.

- **Head** (one line): `Launch` (sign face), then "Read from each channel 4 minutes ago" (the only time on the
  board), then `Check now` and close at the right. Under 700px the read line wraps to its own line.
- **Yours block**, when anything waits for the owner. A yellow band (`--go`) with "6 steps wait for you" in the
  sign face, then one row per step, in board order (product, then channel order). Columns at 700px and up:
  product 200px, channel 150px, step `1fr`, button auto (min 168px). A product's name shows on its first step
  only; its later steps hang under it with a dashed rule, a new product starts with a solid one. Under 700px
  each step is a stack: channel, product (first step only), the step, the button (44px tall).
- **Nothing waits**: the yellow block is replaced by one quiet plate: "**Nothing waits for you.** The crew and
  the stores have the next steps." (`chosen-state-clear-*`).
- **Board**: heading "Every product", one line "A blank cell: the product is not on that channel." (hidden on a
  phone, where there are no blank cells) and the key of marks at the right. Then the table, `table-layout:
  fixed`, `width: 100%`: product column 230px, each channel column an equal share of the rest. Channels shown
  are only those at least one product uses (as today).
  - Product cell: name (sign face 22px), kind (13px muted), then either "N steps wait for you" with the yellow
    mark, or "Waits for the crew: <step>" / "Waits for the store: <step>". Nothing when nothing waits.
  - Channel cell: the mark, then the state in plain 14px. One quiet second line only when it says something
    the state does not: "Told 9 days ago" (amber when older than a week), "For 3 hours" (down), the cell's
    `detail` ("Published now: v0.8.2"). Never "read, <time>".
  - A channel the product is not on: an empty cell. No dash, no label.
  - Rows stay in plan order. The whole row opens the product's page (as today).
- **Phone (under 700px)**: no table. Each product is a plate: name, kind, what waits, then one line per channel
  it is on (channel name 112px, then mark and state). Empty channels are not drawn.

### The sheet's width rule

Launch is a wide page: its sheet fills the deck from the rail's right edge to the window's right edge (in the
mock: `left: 104px; right: 14px`, i.e. the rail's 14px + 76px + 14px gap, and the 14px screen gutter), with no
maximum width. Inside, the body has 24px side padding. The board's columns share whatever is left, so 1440 gives
8 channels about 130px each and 1920 about 190px; nothing scrolls sideways at 1440 or wider (measured).
If a chat is open beside it, the deck's right edge moves left as it does today and the table shares the rest.
In the studio: the Launch column (`deck-col.col-a.page.wide`) gets `flex: 1 1 auto` and no `flex-basis` cap.
The table's wrapper loses its sideways scroll; a test holds the overflow at 0 instead (below).

Under 700px the sheet is the whole screen under the top sign (`top: 52px; left: 0; right: 0; bottom: 0`, no
border or radius); the rail is hidden while it is open and the close button returns to it.

## Type

Botyard's own two faces, self-hosted from `@fontsource` as today; no new font.

| Use | Face | Size / line | Weight |
|---|---|---|---|
| Page title `Launch` | Big Shoulders Display | 32px / 1 (28px on a phone) | 800 |
| Block headings ("6 steps wait for you", "Every product") | Big Shoulders Display | 21px / 1 | 800 |
| Product name on the board | Big Shoulders Display | 22px / 1 | 800 |
| Step text, product in the yours block | IBM Plex Sans | 15px / 1.45 | 400 / 600 |
| Cell state | IBM Plex Sans | 14px / 1.35 | 400 (600 when down) |
| Column heads, channel in the yours block, kind, second lines, key | IBM Plex Sans | 13px / 1.2-1.4 | 400 / 600 heads |
| Buttons | IBM Plex Sans | 13px / 1 | 600 |

No capitals as labels, no tracking beyond the sign face's own 0.01-0.02em.

## Colour

All from `plates.css`; three tokens are new, and one existing night token is used in a new place.

| Token | Day | Night | Why |
|---|---|---|---|
| `--yours` (new) | `#fff4cc` | `#2e2810` | The ground of a step that waits for the owner: yellow paint thinned, so a block of six rows is loud without shouting |
| `--yours-line` (new) | `#e0a800` | `#ffc61a` | The rules between those rows (mixed 45% into the ground) |
| `--yours-ink` (new) | `#15181d` | `#fff3c4` | Text on `--yours`; its quiet text is `--yours-ink` 72% into `--yours`, tinted from it, never grey |
| `--field-edge` (night, exists) | | `#768090` | The edge of a button on the night yellow ground, where the near-black plate edge disappears |

Yellow (`--go`, `--yellow-paint`) means one thing on this page: it waits for the owner. Green paint is live,
red is down, blue is unused here (kept for a rollout in progress: the half-filled mark). Hazard stripes stay on
Needs you only.

Contrast, measured (WCAG ratio), worst pairs:

| Pair | Day | Night |
|---|---|---|
| Body text on the sheet | 15.6 | 14.8 |
| Muted text (kind, second lines, column heads) on the sheet | 7.5 | 8.3 |
| Down text (`--red`) on the sheet / on a phone plate | 5.2 / 5.9 | 6.4 / 5.5 |
| Told-old text (`--amber`) on the sheet | 5.3 | 10.4 |
| Step text on `--yours` | 16.2 | 13.2 |
| Quiet text on `--yours` (channel names) | 6.7 | 7.6 |
| Heading ink on the yellow band | 11.3 | 11.3 |
| Focus ring (`--accent`) on the sheet (3:1 needed) | 6.7 | 7.8 |
| Button edge on `--yours` (3:1 needed) | 16.2 | 3.7 (with `--field-edge`) |
| Not-read mark (`--dim`) on the sheet (3:1 needed) | 4.4 | 6.3 |

## States

| State | Mark (shape, so never colour alone) | Cell text | Where else |
|---|---|---|---|
| Live (`tone ok`, read) | filled green circle, dark edge | "Live 2.0.3" | |
| Moving (`tone go`: testing, rolling out) | blue circle, half filled | "Rolling out 2.1.0 to 20%" | |
| Waits for your yes (`tone look`, read) | yellow hex nut (Botyard's mark), dark edge | "Production draft 2.1.0 (41)" | a row in the yours block |
| Down or failed (`tone bad`) | red triangle, dark edge | red 600 "Down: answers 502", then "For 3 hours" | the product cell names who it waits for |
| Not set up / not known / not told (`how none`) | grey dashed ring | muted: "Not set up", "Not known: no App Store key" | a row in the yours block when it waits for the owner |
| Told by a person (`how told`) | the mark of its tone | the state, then "Told 9 days ago" (amber past a week) | "Say again" in the yours block when old |
| Checking (after Check now) | | cells keep their last values at full strength | the head says "Reading each channel: 5 of 12 read", `Check now` is disabled as "Checking", the bar fills |
| No plan | | | the empty state below |

The yours block's button, by what the step is (all already in the cell's `waits`/`next`):
a yes at a gate (`tone look`, read) "Open the card" (opens the gate's card); a missing store key "Add the key"
(opens its row in Connectors); a missing id "Add the id" and a channel that cannot be read "Say where it
stands" (both open the product page's tell form at that channel); a told state older than a week "Say again".
The words come from a small table in the client keyed on these cases, not from the server's sentence.

**Empty** (no plan): the head without the read line and with `Check now` disabled; in the body, centred to 62
characters: "No launch plan yet" (sign face 26px), one paragraph on what the plan is, its path in a code chip,
and one button, "How to write the plan", which opens `docs/launch.md` (`chosen-state-empty-*`).

## Focus, hover, press

- Every button: the plates' key (2px edge, 2px drop, presses down 2px on `:active`); hover `--sunk`; in the
  yours block hover fills it yellow (`--go`, `--go-ink`), so the pointer's target joins the block's colour.
  Disabled: 55% and no drop.
- A board row is one focus stop (`tabindex=0`, Enter or Space opens the product, as today); focus is a 3px
  `--accent` ring inset on the row, instant. Hover: the row takes `--raise` at 70%.
- Order: Check now, close, the yours buttons top to bottom, then the board rows.
- Selection, caret and scrollbar are the plates' own (`::selection` yellow, thin `--line-strong` scrollbar).

## Motion

One: while a check runs, a 3px `--accent` bar along the foot of the head fills left to right as channels are
read (`transform: scaleX(read / total)`, 0.4s ease-out per step). Under `prefers-reduced-motion` it jumps to
each value with no transition. The sheet's own slide-in stays as the studio has it. Nothing else moves.

## What the builder must know

1. Data: no server change. The yours block is every cell with `waits === 'owner'`, in plan then channel order;
   the product cell's "waits for the crew/store" line is the first cell whose `waits` is `crew` or `store`.
   `checkedAt` per cell is no longer shown; the head shows the board's `checkedAt` once. A "For 3 hours" line
   needs the time the state began: take it from the newest `history` entry for that cell.
2. The progress count for the checking bar needs the server to say how many cells it has read; until it does,
   show "Reading each channel" with the bar at 0 and no count (never a made-up fraction).
3. Words on the page: as in the mock-up; buttons say what they open.
4. Tests to add: no sideways overflow of the sheet body at 1440 and 1920 with eight channels (render.mjs's
   check), the yours block's count equals the cells with `waits === 'owner'`, and an unused channel's cell is
   empty.

## Not done here

- The product page (opened from a row) keeps today's design; it was not part of this brief.
- The shell in the mock-ups (top sign, rail, map) is a plain stand-in drawn only to show the sheet's place.
- Nothing is scored here: Karen scores the built page.
