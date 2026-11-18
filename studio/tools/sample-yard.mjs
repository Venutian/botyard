#!/usr/bin/env node
/**
 * A made-up yard, for seeing Botyard at work without signing in to anything.
 *
 *   node tools/sample-yard.mjs <home folder>     fill an empty home folder and stop
 *
 * `npm run demo` uses the same filler on a throwaway home and then starts Botyard on it.
 *
 * Everything is written through the engine's own API, the way an owner, a bot and the crew's
 * helpers write it: a studio called Lighthouse Labs, four projects, a crew of eight with different
 * roles, AIs and looks, and a day and a half of work in every state the map can show (building,
 * waiting for its check, being ruled on, blocked, fixed, merged, cancelled), with comments,
 * reports, a plan in three versions, questions waiting for the owner, two routines and a
 * conversation with the lead. Three things have no API because only the engine itself ever writes
 * them, and are put straight into the store: finished runs with their tokens and logs, a job's
 * moment in time (so the work looks a day old, not a second), and the merge log a helper keeps.
 *
 * No AI is called and no bot is started. Every name here is made up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIN = 60_000
const HOUR = 60 * MIN

export const STUDIO = { name: 'Lighthouse Labs', prefix: 'LH' }

/** The four projects, each a small folder of its own inside the home. */
export const PROJECTS = [
  { key: 'shop', name: 'Harbour Shop', about: 'A web shop for a small chandlery. GOAL: checkout on one page, and an order history people can search. DONE WHEN: a first-time buyer pays in under a minute on a phone.' },
  { key: 'tides', name: 'Tide Tables', about: 'A phone app that shows today\'s tides for a saved harbour. GOAL: works with no signal. DONE WHEN: a week of tides opens in airplane mode.' },
  { key: 'site', name: 'Lighthouse Site', about: 'The studio\'s own website. GOAL: every page says what it is for in its first line.' },
  { key: 'kit', name: 'Signal Kit', about: 'Buttons, forms and colours shared by the shop and the site.' },
]

const DENY_PUSH = 'Bash(git push:*),Bash(git merge:*),Bash(git rebase:*),Bash(rm -rf:*),Bash(sudo:*)'
const claude = (model, effort, turns, minutes) => ['claude_local', { model, effort, maxTurnsPerRun: turns, timeoutSec: minutes * 60, dangerouslySkipPermissions: true, mayNot: ['push'], extraArgs: ['--disallowedTools', DENY_PUSH] }]
const codex = (model, effort, minutes) => ['codex_local', { model, modelReasoningEffort: effort, timeoutSec: minutes * 60, mayNot: ['push', 'edit'] }]
const free = (minutes, mayNot = ['push']) => ['opencode_local', { model: 'auto', variant: 'high', timeoutSec: minutes * 60, dangerouslySkipPermissions: true, mayNot }]
const gemini = (model, minutes) => ['gemini_local', { model, timeoutSec: minutes * 60, mayNot: ['push', 'commit'] }]

/**
 * The crew: eight bots that differ in what they do, which AI runs them and how they look on the map.
 * `engine` is the engine's own word for the kind of work; `role` and `look` are what the pages read.
 */
export const CREW = [
  { key: 'marlow', name: 'Marlow', engine: 'ceo', role: 'lead', title: 'Hands out the work', boss: null,
    does: 'Talks with the owner, turns what they ask into jobs, has every build checked, and says plainly what is done.',
    ai: claude('claude-sonnet-5-5', 'high', 80, 45), look: { colour: '#1d1e22', hat: 'crown', gear: ['sash'], face: 'light' } },
  { key: 'juno', name: 'Juno', engine: 'general', role: 'ruler', title: 'Rules on the hard calls', boss: 'marlow',
    does: 'Decides when a builder and a checker disagree, and when a job may skip a step.',
    ai: claude('claude-opus-5-5', 'high', 60, 45), look: { colour: '#c49a6c', hat: 'wizard', build: 'robed', gear: ['cape'] } },
  { key: 'piper', name: 'Piper', engine: 'general', role: 'reviewer', title: 'Reads every change before it is merged', boss: 'marlow',
    does: 'Reviews a finished build line by line and lists what blocks it. Changes nothing herself.',
    ai: codex('gpt-6.1-sol', 'medium', 45), look: { colour: '#e2404d', hat: 'beret', build: 'curvy', gear: ['clipboard'] } },
  { key: 'atlas', name: 'Atlas', engine: 'engineer', role: 'builder', title: 'Senior builder', boss: 'marlow',
    does: 'Takes the builds that touch many files or need a design decision.',
    ai: claude('claude-opus-5-5', 'high', 300, 180), look: { colour: '#6457e8', hat: 'cog', build: 'heavy', gear: ['toolbelt'] }, atOnce: 2 },
  { key: 'rook', name: 'Rook', engine: 'engineer', role: 'builder', title: 'Builder', boss: 'atlas',
    does: 'Builds one piece of a job at a time on its own branch, and commits it.',
    ai: claude('claude-sonnet-5-5', 'medium', 150, 90), look: { colour: '#2f7cf6', hat: 'hardhat', build: 'barrel', gear: ['wrench'] }, atOnce: 3 },
  { key: 'wren', name: 'Wren', engine: 'engineer', role: 'builder', title: 'Builder on free models', boss: 'atlas',
    does: 'Small, well-described builds, on models that cost nothing.',
    ai: free(60), look: { colour: '#2fbf5a', hat: 'headphones', build: 'slim', gear: ['satchel'] }, atOnce: 2 },
  { key: 'sable', name: 'Sable', engine: 'qa', role: 'checker', title: 'Checks every build', boss: 'marlow',
    does: 'Runs a finished build, tries to break it, and says pass or what to fix. Never the same model that built it.',
    ai: free(45, ['push', 'edit']), look: { colour: '#f06fae', hat: 'feelers', build: 'lady', gear: ['magnifier', 'ponytail'] }, atOnce: 2 },
  { key: 'finch', name: 'Finch', engine: 'researcher', role: 'researcher', title: 'Looks things up', boss: 'marlow',
    does: 'Reads the docs, compares libraries and writes a short answer with its sources.',
    ai: gemini('gemini-3.8-flash-high', 30), look: { colour: '#f08a1c', hat: 'tophat', build: 'vee', gear: ['bowtie'] }, off: true },
]

