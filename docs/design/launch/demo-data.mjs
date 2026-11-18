// Made-up launch plan and state for the demo yard (Lighthouse Labs), to see Launch full: node docs/design/launch/demo-data.mjs DIR, then start the demo with BOTYARD_LAUNCH_PLAN=DIR/launch-plan.json BOTYARD_LAUNCH_STATE=DIR/launch-state.json. No real product, id or person.
import fs from 'node:fs'
const now = Date.now(), m = 60_000, h = 60 * m, d = 24 * h
const plan = { products: [
  { name: 'Tide Tables', project: 'Tide Tables', kind: 'app', channels: { play: { package: 'invalid.lighthouse.tides' }, appstore: { bundle: 'invalid.lighthouse.tides' }, web: { url: 'https://tides.lighthouse.invalid' } } },
  { name: 'Harbour Shop', project: 'Harbour Shop', kind: 'web', channels: { web: { url: 'https://shop.lighthouse.invalid' } } },
  { name: 'Signal Kit', project: 'Signal Kit', channels: { github: { repo: 'lighthouse/signal-kit' }, itch: { target: 'lighthouse/signal-kit' } } },
  { name: 'Lantern Run', kind: 'game', note: 'A made-up browser game, added so the board shows all eight channels.', channels: { web: { url: 'https://run.lighthouse.invalid' }, itch: { target: 'lighthouse/lantern-run' }, steam: { told: true }, crazygames: { told: true }, poki: { missing: 'its Poki game id' } } },
  { name: 'Lighthouse Site', project: 'Lighthouse Site', kind: 'web', channels: { web: { url: 'https://lighthouse.invalid' } } },
] }
const c = (state, more = {}) => ({ state, tone: 'wait', version: '', detail: '', how: 'read', waits: '', next: '', checkedAt: now - 4 * m, ...more })
const cells = {
  'Tide Tables|play': c('Production draft 2.1.0 (41)', { tone: 'look', version: '2.1.0', waits: 'owner', next: 'Your yes to release it' }),
  'Tide Tables|appstore': c('Not known: no App Store key', { how: 'none', waits: 'owner', next: 'Add the App Store Connect key on its row in Connectors' }),
  'Tide Tables|web': c('Live 2.0.3', { tone: 'ok', version: '2.0.3' }),
  'Harbour Shop|web': c('Down: it answers 502', { tone: 'bad', waits: 'crew', next: 'Find out why the address fails' }),
  'Signal Kit|github': c('Draft v0.9.0 waits for you', { tone: 'look', version: 'v0.9.0', waits: 'owner', next: 'Your yes to publish it', detail: 'Published now: v0.8.2.' }),
  'Signal Kit|itch': c('Pushed 0.8.2 on html5', { tone: 'ok', version: '0.8.2', detail: 'Whether the page is public is not readable; the owner says so.' }),
  'Lantern Run|web': c('Live 0.7.0', { tone: 'ok', version: '0.7.0' }),
  'Lantern Run|itch': c('Pushed 0.7.0 on html5', { tone: 'ok', version: '0.7.0', detail: 'Whether the page is public is not readable; the owner says so.' }),
  'Lantern Run|steam': c('Store page in review', { how: 'told', tone: 'look', by: 'owner', checkedAt: now - 9 * d, detail: 'Told more than a week ago: say again where it stands.' }),
  'Lantern Run|crazygames': c('Not told yet', { how: 'none', waits: 'owner', next: 'Say where it stands: this channel has no way to be read' }),
  'Lantern Run|poki': c('Not set up', { how: 'none', waits: 'owner', next: 'Say its Poki game id' }),
  'Lighthouse Site|web': c('Live 1.4.0', { tone: 'ok', version: '1.4.0' }),
}
const history = [
  { at: now - 3 * h, product: 'Harbour Shop', channel: 'web', from: 'Live 3.2.1', to: 'Down: it answers 502', how: 'read' },
  { at: now - 9 * h, product: 'Tide Tables', channel: 'play', from: 'Internal testing 2.1.0 (41)', to: 'Production draft 2.1.0 (41)', how: 'read' },
  { at: now - 1 * d, product: 'Signal Kit', channel: 'github', from: 'Published v0.8.2', to: 'Draft v0.9.0 waits for you', how: 'read' },
  { at: now - 2 * d, product: 'Tide Tables', channel: 'play', from: 'Nothing uploaded yet', to: 'Internal testing 2.1.0 (41)', how: 'read' },
  { at: now - 3 * d, product: 'Lighthouse Site', channel: 'web', from: 'Live 1.3.2', to: 'Live 1.4.0', how: 'read' },
]
const dir = process.argv[2]
fs.writeFileSync(`${dir}/launch-plan.json`, JSON.stringify(plan, null, 1))
fs.writeFileSync(`${dir}/launch-state.json`, JSON.stringify({ cells, told: {}, history, checkedAt: now - 4 * m }, null, 1))