/** Which of the tree's default bots (its file name in `crew/bots/`) plays each part of the sample's story. */
export const SLOTS = { marlow: 'lead', juno: 'ruler', piper: 'reviewer', atlas: 'senior-builder', rook: 'claude-builder', wren: 'builder', sable: 'checker', finch: 'researcher' }
const ENGINE_WORD = { lead: 'ceo', builder: 'engineer', checker: 'qa', researcher: 'researcher' }

/** A bot's instructions as its file has them, with the shared paragraphs and the plain marks filled in. */
function rulesFrom(dir, slug, bot) {
  let text
  try { text = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8') } catch { return '' }
  const shared = (name) => { try { return fs.readFileSync(path.join(dir, 'shared', `${name}.md`), 'utf8').replace(/\n$/, '') } catch { return '' } }
  const marks = { name: bot.name, title: bot.title || '', studio: STUDIO.name }
  return text.replace(/\{\{\s*shared:\s*([\w-]+)\s*\}\}/g, (_, name) => shared(name))
    .replace(/\{\{\s*([\w-]+)\s*\}\}/g, (mark, key) => (key in marks ? marks[key] : ''))
}

/**
 * The tree's own default crew as the sample's eight, when `crew/bots/` holds all eight files: their
 * names, titles, roles, looks, AIs and instructions are then the ones a new yard really starts
 * with. With any of them missing the sample's own eight are used whole, never a mix.
 */
export function crewFromTree(dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'crew', 'bots')) {
  const files = {}
  for (const [key, slug] of Object.entries(SLOTS)) {
    try { files[key] = JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8')) } catch { return null }
  }
  const keyOf = (slug) => Object.keys(SLOTS).find((key) => SLOTS[key] === slug) || null
  return CREW.map((mine) => {
    const file = files[mine.key]
    const minutes = Number(file.minutes) || 60
    const mayNot = Array.isArray(file.mayNot) && file.mayNot.length ? file.mayNot : ['push']
    const ai = file.ai === 'claude' ? ['claude_local', { model: file.model, effort: file.effort || 'medium', maxTurnsPerRun: file.turns || undefined, timeoutSec: minutes * 60, mayNot }]
      : file.ai === 'codex' ? ['codex_local', { model: file.model, modelReasoningEffort: file.effort || 'medium', timeoutSec: minutes * 60, mayNot }]
      : file.ai === 'gemini' ? ['gemini_local', { model: file.model, timeoutSec: minutes * 60, mayNot }]
      : ['opencode_local', { model: file.model || 'auto', variant: file.effort || 'high', timeoutSec: minutes * 60, mayNot }]
    const bot = { key: mine.key, slug: SLOTS[mine.key], name: file.name || mine.name, engine: ENGINE_WORD[file.role] || 'general', role: file.role || mine.role, tier: file.tier || 'strong',
      title: file.title || mine.title, boss: file.reportsTo ? keyOf(file.reportsTo) : null, does: file.does || mine.does, ai, look: file.look || mine.look, atOnce: Number(file.atOnce) || 1, off: mine.off }
    return { ...bot, rules: rulesFrom(dir, SLOTS[mine.key], bot) }
  })
}

const RULES = (bot) => `You are ${bot.name}, a bot in ${STUDIO.name}. ${bot.title}.

WHAT YOU DO
${bot.does}

HOW YOU WORK
- Read the job you are given, and its comments, before you start.
- Work only in the job's own folder. Commit your work with a message that says what changed and why.
- When you are done, write a report on the job: what you did, what you checked, what you could not do.
- If you need the owner's answer, ask on a card and wait. Never guess at a decision that is theirs.
- You do not push, merge or publish. The owner does, or a helper does after a check has passed.
`

/**
 * The work, oldest first. `mins` is how long ago each thing happened. A check is titled the way the
 * crew titles one ("Check LH-3: …"), so the map joins it to its build; "(Lead)" marks the ruling.
 */
function story(bot, project) {
  return [
    // Finished, checked, ruled and merged yesterday.
    { key: 'history', project: project.shop, title: 'Order history: a page of past orders', by: bot.rook, status: 'done', made: 30 * 60, started: 29 * 60, ended: 27 * 60,
      body: 'A signed-in buyer sees their past orders, newest first, with a link to each receipt.\n\nDone when: twenty orders load in under a second and the page works with a keyboard alone.',
      said: [[bot.rook, 27 * 60, 'Built on `orders-history`.\n\n- New route `/orders` with a table of date, items, total and a receipt link.\n- Paged twenty at a time; the query uses the index on `buyer_id, created_at`.\n- Tests: 14 new, all pass. Keyboard: every row is reachable and the receipt link is the row\'s only tab stop.\n\nNot done: export to a file. Say if you want it as its own job.\n\nOUTCOME: MET']],
      runs: [{ by: bot.rook, at: 29 * 60, took: 118 * 60, tokens: [412_000, 38_000, 2_900_000], ok: true }], merged: 25 * 60 },
    { check: 'history', project: project.shop, by: bot.sable, status: 'done', made: 27 * 60, started: 27 * 60 - 5, ended: 26 * 60 + 20,
      said: [[bot.sable, 26 * 60 + 20, '## OUTCOME: PASS\n\nRan it with 0, 1, 20 and 400 orders. Paging holds, the empty state says what to do, and the receipt link opens the right order every time. One note, not blocking: the total column is not right-aligned on a narrow phone.']],
      runs: [{ by: bot.sable, at: 27 * 60 - 5, took: 33 * 60, tokens: [96_000, 9_000, 310_000], ok: true }] },
    { check: 'history', lead: true, project: project.shop, by: bot.marlow, status: 'done', made: 26 * 60 + 15, started: 26 * 60 + 10, ended: 25 * 60 + 30,
      said: [[bot.marlow, 25 * 60 + 30, 'VERDICT: PASS. Merge it. The alignment note becomes its own small job for Wren.']],
      runs: [{ by: bot.marlow, at: 26 * 60 + 10, took: 9 * 60, tokens: [41_000, 3_000, 120_000], ok: true }] },

    // Failed its check, was fixed, passed, and waits to be merged.
    { key: 'offline', project: project.tides, title: 'Offline: keep a week of tides on the phone', by: bot.atlas, status: 'done', made: 22 * 60, started: 21 * 60, ended: 18 * 60,
      body: 'Save the next seven days for the saved harbour so the app opens with no signal.\n\nDone when: in airplane mode the app opens on today\'s tides and says when they were last fetched.',
      said: [[bot.atlas, 18 * 60, 'Built on `tides-offline`. The week is stored on the phone after every successful fetch and read first on start. The header shows "Fetched 2 hours ago" from the stored time.']],
      runs: [{ by: bot.atlas, at: 21 * 60, took: 174 * 60, tokens: [890_000, 71_000, 6_400_000], ok: true }] },
    { check: 'offline', project: project.tides, by: bot.sable, status: 'done', made: 18 * 60, started: 18 * 60 - 4, ended: 17 * 60 + 10,
      said: [[bot.sable, 17 * 60 + 10, '## OUTCOME: FAIL\n\nBLOCKING: with the clock set past the stored week the app shows an empty screen and no message. It must say the tides are out of date and offer to fetch.\n\nEverything else holds: airplane mode opens on today, and the fetched time is right.']],
      runs: [{ by: bot.sable, at: 18 * 60 - 4, took: 41 * 60, tokens: [120_000, 12_000, 420_000], ok: true }] },
    { fix: 'offline', round: 1, project: project.tides, by: bot.atlas, status: 'done', made: 17 * 60, started: 16 * 60 + 40, ended: 15 * 60 + 50,
      said: [[bot.atlas, 15 * 60 + 50, 'Fixed. Past the stored week the app now shows the last day it has, a line saying "These tides are out of date", and a Fetch button. Added a test that moves the clock eight days on.']],
      runs: [{ by: bot.atlas, at: 16 * 60 + 40, took: 47 * 60, tokens: [260_000, 22_000, 1_900_000], ok: true }] },
    { check: 'fix:offline', project: project.tides, by: bot.sable, status: 'done', made: 15 * 60 + 45, started: 15 * 60 + 40, ended: 15 * 60 + 5,
      said: [[bot.sable, 15 * 60 + 5, '## OUTCOME: PASS\n\nMoved the clock 8, 30 and 400 days on: the out-of-date line shows each time and Fetch brings a fresh week.']],
      runs: [{ by: bot.sable, at: 15 * 60 + 40, took: 31 * 60, tokens: [88_000, 8_000, 290_000], ok: true }] },

    // Being ruled on by the lead right now.
    { key: 'search', project: project.shop, title: 'Search: find a product by any word in its name', by: bot.rook, status: 'done', made: 9 * 60, started: 8 * 60 + 30, ended: 6 * 60 + 40,
      body: 'The search box finds a product by any word in its name or its code, and forgives one wrong letter.\n\nDone when: "anchr chain" finds the anchor chain.',
      said: [[bot.rook, 6 * 60 + 40, 'Built on `shop-search`. Words are matched in any order; one wrong letter is forgiven for words of five letters or more. 22 tests, all pass. The search is a plain index in the shop\'s own database: no new service to run.\n\nOUTCOME: MET']],
      runs: [{ by: bot.rook, at: 8 * 60 + 30, took: 106 * 60, tokens: [505_000, 44_000, 3_300_000], ok: true }] },
    { check: 'search', project: project.shop, by: bot.sable, status: 'done', made: 6 * 60 + 40, started: 6 * 60 + 35, ended: 5 * 60 + 55,
      said: [[bot.sable, 5 * 60 + 55, '## OUTCOME: PASS\n\n"anchr chain", "chain anchor" and the product code all find it. A search of one letter answers in 40 ms with 2,000 products.']],
      runs: [{ by: bot.sable, at: 6 * 60 + 35, took: 36 * 60, tokens: [101_000, 9_500, 330_000], ok: true }] },
    { check: 'search', project: project.shop, by: bot.piper, status: 'done', made: 5 * 60 + 54, started: 5 * 60 + 53, ended: 5 * 60 + 51,
      said: [[bot.piper, 5 * 60 + 51, '## VERDICT: PASS\n\nRead every changed line. The index is built in one migration and dropped in its undo. Nothing blocks it. Not blocking: the forgiving match lives in two places; one would do.']],
      runs: [{ by: bot.piper, at: 5 * 60 + 53, took: 2 * 60, tokens: [64_000, 5_000, 180_000], ok: true }] },
    // A hard call put to the ruler, and answered.
    { key: 'skip', project: project.shop, title: 'Ruling: may search ship before the reviewer reads it?', by: bot.juno, status: 'done', made: 6 * 60 + 30, started: 6 * 60 + 28, ended: 6 * 60 + 10,
      body: 'The checker passed it and the shop is busy this week. May it be merged now and reviewed after?',
      said: [[bot.juno, 6 * 60 + 10, 'RULING: No. Search reads the buyers\' own data, so the reviewer reads it first. It is one short review, not a day.']],
      runs: [{ by: bot.juno, at: 6 * 60 + 28, took: 9 * 60, tokens: [38_000, 4_000, 90_000], ok: true }] },
    { check: 'search', lead: true, project: project.shop, by: bot.marlow, status: 'in_progress', made: 5 * 60 + 50, started: 14,
      runs: [{ by: bot.marlow, at: 14, live: true }] },

    // Waiting for its check.
    { key: 'buttons', project: project.kit, title: 'Buttons: one size for a thumb on every screen', by: bot.wren, status: 'done', made: 5 * 60, started: 4 * 60 + 30, ended: 70,
      body: 'Every button is at least 44 points tall and keeps its label on one line down to a 320-point screen.',
      said: [[bot.wren, 70, 'Built on `kit-buttons`. Three sizes became two; the small one is now only for toolbars. Checked on 320, 390 and 768 wide.']],
      runs: [{ by: bot.wren, at: 4 * 60 + 30, took: 52 * 60, tokens: [140_000, 15_000, 510_000], ok: true }, { by: bot.wren, at: 5 * 60 - 10, took: 4 * 60, tokens: [9_000, 400, 0], ok: false, why: 'Rate limit exceeded: free-models-per-day' }] },
    { check: 'buttons', project: project.kit, by: bot.sable, status: 'in_progress', made: 68, started: 22,
      runs: [{ by: bot.sable, at: 22, live: true }] },

    // Being built now, two at once.
    { key: 'checkout', project: project.shop, title: 'Checkout: one page instead of three', by: bot.atlas, status: 'in_progress', made: 3 * 60, started: 96, priority: 'high',
      body: 'Address, delivery and payment on one page, each part opening as the one before it is filled.\n\nDone when: a first-time buyer pays in under a minute on a phone.\n\nNot in this job: saved cards.',
      said: [[bot.marlow, 3 * 60 - 2, 'Atlas: this is the big one this week. Start from the plan in this job\'s documents. Ask on a card before you change the payment provider\'s settings.'], [bot.atlas, 40, 'Halfway. Address and delivery are on the one page and validate as you type. Payment is next. I have a question for the owner on a card: it decides how the last step is built.']],
      runs: [{ by: bot.atlas, at: 96, live: true }], plan: true, ask: true },
    { key: 'widget', project: project.tides, title: 'Home screen widget: the next high and low tide', by: bot.rook, status: 'in_progress', made: 2 * 60 + 20, started: 51,
      body: 'A small widget with the next high and the next low for the saved harbour. It reads the stored week, so it works with no signal.',
      runs: [{ by: bot.rook, at: 51, live: true }] },

    // Blocked on something only the owner has.
    { key: 'receipts', project: project.shop, title: 'Receipts: send one by email after every order', by: bot.wren, status: 'blocked', made: 7 * 60, started: 6 * 60 + 30,
      body: 'After an order is paid the buyer gets a receipt by email with the items, the total and a link back to the order.',
      said: [[bot.wren, 5 * 60, 'Blocked. The receipt is built and its tests pass with a stand-in mailer, but there is no mail service connected to this yard, so I cannot send a real one. Connect one on the Connectors page and choose that I may use it, then reopen this job.\n\nOUTCOME: NOT MET']],
      runs: [{ by: bot.wren, at: 6 * 60 + 30, took: 58 * 60, tokens: [150_000, 13_000, 480_000], ok: true }] },

    // Waiting for a bot to be free, and for the owner to say go.
    { key: 'align', waits: 'checkout', project: project.shop, title: 'Order history: right-align the totals on a narrow phone', by: bot.wren, status: 'todo', made: 25 * 60, body: 'From Sable\'s note on the order history check.' },
    { key: 'about', owner: true, project: project.site, title: 'About page: say what the studio does in its first line', by: bot.rook, status: 'todo', made: 4 * 60, body: 'The page opens on a paragraph about values. Put what we make, and for whom, first.' },
    { key: 'dark', owner: true, project: project.kit, title: 'Colours: a night set that keeps every label readable', by: null, status: 'backlog', made: 40 * 60, body: 'Later. Needs the buttons job first.' },
    { key: 'compare', project: project.tides, title: 'Compare three sources of tide data: cost, cover and licence', by: bot.finch, status: 'todo', made: 20 * 60,
      body: 'A short table with a source for every claim. No building.', said: [[bot.marlow, 20 * 60 - 5, 'Finch is switched off until Gemini is signed in (Setup). This waits for him.']] },

    // An idea from the researcher, approved by the ruler, and started by the lead.
    { key: 'idea', project: project.shop, title: 'A printed tide calendar for each harbour, sold at the till', by: bot.juno, from: bot.finch, status: 'done', made: 40 * 60, started: 39 * 60, ended: 38 * 60,
      body: 'Three chandleries nearby sell paper tide tables at the till. The shop could print one per harbour from the data the app already has.',
      said: [[bot.finch, 40 * 60 - 1, 'Small to make, sells all year, and it points buyers to the app. One print shop quoted a fair price for fifty.'], [bot.juno, 38 * 60, 'RULING: APPROVED. One small step first: a page that prints a month for one harbour. Nothing is bought until the owner says so.']],
      runs: [{ by: bot.juno, at: 39 * 60, took: 6 * 60, tokens: [30_000, 3_000, 70_000], ok: true }] },
    { key: 'calendar', parent: 'idea', project: project.shop, title: 'Tide calendar: a page that prints one month for one harbour', by: bot.wren, status: 'todo', made: 37 * 60,
      body: 'From the approved idea. One harbour, one month, on one sheet. No order is placed with a printer.' },

    // Called off.
    { key: 'pdf', owner: true, project: project.shop, title: 'Receipts as a PDF attached to the email', by: bot.rook, status: 'cancelled', made: 12 * 60, ended: 11 * 60, body: 'Dropped: the link back to the order is enough for now.' },
  ]
}

const PLAN = [
  '# Checkout on one page\n\n1. Address\n2. Delivery\n3. Payment\n',
  '# Checkout on one page\n\nThe three steps stay three parts, on one page. Each opens when the one before it is valid.\n\n1. **Address**: postcode first, then the street is offered.\n2. **Delivery**: two choices, the cheaper one picked.\n3. **Payment**: the provider\'s own form, in place.\n\nNot in this job: saved cards, gift codes.\n',
  '# Checkout on one page\n\nThe three steps stay three parts, on one page. Each opens when the one before it is valid.\n\n1. **Address**: postcode first, then the street is offered. A wrong postcode says so under the field, not in a pop-up.\n2. **Delivery**: two choices, the cheaper one picked. The price shows beside each.\n3. **Payment**: the provider\'s own form, in place. The Pay button carries the total.\n\n## What done looks like\n- A first-time buyer pays in under a minute on a phone.\n- Every part can be reached and filled with a keyboard alone.\n- Going back keeps what was typed.\n\nNot in this job: saved cards, gift codes.\n',
]

/** A run's log as the tool writes it, so a run's page has something a person can read. */
const logLines = (lines) => `${lines.map((event) => JSON.stringify({ ts: new Date().toISOString(), stream: 'stdout', chunk: `${JSON.stringify(event)}\n` })).join('\n')}\n`
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const used = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
/** What a run of this job would have written: reading, working, testing, and its last words. */
function sampleLog(title, checking) {
  const what = title.replace(/^Check [A-Z]+-\d+( \([^)]+\))?: /, '').replace(/^Fix \d+ of /, '')
  const short = what.split(':')[0]
  return checking ? [
    said('Reading the job, the build\'s report and what the job asked for.'),
    used('Bash', { command: 'git log --oneline -5' }),
    used('Bash', { command: 'npm test' }),
    said(`The tests pass. Now trying ${short.toLowerCase()} by hand, with the cases the report does not mention.`),
    used('Bash', { command: 'npm run start:test' }),
    said('Done. My verdict and what I tried are on the job.'),
  ] : [
    said('Reading the job and its comments first.'),
    used('Read', { file_path: 'README.md' }),
    used('Bash', { command: 'npm test' }),
    said(`The first part of "${what}" is in and its tests pass.`),
    used('Edit', { file_path: 'src/index.ts' }),
    used('Bash', { command: `git commit -am "${short}: first working version"` }),
    said('Done. The report is on the job: what I built, what I checked and what I left out.'),
  ]
}

/**
 * Fill an empty store with the sample yard.
 *
 * @param {object} engine          what `startEngine` gave: `{ store }`
 * @param {object} options
 * @param {string} options.dataDir the engine's data folder (the home folder)
 * @param {number} [options.now]   the moment the sample is "now"; everything is dated back from it
 * @returns {Promise<object>} what was made, by name: `{ studio, projects, bots, jobs, routines }`
 */
export async function fillSampleYard({ store }, { dataDir, now = Date.now(), crew = crewFromTree() || CREW } = {}) {
  const { answer } = await import('../server/engine/api.mjs')
  const iso = (minsAgo) => new Date(now - minsAgo * MIN).toISOString()
  /** One call to the engine, at a moment of our choosing and as whoever makes it. */
  // The story speaks of the bots by the sample's own names; with another crew it speaks of them by theirs.
  const nameOf = Object.fromEntries(crew.map((b) => [CREW.find((mine) => mine.key === b.key).name, b.name]))
  const named = (value) => (value === undefined || value === null ? value : JSON.parse(JSON.stringify(value).replace(new RegExp(`\\b(${Object.keys(nameOf).join('|')})\\b`, 'g'), (name) => JSON.stringify(nameOf[name]).slice(1, -1))))
  const call = (method, url, given, { ago = 0, as = null } = {}) => {
    const body = named(given)
    const out = answer(store, { method, url, headers: {}, body: body ?? {} }, { dataDir, now: now - ago * MIN, ...(as ? { actor: { agent: as } } : {}) })
    if (out.status >= 400) throw new Error(`The sample yard could not be made: ${method} ${url} said ${out.body?.error || out.status}`)
    return out.body
  }

  const [studio] = call('GET', '/companies')
  if (call('GET', `/companies/${studio.id}/agents`).length || call('GET', `/companies/${studio.id}/issues?limit=1`).length) {
    throw new Error('The sample yard is only put into an empty yard: this one already has bots or jobs')
  }
  call('PATCH', `/companies/${studio.id}`, { name: STUDIO.name, issuePrefix: STUDIO.prefix, description: 'A made-up studio, to show Botyard at work.' }, { ago: 3 * 24 * 60 })

  // ── projects, each with a folder of its own ────────────────────────────────────────
  const project = {}
  for (const p of PROJECTS) {
    const cwd = path.join(dataDir, 'projects', p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(path.join(cwd, 'README.md'), `# ${p.name}\n\nA made-up project of the sample yard. Nothing here is real work.\n`)
    const before = call('GET', `/companies/${studio.id}/projects`).find((x) => x.name === p.name)
    project[p.key] = (before || call('POST', `/companies/${studio.id}/projects`, { name: p.name, description: p.about, workspace: { cwd } }, { ago: 3 * 24 * 60 })).id
  }
  // The first project every new yard starts with is not part of the sample.
  for (const first of call('GET', `/companies/${studio.id}/projects`)) {
    if (!Object.values(project).includes(first.id) && !first.archivedAt) call('DELETE', `/projects/${first.id}`)
  }

  // ── the crew ────────────────────────────────────────────────────────────────────────
  const bot = {}
  // A boss is made before whoever answers to it, whatever order the files came in.
  const inOrder = [...crew].sort((a, b) => Number(Boolean(a.boss)) - Number(Boolean(b.boss)))
  inOrder.forEach((b, n) => {
    const [adapterType, adapterConfig] = b.ai
    const made = call('POST', `/companies/${studio.id}/agents`, {
      name: b.name, role: b.engine, title: b.title, capabilities: b.does, reportsTo: b.boss ? bot[b.boss] : null, adapterType, adapterConfig,
      runtimeConfig: { heartbeat: { maxConcurrentRuns: b.atOnce || 1 } }, metadata: { role: b.role, ...(b.tier ? { tier: b.tier } : {}), look: b.look }, instructions: b.rules && b.rules.trim() ? b.rules : RULES(b),
    }, { ago: 3 * 24 * 60 - n })
    bot[b.key] = made.id
    if (b.off) call('POST', `/agents/${made.id}/pause`, {}, { ago: 2 * 24 * 60 })
  })
  // The lead's instructions were changed twice since: two more versions to look at and take back.
  const lead = crew.find((b) => b.key === 'marlow')
  const leadRules = lead.rules && lead.rules.trim() ? `${lead.rules.replace(/\n*$/, '\n')}` : RULES(lead)
  call('PUT', `/agents/${bot.marlow}/instructions`, { content: `${leadRules}- Give a build to the builder whose last three jobs in that project passed their check first time.\n` }, { ago: 26 * 60 })
  call('PUT', `/agents/${bot.marlow}/instructions`, { content: `${leadRules}- Give a build to the builder whose last three jobs in that project passed their check first time.\n- A job that changes how people pay is never merged without the owner's yes on a card.\n` }, { ago: 5 * 60 })

  // ── the work ────────────────────────────────────────────────────────────────────────
  const jobs = {}
  const runs = []
  /** Set a job's moment in time: the engine dates everything "now", and a day's work is not a second old. */
  const date = (id, fields) => {
    const row = store.object('SELECT raw FROM jobs WHERE id = ?', id)
    store.put('jobs', { ...row, ...fields })
  }
  for (const item of story(bot, project)) {
    const of = item.check ? jobs[item.check] : item.fix ? jobs[item.fix] : null
    const title = item.check ? `Check ${of.identifier}${item.lead ? ' (Lead)' : ''}: ${of.workTitle}`
      : item.fix ? `Fix ${item.round} of ${of.workTitle}` : item.title
    const job = call('POST', `/companies/${studio.id}/issues`, {
      title, description: item.body || (item.check ? `Check the build of ${of.identifier} against what the job asks for. Say PASS, or what blocks it.` : ''),
      projectId: item.project, ...(item.by ? { assigneeAgentId: item.by } : {}), status: item.status === 'backlog' ? 'backlog' : 'todo', priority: item.priority || 'medium',
      ...(item.parent ? { parentId: jobs[item.parent].id } : {}),
    }, { ago: item.made, as: item.owner ? null : item.from || bot.marlow })
    const key = item.key || (item.fix ? `fix:${item.fix}` : `${item.check}:${item.lead ? 'ruling' : 'check'}:${job.identifier}`)
    jobs[key] = { id: job.id, identifier: job.identifier, workTitle: of?.workTitle || item.title, status: item.status }
    for (const [who, ago, text] of item.said || []) call('POST', `/issues/${job.id}/comments`, { body: text }, { ago, as: who })
    // A job that cannot go on until another one moves.
    if (item.waits) call('PATCH', `/issues/${job.id}`, { blockedByIssueIds: [jobs[item.waits].id] }, { ago: item.made })
    if (item.status !== 'todo' && item.status !== 'backlog') call('PATCH', `/issues/${job.id}`, { status: item.status }, { ago: item.ended ?? item.started ?? item.made })
    date(job.id, {
      createdAt: iso(item.made), startedAt: item.started === undefined ? null : iso(item.started),
      completedAt: item.status === 'done' ? iso(item.ended) : null, cancelledAt: item.status === 'cancelled' ? iso(item.ended) : null,
      updatedAt: iso(item.ended ?? Math.min(item.started ?? item.made, ...(item.said || []).map(([, ago]) => ago))),
      lastActivityAt: iso(item.ended ?? Math.min(item.started ?? item.made, ...(item.said || []).map(([, ago]) => ago))),
    })
    for (const run of item.runs || []) runs.push({ ...run, jobId: job.id, projectId: item.project, title, checking: Boolean(item.check) })

    if (item.plan) {
      let base = null
      PLAN.forEach((body, n) => {
        const doc = call('PUT', `/issues/${job.id}/documents/plan`, { format: 'markdown', title: 'Plan', body, baseRevisionId: base, changeSummary: ['First outline', 'Each step said in a line', 'What done looks like'][n] }, { ago: 170 - n * 25, as: n ? bot.atlas : bot.marlow })
        base = doc.latestRevisionId
      })
    }
    if (item.ask) {
      call('POST', `/issues/${job.id}/interactions`, {
        kind: 'ask_user_questions', title: 'How should a buyer pay on the one page?',
        payload: { questions: [{ id: 'pay', prompt: 'Which payment form goes on the checkout page?', selectionMode: 'single', required: true, options: [
          { id: 'inline', label: 'The provider\'s form, in the page', description: 'Fewer steps. Needs the provider\'s script on our page.' },
          { id: 'redirect', label: 'Send the buyer to the provider\'s page', description: 'One more step, and nothing of theirs on our page.' },
        ] }] },
      }, { ago: 38, as: bot.atlas })
    }
  }

  // ── runs: only the engine ever writes these ─────────────────────────────────────────
  const agents = new Map(call('GET', `/companies/${studio.id}/agents`).map((a) => [a.id, a]))
  const PROVIDER = { claude_local: 'anthropic', codex_local: 'openai', gemini_local: 'google', opencode_local: 'opencode' }
  const logDir = path.join(dataDir, 'run-logs', 'sample')
  fs.mkdirSync(logDir, { recursive: true })
  store.tx(() => {
    for (const run of runs) {
      const id = randomUUID()
      const agent = agents.get(run.by)
      const model = agent.adapterConfig.model === 'auto' ? 'opencode/deepseek-v4.1-flash-free' : agent.adapterConfig.model
      const started = iso(run.at)
      const finished = run.live ? null : new Date(now - run.at * MIN + run.took * 1000).toISOString()
      const [input = 0, output = 0, cached = 0] = run.tokens || []
      const log = logLines(sampleLog(run.title, run.checking))
      fs.writeFileSync(path.join(logDir, `${id}.ndjson`), log)
      const usage = run.live ? null : { model, inputTokens: input, cachedInputTokens: cached, outputTokens: output, costUsd: 0, billingType: 'subscription_included' }
      store.put('runs', {
        id, companyId: studio.id, agentId: run.by, scopeKind: 'issue', issueId: run.jobId, invocationSource: 'assignment', triggerDetail: 'issue_assigned', wakeupRequestId: null,
        status: run.live ? 'running' : run.ok ? 'succeeded' : 'failed', startedAt: started, finishedAt: finished,
        error: run.ok || run.live ? null : run.why, errorCode: run.ok || run.live ? null : 'adapter_failed', exitCode: run.live ? null : run.ok ? 0 : 1, signal: null,
        usageJson: usage, resultJson: run.live ? null : { summary: run.ok ? 'Done. The report is on the job.' : run.why }, sessionIdBefore: null, sessionIdAfter: null,
        logStore: 'local_file', logRef: `sample/${id}.ndjson`, logBytes: Buffer.byteLength(log), stdoutExcerpt: '', stderrExcerpt: '', retryOfRunId: null,
        contextSnapshot: { issueId: run.jobId, wakeReason: 'issue_assigned', wakeSource: 'assignment', model }, createdAt: started, updatedAt: finished || started,
      })
      store.put('job_runs', { runId: id }, { job_id: run.jobId, position: store.row('SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ?', run.jobId).n })
      if (usage) {
        store.put('usage', {
          id: randomUUID(), companyId: studio.id, heartbeatRunId: id, agentId: run.by, issueId: run.jobId, projectId: run.projectId, provider: PROVIDER[agent.adapterType], biller: PROVIDER[agent.adapterType],
          billingType: 'subscription_included', model, costStatus: 'unpriced', inputTokens: input, cachedInputTokens: cached, outputTokens: output, costCents: 0, occurredAt: finished,
        })
      }
    }
  })

  // ── routines ────────────────────────────────────────────────────────────────────────
  const routine = (title, description, botId, projectId, cronExpression) => {
    const made = call('POST', `/companies/${studio.id}/routines`, { title, description, assigneeAgentId: botId, ...(projectId ? { projectId } : {}) }, { ago: 2 * 24 * 60 })
    call('POST', `/routines/${made.id}/triggers`, { kind: 'schedule', cronExpression, timezone: 'UTC' }, { ago: 2 * 24 * 60 })
    return made.id
  }
  const routines = [
    routine('Run every project\'s tests and say what broke', 'Each night: run the tests of every project and write one line per failure, with the commit that brought it.', bot.sable, null, '0 3 * * *'),
    routine('Plan the week: three jobs for each project', 'Read each project\'s goal and what was finished last week, and write the next three jobs for it.', bot.marlow, null, '30 7 * * 1'),
  ]

  // ── a conversation with the lead, and a yes-or-no waiting in it ─────────────────────
  const chat = call('POST', `/companies/${studio.id}/chats/${bot.marlow}`, {}, { ago: 6 * 60 })
  const say = (text, ago, as = null) => call('POST', `/issues/${chat.id}/comments`, { body: text, clientRequestId: randomUUID() }, { ago, as })
  say('Morning. What is the state of the shop?', 6 * 60)
  say('Three things. Order history was merged last night. Search passed its check and I am ruling on it now. Checkout is half built by Atlas, who has a question for you on its job: it decides how payment is built.', 6 * 60 - 2, bot.marlow)
  say('And the tides app?', 30)
  say(`Offline passed its second check after one fix, and waits for your yes to merge (${jobs.offline.identifier}). Rook is on the home screen widget.`, 28, bot.marlow)
  call('POST', `/issues/${chat.id}/interactions`, {
    kind: 'request_confirmation', title: `Merge ${jobs.offline.identifier}: a week of tides kept on the phone?`,
    payload: { prompt: 'It failed its first check (an empty screen past the stored week), was fixed, and passed the second. Merging puts it in the project\'s main line.', acceptLabel: 'Merge it', rejectLabel: 'Not yet' },
  }, { ago: 27, as: bot.marlow })

  // ── the crew's scripts: notes they leave, signed so they are not taken for the owner's words ──
  const note = (jobId, text, name, ago) => call('POST', `/issues/${jobId}/comments`, { body: `${text}\n\n<!-- yard-script: ${name} -->` }, { ago })
  note(jobs.buttons.id, `${jobs.buttons.identifier} has waited over an hour for its check. The checker is on it now.`, 'Review guard', 20)
  note(jobs.receipts.id, 'This job has been blocked for five hours. It waits on a mail service being connected.', 'Wait watch', 60)
  note(chat.id, 'Health check: one free model is set aside until tomorrow; the others still answer.', 'Health check', 90)

  // ── what a helper keeps: the log of merges ──────────────────────────────────────────
  const crewDir = path.join(dataDir, 'crew')
  fs.mkdirSync(crewDir, { recursive: true })
  // The helper writes the clock on the wall of this computer, and the map reads it the same way.
  const two = (n) => String(n).padStart(2, '0')
  const stampOf = (minsAgo) => { const d = new Date(now - minsAgo * MIN); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }
  fs.writeFileSync(path.join(crewDir, 'merges.log'), `${stampOf(25 * 60)} ${jobs.history.identifier} 4f2a9c1 into main harbour-shop: merged\n`)

  // ── what the audits found worth improving: the Improvements page, made up ──────────────
  const secs = (minsAgo) => Math.round((now - minsAgo * MIN) / 1000)
  fs.writeFileSync(path.join(crewDir, 'improvements.json'), JSON.stringify([
    { id: 'IMP-1', title: 'Checks re-run the whole test suite for a one-line change', path: 'crew/briefs/checker.md', evidence: 'The last 20 checks each ran all 412 tests; 17 of them changed one file. A run took 9 minutes on average.', fix: 'Run the tests of the files a change touches first, and the whole suite only before a merge.', who: nameOf.Sable || 'Sable', status: 'new', added: secs(90) },
    { id: 'IMP-2', title: 'Reports do not name the commit they checked', path: 'crew/briefs/reviewer.md', evidence: '6 of the last 10 reports say "checked the branch" with no commit, so a later push cannot be told apart from the checked one.', fix: 'Put the short commit id on the first line of every report.', who: nameOf.Piper || 'Piper', status: 'ask', added: secs(300), decidedBy: 'lead', decidedAt: secs(240), reason: 'It changes every reviewer\'s brief, so the owner should say yes first.', history: [{ by: 'lead', status: 'ask', at: secs(240) }] },
    { id: 'IMP-3', title: 'Old briefs stay in the plans folder after their job closes', path: 'plans/', evidence: '38 briefs in the folder belong to jobs closed more than a month ago.', fix: 'Move a brief to plans/done/ when its job closes.', who: nameOf.Sable || 'Sable', status: 'accepted', job: jobs.history.identifier, added: secs(2000), decidedBy: 'owner', decidedAt: secs(1500), reason: 'Cheap, and the folder is hard to read today.', history: [{ by: 'lead', status: 'accepted', at: secs(1800) }, { by: 'owner', status: 'accepted', at: secs(1500) }] },
    { id: 'IMP-4', title: 'A failed build is retried at once with the same settings', path: 'crew/timetable.json', evidence: 'Three builds failed twice in a row on the same missing package.', fix: 'Wait for a fix before the retry, or retry once with the error in the brief.', who: nameOf.Piper || 'Piper', status: 'rejected', added: secs(4000), decidedBy: 'lead', decidedAt: secs(3500), reason: 'The retry rule already changed last week; measure it first.', history: [] },
  ], null, 2))

  // ── two services the crew may use: connectors, as the Connectors page keeps them ────
  // Made-up addresses that are never called: listing a connector asks nothing of its service.
  const at = (minsAgo) => now - minsAgo * MIN
  const { writeStore } = await import('../server/lib/connectors.mjs')
  const connector = (id, fields) => ({ id, from: '', writes: [], bots: {}, signedInAt: at(2 * 24 * 60), health: { ok: true, at: at(12) }, account: '', ...fields })
  writeStore({ passes: {}, connectors: {
    'harbour-tracker': connector('harbour-tracker', {
      name: 'Harbour tracker', about: 'The chandlery\'s list of orders and stock, so a bot can look an order up while it builds.', url: 'https://tracker.lighthouse.invalid/mcp', auth: 'none',
      tools: [{ name: 'find_order', about: 'Look an order up by its number or the buyer\'s name', readOnly: true }, { name: 'list_stock', about: 'What is on the shelves', readOnly: true }, { name: 'set_stock', about: 'Change how many of an item there are', readOnly: false }],
      bots: { [bot.atlas]: 'read', [bot.rook]: 'read', [bot.sable]: 'read' },
    }),
    'tide-office': connector('tide-office', {
      name: 'Tide office', about: 'The published tide tables, to check the app\'s numbers against.', url: 'https://tides.lighthouse.invalid/mcp', auth: 'key', signedInAt: 0, health: null,
      tools: [{ name: 'tides_for', about: 'High and low water for a harbour and a day', readOnly: true }],
      bots: { [bot.finch]: 'read' },
    }),
  } }, path.join(dataDir, 'keys'))

  // ── what the timetable remembers: when each helper last ran, and how it went ─────────
  const { nextAt, readTimetable } = await import('../server/lib/timetable.mjs')
  let helpers = []
  try { helpers = readTimetable(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'crew', 'timetable.json')).filter((job) => job.kind === 'timer') } catch { /* a tree without helpers has none to show */ }
  const last = Object.fromEntries(helpers.map((job, n) => {
    // Each ran when it last should have: within its own interval, or at its time of day.
    const took = 2 + (n * 7) % 40
    if (job.everyMs) {
      const minsAgo = Math.max(1, Math.round((job.everyMs / MIN) * (0.25 + (n % 3) * 0.2)))
      return [job.name, { lastStart: at(minsAgo), lastEnd: at(minsAgo) + took * 1000, lastOk: true, lastError: '' }]
    }
    // A helper with a time of day ran at its last time before now, in this computer's own time zone,
    // so it is never shown as missed whatever the zone.
    let last = nextAt(job.at, now - 8 * 24 * 60 * MIN)
    for (let next = nextAt(job.at, last); next <= now; next = nextAt(job.at, last)) last = next
    const start = Math.min(last + (n % 3) * 1000, now - MIN)
    return [job.name, { lastStart: start, lastEnd: start + took * 1000, lastOk: true, lastError: '' }]
  }))
  fs.writeFileSync(path.join(dataDir, 'timetable-state.json'), JSON.stringify({ jobs: {}, last }, null, 1))

  return { studio: { id: studio.id, ...STUDIO }, projects: project, bots: bot, jobs, routines, runs: runs.length, connectors: 2, helpers: helpers.length }
}

// Run by hand: fill the home folder named on the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const home = process.argv[2]
  if (!home) {
    console.error('Say which home folder to fill: node tools/sample-yard.mjs <folder>')
    process.exit(1)
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const { startEngine } = await import(pathToFileURL(path.join(here, '..', 'server', 'engine', 'main.mjs')).href)
  const dataDir = path.resolve(home)
  fs.mkdirSync(dataDir, { recursive: true })
  const engine = await startEngine({ dataDir, port: null, runs: false, log: () => {} })
  try {
    const made = await fillSampleYard(engine, { dataDir })
    console.log(`${made.studio.name}: ${Object.keys(made.projects).length} projects, ${Object.keys(made.bots).length} bots, ${Object.keys(made.jobs).length} jobs, ${made.runs} runs, in ${dataDir}`)
    console.log(`See it:  BOTYARD_HOME=${dataDir} BOTYARD_ENGINE_RUNS=off npm start`)
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  } finally {
    await engine.stop()
  }
}
