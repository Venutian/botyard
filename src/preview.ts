import type { Flow, FlowBot, FlowEdge, FlowKind, FlowRole, FlowStatus, FlowWindow } from './api';

/** Sample studio data for the web build, used only to check the design at phone size on the PC. */
const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** One made-up crew, the same on every screen. `colour` is what a studio may give a bot; the checker has none, so the app picks its own. */
const crew = [
  ['lead', 'Lead', 'Hands out the work', 'idle', 'claude-sonnet-5-5', 'Lighthouse passed review. The report is ready when you want it.', false, 4, 'lead', '#8057c8'],
  ['builder', 'Builder', 'Builds what a job asks for', 'running', 'deepseek-v4.1-flash-free', 'Committed to the branch, running the tests now.', false, 180, 'builder', '#377fe6'],
  ['checker', 'Checker', 'Checks every build before you see it', 'running', 'nemotron-3.5-super-free', 'Found the crash in the map loader.', false, 26, 'checker', ''],
  ['reviewer', 'Reviewer', 'Reviews what the checker passed', 'paused', 'claude-opus-5-5', 'Verdict: pass, with two notes on the timetable.', false, 95, 'reviewer', '#d94b52'],
] as const;
const looks = Object.fromEntries(crew.map(([id, , , , , , , , role, colour]) => [id, { role, look: colour ? { colour } : {} }]));

const bots = crew.map(([id, name, title, status, model]) => ({ id, name, title, status, model, spentCents: 0, ...looks[id] }));

const chats = crew.map(([id, name, title, status, model, text, mine, age]) => ({
  id, name, title, status, model, spentCents: 0, ...looks[id], lastActiveAt: text ? minutes(age) : null,
  lastMessage: text ? { text, mine, at: minutes(age) } : null,
}));

const job = (id: string, ref: string, title: string, status: string, bot: string, project: string) => ({ id, ref, title, status, bot, project, projectId: project, priority: 'medium', updatedAt: minutes(3) });

const summary = {
  company: 'Lighthouse Labs',
  bots,
  projects: ['Lighthouse', 'Harbour', 'Jetty'].map((name) => ({ id: name, name })),
  usage: [['5h', 42_000, 310_000], ['24h', 188_000, 240_000], ['7d', 709_000, 906_000]].flatMap(([window, claude, codex]) => [
    { provider: 'anthropic', window, tokens: claude, cachedTokens: 0 },
    { provider: 'openai', window, tokens: codex, cachedTokens: 0 },
  ]),
  needsYou: [
    { kind: 'approval', id: 'a1', title: 'Add a second builder', detail: 'Lead wants one for the Lighthouse map work.', key: 'approval:a1' },
    { kind: 'question', id: 'j1', title: 'Which map size should ship?', detail: 'Builder is waiting on you.', key: 'question:j1' },
    { kind: 'review', id: 'j4', title: 'Lighthouse timetable readability', detail: 'Reviewer passed it with two notes.', key: 'review:j4', read: true },
    { kind: 'failed', id: 'r9', title: 'A Builder run failed', detail: 'Run failed after automatic retry.', key: 'failed:r9', archived: true },
  ],
  running: [job('j1', 'LH-31', 'Fix the Lighthouse map loading crash', 'in_progress', 'Builder', 'Lighthouse'), job('j2', 'LH-32', 'Check Harbour save files after the patch', 'in_progress', 'Checker', 'Harbour')],
  queued: [job('j3', 'LH-33', 'Polish the Jetty settings page', 'todo', 'Builder', 'Jetty')],
  finished: [job('j4', 'LH-30', 'Lighthouse timetable readability', 'done', 'Reviewer', 'Lighthouse'), job('j5', 'LH-29', 'Write the Harbour store text', 'done', 'Builder', 'Harbour')],
  sessions: [{ title: 'Harbour night build', harness: 'claude-code', project: 'harbour' }],
  report: {
    finishedCount: 3,
    finished: [
      { id: 'j4', ref: 'LH-30', title: 'Lighthouse timetable readability', bot: 'Reviewer', project: 'Lighthouse' },
      { id: 'j5', ref: 'LH-29', title: 'Write the Harbour store text', bot: 'Builder', project: 'Harbour' },
    ],
    tokens: [{ provider: 'anthropic', window: '24h', tokens: 188_000, cachedTokens: 0 }, { provider: 'openai', window: '24h', tokens: 240_000, cachedTokens: 0 }],
  },
  guard: { enabled: true, limit: 5_000_000, tripped: false, used: 709_000, weekCeiling: 0.9, leadCeiling: 0.97 },
  plans: {
    claude: { week: 0.38, resets: Math.floor(Date.now() / 1000) + 5 * 86400 },
    codex: { week: 0.73, fiveHours: 0.92, resets: Math.floor(Date.now() / 1000) + 5 * 86400, fiveHoursResets: Math.floor(Date.now() / 1000) + 3600 },
    backup: null,
  },
  spentCents: 0,
  at: Date.now(),
};

const routines = [
  { id: 'r1', title: 'Run the Lighthouse test suite', paused: false, bot: 'Builder', project: 'Lighthouse', cron: '0 3 * * *', when: 'Every day at 03:00', plan: { kind: 'daily', at: '03:00' }, nextAt: new Date(Date.now() + 5 * 3600_000).toISOString(), lastAt: minutes(1300), lastStatus: 'completed' },
  { id: 'r2', title: 'Weekly asset audit', paused: true, bot: 'Checker', project: 'Harbour', cron: '0 4 * * 1', when: 'Every Monday at 04:00', plan: { kind: 'weekly', day: 1, at: '04:00' }, nextAt: null, lastAt: null, lastStatus: '' },
];

const devices = {
  sharedActive: true,
  current: 'd1',
  devices: [{ id: 'd1', name: 'Pixel 9', createdAt: minutes(60), lastSeen: minutes(1) }, { id: 'd2', name: 'Studio PC', createdAt: minutes(50), lastSeen: minutes(3) }],
  away: { address: '10.0.0.1', up: true, changed: false },
};

const thread = {
  bot: { id: 'lead', name: 'Lead', title: 'Hands out the work', ...looks.lead },
  working: true,
  messages: [
    { id: 'm1', from: 'You', mine: true, text: 'Status', at: minutes(30) },
    {
      id: 'm2', from: 'Lead', mine: false, at: minutes(29),
      text: 'Here is where things stand.\n\n| Project | Running | Doing | Next |\n|---|---|---|---|\n| Lighthouse | Builder | Map crash fix | Review |\n| Harbour | Checker | Save check | Report |\n\nNothing is blocked. **Lighthouse** should reach review within the hour.',
    },
    { id: 'm3', from: 'Botyard', mine: false, text: 'Lead started a run', at: minutes(12) },
    { id: 'm4', from: 'You', mine: true, text: 'Nice. Send the timetable work to Reviewer when it is done.', at: minutes(11) },
    { id: 'm5', from: 'You', mine: true, text: 'And keep the bar high.', at: minutes(11) },
    { id: 'm6', from: 'Lead', mine: false, text: 'Will do. Every build gets a review now.', at: minutes(10) },
    { id: 'm7', from: 'Lead', mine: false, text: 'Lighthouse passed review. The report is on [LH-42](/LH/issues/LH-42#comment-1) when you want it.', at: minutes(4) },
    { id: 'm9', from: 'You', mine: true, text: 'The map goes blank after the second level. What do you make of this?', at: minutes(3.5), pictures: [{ id: 'shot1', name: 'level-two.png' }] },
    { id: 'm10', from: 'Lead', mine: false, text: 'The screenshot shows the tiles missing under the fog layer. I have given Builder a job to fix it.', at: minutes(3) },
    { id: 'm8', from: 'Crew check', mine: false, text: 'The crew check found 1 thing to fix. Act on each in this turn.\n\n1. LH-42 has 61 comments, and every wake on it reads them again.', at: minutes(2) },
  ],
  // A question the lead asked a while back, still waiting: the chat pins it at the top.
  cards: [{
    id: 'c1', at: minutes(9), state: 'pending', kind: 'choice', title: 'Which map size should ship?',
    question: { id: 'c1', kind: 'choice', title: 'Which map size should ship?', items: [{ id: 'size', prompt: 'The large map loads slowly on phones.', multiple: false, required: true, options: [{ id: 's', label: 'Small', hint: 'Loads in 2 seconds' }, { id: 'l', label: 'Large', hint: 'Loads in 6 seconds' }] }] },
  }],
};

const detail = {
  ...summary.running[0],
  description: 'The game crashes when a large map loads after a save.\n\n- Happens on 200 by 200 maps\n- Started after the last patch',
  run: { id: 'r1', live: true, status: 'running', bot: 'Builder', why: '', at: minutes(1) },
  proof: [{ id: 'p1', name: 'Lighthouse title' }, { id: 'p2', name: 'Lighthouse map' }],
  previews: [{ name: 'Lighthouse', ok: true, commit: 'bbab327', builtAt: minutes(6), errors: 0, note: '', url: 'http://localhost:8099/' }, { name: 'Harbour', ok: false, commit: 'bbab327', builtAt: minutes(5), errors: 0, note: 'npm ERR! Missing script: dist', url: '' }],
  changes: { files: 3, added: 42, removed: 9 },
  questions: [
    { id: 'q1', kind: 'choice', title: 'Which map size should ship?', items: [{ id: 'size', prompt: 'The large map loads slowly on phones.', multiple: false, required: true, options: [{ id: 's', label: 'Small', hint: 'Loads in 2 seconds' }, { id: 'l', label: 'Large', hint: 'Loads in 6 seconds' }] }] },
    { id: 'q2', kind: 'confirm', title: 'Ship it?', prompt: 'Merge the fix once the tests pass?', accept: 'Yes, merge', reject: 'Hold it' },
  ],
  comments: [
    { id: 'c1', from: 'Lead', text: 'Brief sent to Builder.', at: minutes(30) },
    { id: 'c2', from: 'Builder', text: 'Found it in the tile cache. Fix is committed to the branch, running the tests now.', at: minutes(4) },
  ],
};

// Raw markup: React Native Web encodes a `utf8,` SVG itself, so an encoded one would be encoded twice and draw nothing.
export const sampleImage = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#ffc371"/><stop offset="1" stop-color="#7a3e9d"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/></svg>`;

const changes = {
  branch: 'LH-31-fix-the-lighthouse-map-loading-crash',
  base: 'main',
  commits: [{ sha: 'bbab327', subject: 'Clear the tile cache before a large map loads' }, { sha: 'a41c09e', subject: 'Add a test for loading 200 by 200 maps' }],
  cut: false,
  files: [
    { path: 'apps/lighthouse/src/map/tiles.ts', added: 8, removed: 3, binary: false, patch: '@@ -41,6 +41,11 @@ export function loadMap(size: number) {\n   const cache = tileCache();\n-  cache.reserve(size);\n+  cache.clear();\n+  cache.reserve(size * size);\n   return build(cache);\n }\n' },
    { path: 'apps/lighthouse/tests/map.test.ts', added: 34, removed: 0, binary: false, patch: "@@ -0,0 +1,3 @@\n+test('a large map loads after a save', () => {\n+  assert.ok(loadMap(200));\n+});\n" },
    { path: 'apps/lighthouse/public/map.png', added: 0, removed: 0, binary: true, patch: '' },
  ],
};

const now = Math.floor(Date.now() / 1000);
const hours = (n: number) => now + Math.round(n * 3600);
const models = {
  health: { tone: 'warn', text: `Mostly fine: 7 of 12 free models answer (1 not checked yet), 4 set aside, Codex is out until ${new Date(hours(7) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, Antigravity is used up, Lead on Sonnet 5.5.`, at: now },
  bots: [
    { id: 'lead', name: 'Lead', status: 'idle', label: 'Sonnet 5.5', where: 'Claude', free: false, ...looks.lead },
    { id: 'builder', name: 'Builder', status: 'running', label: 'DeepSeek V4.1 Flash, free', where: 'free', free: true, ...looks.builder },
    { id: 'checker', name: 'Checker', status: 'running', label: 'Nemotron 3.5 Super VL, free', where: 'free', free: true, ...looks.checker },
    { id: 'reviewer', name: 'Reviewer', status: 'paused', label: 'Opus 5.5', where: 'Claude', free: false, ...looks.reviewer },
  ],
  subscriptions: {
    claude: { week: 0.7, resets: hours(83) },
    codex: { week: 1, fiveHours: 0, resets: hours(83), fiveHoursResets: null },
    backup: { until: hours(83) },
    thinking: { on: 'gemini', since: hours(-11), back: hours(83), onClaude: ['Lead'] },
    antigravityUsedUp: ['Gemini 3.8 Flash High', 'Opus 4.6 Thinking', 'Sonnet 4.6', 'Gemini 3.8 Flash Medium', 'Gemini 3.8 Flash Low', 'GPT OSS 120B Medium'].map((label) => ({ label, until: hours(100) })),
  },
  free: [
    { label: 'DeepSeek V4.1 Flash, free', family: 'deepseek', tier: 'strong', state: 'answering', checkedAt: hours(-0.05), pass: 4, fail: 1 },
    { label: 'Nemotron 3.5 Super VL, free', family: 'nemotron', tier: 'strong', state: 'answering', checkedAt: hours(-6.7), pass: 2, fail: 0 },
    { label: 'Nemotron 3 Ultra 550B A55B via NVIDIA', family: 'nemotron', tier: 'strong', state: 'answering', checkedAt: hours(-2) },
    { label: 'North Mini Code, free via OpenRouter', family: 'cohere', tier: 'strong', state: 'answering', checkedAt: hours(-9) },
    { label: 'MiniMax M3.1 Flash, free', family: 'minimax', tier: 'strong', found: true, state: 'answering', checkedAt: hours(-3) },
    { label: 'Flint 40B, free', family: 'flint', tier: 'light', state: 'answering', checkedAt: hours(-1) },
    { label: 'Beam, free', family: 'beam', tier: 'light', demoted: true, state: 'answering', checkedAt: hours(-4), pass: 1, fail: 3 },
    { label: 'Iceman, free', family: 'iceman', tier: 'light', state: 'unchecked' },
    { label: 'GLM 5.3 Flash, free', family: 'glm', tier: 'strong', state: 'aside', until: hours(0.6), why: 'did not answer' },
    { label: 'LongCat 2.5, free', family: 'longcat', tier: 'strong', state: 'aside', until: hours(0.7), why: 'did not answer' },
    { label: 'MiMo V2.6 Flash, free', family: 'mimo', tier: 'strong', state: 'aside', until: hours(0.8), why: 'did not answer: its free limit, or the offer ended' },
    { label: 'Nemotron 3.5 Lightning, free', family: 'nemotron', tier: 'light', state: 'aside', until: hours(0.9), why: 'did not answer' },
  ],
  freeListError: null,
  switches: [
    { at: hours(-5.8), text: 'Builder moved from Nemotron 3.5 Super VL, free to DeepSeek V4.1 Flash, free' },
    { at: hours(-6.7), text: 'Builder moved from DeepSeek V4.1 Flash, free to Nemotron 3.5 Super VL, free' },
    { at: hours(-7.6), text: 'Builder moved from Nemotron 3.5 Super VL, free to DeepSeek V4.1 Flash, free' },
    { at: hours(-8.5), text: 'Builder moved from DeepSeek V4.1 Flash, free to Nemotron 3.5 Super VL, free' },
    { at: hours(-11.2), text: 'moved to Antigravity, on cheap Claude: Lead' },
    { at: hours(-11.2), text: 'moved to Antigravity, on cheap Claude: Lead' },
    { at: hours(-43), text: 'moved to Antigravity, on cheap Claude: Lead' },
    { at: hours(-43.1), text: 'moved to Antigravity' },
    { at: hours(-53), text: 'moved to Codex' },
  ],
  scout: [
    { at: hours(-2.6), text: 'Inkling 2 Small, free via OpenRouter: 25/25 in 59s, strong' },
    { at: hours(-2.6), text: 'Flint V1.0, free via OpenRouter: 25/25 in 118s, strong' },
    { at: hours(-2.6), text: 'Gemma 4 31B IT, free via OpenRouter: does not answer now, tried again next run' },
    { at: hours(-2.6), text: 'Gemma 4 26B A4B IT, free via OpenRouter: does not answer now, tried again next run' },
    { at: hours(-2.6), text: 'MiniMax M3.1 Flash, free: 25/25 in 164s, strong' },
  ],
  limits: [
    { provider: 'OpenCode Zen free models', note: 'No key needed. Limits are not published; a model over its limit stops answering until it is tried again an hour later.' },
    { provider: 'OpenRouter free models', note: '1,000 requests a day, shared by every model on the key.' },
    { provider: 'NVIDIA', note: '40 requests a minute on the key.' },
  ],
  at: now,
};

const ago = (n: number) => Date.now() - n * 60_000;
const line = (id: string, ref: string, title: string, project: string, bot: string, stage: string, note: string, steps: string[], late = false) => ({ id, ref, title, project, projectId: project, bot, stage, note, steps, fixes: 0, since: ago(40), late, open: true, at: ago(3) });
const manager = {
  state: '2 bots are working on 2 jobs. 1 thing needs a look.',
  trouble: [{ level: 'bad', text: 'LH-28 is blocked: Reviewer cannot go on' }, { level: 'warn', text: 'LH-33 has been waiting for 95 minutes' }],
  lines: [
    line('j1', 'LH-31', 'Fix the Lighthouse map loading crash', 'Lighthouse', 'Builder', 'build', 'Builder is building, 40 minutes in', ['now', 'wait', 'wait', 'wait', 'wait']),
    line('j2', 'LH-32', 'Check Harbour save files after the patch', 'Harbour', 'Checker', 'check', 'Checker is checking', ['done', 'now', 'wait', 'wait', 'wait']),
    line('j6', 'LH-28', 'Jetty onboarding copy', 'Jetty', 'Reviewer', 'blocked', 'Blocked: Reviewer cannot go on', ['done', 'failed', 'wait', 'wait', 'wait']),
    line('j3', 'LH-33', 'Polish the Jetty settings page', 'Jetty', 'Builder', 'queued', 'Waiting for Builder, 95 minutes', ['queued', 'wait', 'wait', 'wait', 'wait'], true),
    line('j4', 'LH-30', 'Lighthouse timetable readability', 'Lighthouse', 'Reviewer', 'merged', 'Merged, not pushed yet', ['done', 'done', 'done', 'done', 'wait']),
  ],
  bots: crew.map(([id, name, title, status, model], index) => ({
    id, name, title, status, model, ...looks[id], where: model.startsWith('claude') ? 'Claude' : 'Free models', why: status === 'paused' ? 'Paused by hand' : '',
    job: status === 'running' ? { id: index === 2 ? 'j2' : 'j1', ref: index === 2 ? 'LH-32' : 'LH-31', title: index === 2 ? 'Check Harbour save files after the patch' : 'Fix the Lighthouse map loading crash', stage: index === 2 ? 'check' : 'build' } : null,
    last: index % 2 ? null : { id: 'j4', ref: 'LH-30', title: 'Lighthouse timetable readability', at: ago(60 * (index + 1)) },
    projectId: index === 2 ? 'Harbour' : 'Lighthouse', doneToday: (index * 3) % 5,
  })),
  projects: [
    { id: 'Lighthouse', name: 'Lighthouse', running: 1, queued: 0, blocked: 0, doneToday: 4, unpushed: 3, bots: ['Builder'], at: ago(3) },
    { id: 'Harbour', name: 'Harbour', running: 1, queued: 0, blocked: 0, doneToday: 2, unpushed: 0, bots: ['Checker'], at: ago(5) },
    { id: 'Jetty', name: 'Jetty', running: 0, queued: 1, blocked: 1, doneToday: 0, unpushed: 0, bots: [], at: ago(95) },
  ],
  feed: [
    { at: ago(4), kind: 'check', id: 'j4', text: 'Reviewer passed LH-30: Lighthouse timetable readability' },
    { at: ago(12), kind: 'merged', id: 'j4', text: 'LH-30 was merged into Lighthouse' },
    { at: ago(31), kind: 'blocking', id: 'j6', text: 'Reviewer found 2 blocking problems in LH-28' },
    { at: ago(40), kind: 'started', id: 'j1', text: 'Builder started LH-31: Fix the Lighthouse map loading crash' },
    { at: ago(75), kind: 'done', id: 'j5', text: 'Builder finished LH-29: Write the Harbour store text' },
  ],
  needsYou: summary.needsYou,
  at: Date.now(),
};

/** A made-up crew map for the same crew, answered for any window. */
const flowAt = (n: number) => Date.now() - n * 60_000;
const flowEdge = (kind: FlowKind, from: string, to: string, count: number, failed: number, text: string, withJob = true): FlowEdge => ({
  id: `${kind}:${from}>${to}`, kind, from, to, count, failed, last: flowAt(3), lastFailed: failed > 0,
  messages: [{ at: flowAt(3), failed: failed > 0, text, job: withJob ? { id: 'j1', ref: 'LH-31', title: 'Fix the Lighthouse map loading crash' } : null }],
});
const flowBot = (id: string, under: string, status: FlowStatus): FlowBot => {
  const c = crew.find((r) => r[0] === id)!;
  const claude = c[4].startsWith('claude');
  const running = id === 'builder';
  return {
    id, kind: 'bot', name: c[1], title: c[2], role: c[8] as FlowRole, roleName: c[1], look: { colour: c[9] || '#4a9d7a', build: 'round', gear: [], hat: 'none', face: 'calm' },
    reportsTo: id === 'lead' ? null : under, under, model: c[4], engine: claude ? 'Claude' : 'Free models', status, why: status === 'paused' ? 'Paused by hand' : '',
    job: running ? { id: 'j1', ref: 'LH-31', title: 'Fix the Lighthouse map loading crash', stage: 'build', project: 'Lighthouse', projectId: 'Lighthouse' } : null,
    runsToday: 6, failedToday: id === 'builder' ? 1 : 0, week: { tokens: claude ? 900_000 : 400_000, share: claude ? 0.38 : null }, met: 4, notMet: id === 'builder' ? 1 : 0,
  };
};
const flowWaiting = summary.needsYou.filter((n) => (n.kind === 'approval' || n.kind === 'question') && !('archived' in n)).length;
const flow = (window: FlowWindow): Flow => ({
  at: Date.now(), window, since: Date.now() - (window === '7d' ? 7 * 86400_000 : window === '24h' ? 86400_000 : 3600_000), needs: flowWaiting,
  nodes: [
    { id: 'owner', kind: 'owner', name: 'You', role: 'owner', roleName: 'Owner', needs: flowWaiting },
    flowBot('lead', 'owner', 'free'), flowBot('builder', 'lead', 'working'), flowBot('checker', 'lead', 'working'), flowBot('reviewer', 'lead', 'paused'),
    { id: 'script:review-guard', kind: 'script', name: 'Review guard', role: 'script', roleName: 'Script', notices: 2, last: flowAt(20) },
  ],
  edges: [
    flowEdge('brief', 'lead', 'builder', 3, 0, 'Fix the map loading crash'),
    flowEdge('report', 'builder', 'lead', 2, 0, 'Fix is committed, tests are running'),
    flowEdge('check', 'builder', 'checker', 2, 0, 'Please check the map loader'),
    flowEdge('verdict', 'checker', 'builder', 2, 1, 'Fail: the crash is still there on large maps'),
    flowEdge('check', 'builder', 'reviewer', 1, 0, 'Ready for review'),
    flowEdge('verdict', 'reviewer', 'builder', 1, 0, 'Pass, with two notes'),
    flowEdge('card', 'lead', 'owner', 1, 0, 'Which map size should ship?'),
    flowEdge('order', 'owner', 'lead', 2, 0, 'Ship the Lighthouse map first', false),
    flowEdge('notice', 'script:review-guard', 'builder', 2, 0, 'Review is still open on LH-30'),
    flowEdge('wait', 'builder', 'checker', 1, 0, 'Waiting for the checker'),
  ],
  lanes: [{ id: 'Lighthouse', name: 'Lighthouse', rank: 1, open: 2, running: 1, bots: ['builder', 'lead'] }, { id: 'Harbour', name: 'Harbour', rank: 2, open: 1, running: 1, bots: ['checker'] }],
  kinds: [
    ['order', 'Order', 'You tell the lead what to do'], ['brief', 'Brief', 'The lead hands a job to a bot'], ['report', 'Report', 'A bot tells the lead what it did'],
    ['check', 'Check', 'A bot asks for a check'], ['verdict', 'Verdict', 'A checker says pass or fail'], ['ask', 'Ask', 'A bot asks a question'],
    ['ruling', 'Ruling', 'A bigger call is made'], ['idea', 'Idea', 'A new idea is sent in'], ['approval', 'Approval', 'You are asked to approve'],
    ['start', 'Start', 'A job is started'], ['card', 'Card', 'A card is sent to you'], ['notice', 'Notice', 'A script raises a notice'], ['wait', 'Wait', 'One job waits for another'],
  ].map(([kind, label, says]) => ({ kind, label, says })),
});

const link = (id: string, ref: string, title: string) => ({ id, ref, title });
const runRow = (id: string, bot: string, status: string, job: ReturnType<typeof link> | null, mins: number, why = '', tokens = 42_000) => ({
  id, bot, botId: bot.toLowerCase(), status, state: { succeeded: 'Done', failed: 'Failed', running: 'Running', timed_out: 'Ran out of time' }[status] ?? status,
  failed: ['failed', 'timed_out'].includes(status), job, at: ago(mins), seconds: 340, tokens, cached: tokens * 4, usd: 0, why,
});
const map = link('j1', 'LH-31', 'Fix the Lighthouse map loading crash');
const saves = link('j2', 'LH-32', 'Check Harbour save files after the patch');
const runs = [
  runRow('u1', 'Builder', 'running', map, 3),
  runRow('u2', 'Builder', 'failed', saves, 18, "A free model's limit was reached", 8_000),
  runRow('u3', 'Checker', 'succeeded', saves, 42),
  runRow('u4', 'Reviewer', 'timed_out', link('j6', 'LH-28', 'Jetty onboarding copy'), 70, 'Ran out of time', 120_000),
  runRow('u5', 'Lead', 'succeeded', null, 90, '', 9_000),
];
const crewBots = {
  bots: [
    { id: 'lead', name: 'Lead', title: 'Hands out the work', status: 'idle', state: 'Free', resting: false, engine: 'Claude', model: 'Sonnet 5.5', why: 'Claude subscription', tokensToday: 210_000, tokensWeek: 1_900_000, waste: null, ...looks.lead },
    { id: 'builder', name: 'Builder', title: 'Builds what a job asks for', status: 'running', state: 'Working', resting: false, engine: 'Free models', model: 'DeepSeek V4.1 Flash, free', why: 'Free models, the best that answers first', tokensToday: 1_200_000, tokensWeek: 6_400_000, waste: { runs: 14, wasted: 6, share: 0.43, flagged: true, causes: [{ text: "A free model's limit was reached", count: 5 }] }, ...looks.builder },
    { id: 'checker', name: 'Checker', title: 'Checks every build before you see it', status: 'running', state: 'Working', resting: false, engine: 'Free models', model: 'Nemotron 3.5 Super VL, free', why: 'Kept off the family that built', tokensToday: 300_000, tokensWeek: 2_100_000, waste: null, ...looks.checker },
    { id: 'reviewer', name: 'Reviewer', title: 'Reviews what the checker passed', status: 'paused', state: 'Paused by hand', resting: false, engine: 'Claude', model: 'Opus 5.5', why: 'Claude subscription', tokensToday: 0, tokensWeek: 0, waste: null, ...looks.reviewer },
  ],
  wasteAt: Date.now() - 20 * 60_000, wasteStale: false, at: Date.now(),
};
const botPage = (id: string) => {
  const bot = crewBots.bots.find((b) => b.id === id) ?? { ...crewBots.bots[1], id };
  return {
    ...bot, restingWhy: bot.resting ? 'Codex ran out' : '', reportsTo: bot.id === 'lead' ? '' : 'Lead', reports: bot.id === 'lead' ? ['Builder', 'Checker', 'Reviewer'] : [], job: bot.status === 'running' ? map : null,
    today: { tokens: bot.tokensToday, cached: 0, cents: 0, runs: 6 }, week: { tokens: bot.tokensWeek, cached: 0, cents: 0, runs: 31 },
    runs: runs.slice(0, 4), sessions: 2, skills: ['engine'], instructions: { file: `${id}.md` },
    revisions: [{ id: 'v1', at: minutes(600), by: 'You or a crew script', what: 'Changed engine settings', detail: 'model Sonnet 5.5 to Opus 5.5' }],
  };
};
const jobRow = (id: string, ref: string, title: string, status: string, state: string, bot: string, project: string, mins: number) => ({ id, ref, title, status, state, priority: 'medium', bot, project, at: ago(mins) });
const jobRows = [
  jobRow('j1', 'LH-31', 'Fix the Lighthouse map loading crash', 'in_progress', 'Working', 'Builder', 'Lighthouse', 3),
  jobRow('j2', 'LH-32', 'Check Harbour save files after the patch', 'in_progress', 'Working', 'Checker', 'Harbour', 5),
  jobRow('j6', 'LH-28', 'Jetty onboarding copy', 'blocked', 'Blocked', 'Reviewer', 'Jetty', 31),
  jobRow('j3', 'LH-33', 'Polish the Jetty settings page', 'todo', 'Waiting', 'Builder', 'Jetty', 95),
  jobRow('j4', 'LH-30', 'Lighthouse timetable readability', 'in_review', 'To review', 'Reviewer', 'Lighthouse', 12),
];
const named = (list: string[]) => list.map((name) => ({ id: name.toLowerCase(), name }));
const jobMore = {
  parent: { ...link('j0', 'LH-20', 'Lighthouse first release'), status: 'in_progress', state: 'Working' },
  children: [{ ...link('j7', 'LH-35', 'Add a loading test for large maps'), status: 'done', state: 'Done' }, { ...link('j8', 'LH-36', 'Clear the tile cache on load'), status: 'in_progress', state: 'Working' }],
  blockedBy: [], blocks: [{ ...link('j4', 'LH-30', 'Lighthouse timetable readability'), status: 'in_review', state: 'To review' }],
  documents: [{ key: 'plan', title: 'Plan', body: '## Plan\n\n1. Find where the tile cache fills\n2. Clear it before a large map loads\n3. Test 200 by 200 maps', trimmed: false, revision: 2, by: 'Builder', at: minutes(20) }],
  files: [{ id: 'f1', name: 'crash-log.txt', kind: 'text', size: 18_000 }],
  products: [],
  runs: runs.slice(0, 3),
  cost: { tokens: 412_000, cached: 1_900_000, cents: 0, runs: 7, seconds: 2400, withSubJobs: true },
};
const ranked = { projects: manager.projects.map((p, i) => ({ ...p, shelved: i === 2 })), ranked: ['Lighthouse', 'Harbour'], shelved: ['Jetty'] };
const projectPage = (id: string) => {
  const counts = manager.projects.find((p) => p.id === id) ?? manager.projects[0];
  return {
    id, name: counts.name, paused: '', shelved: id === 'Jetty', budget: null, counts,
    routines: [{ id: 'r1', title: 'Run the Lighthouse test suite', paused: false, bot: 'Builder', when: 'Every night at 03:00' }],
    spend: { tokens: 3_400_000, runs: 41, cents: 0 },
    done: [jobRow('j5', 'LH-29', 'Write the store text', 'done', 'Done', 'Builder', counts.name, 300)],
    bots: manager.bots.filter((b) => counts.bots.includes(b.name)).map(({ id: botId, name, status, model, why, job, role, look }) => ({ id: botId, name, status, model, why, job, role, look })),
    lines: manager.lines.filter((l) => l.projectId === id),
  };
};
const improvements = {
  items: [
    { id: 'IMP-3', title: 'Check reports name no commit', path: 'crew/review-guard.py', evidence: 'LH-29 and LH-31 reports had no COMMIT line, so the merge card named none.', fix: 'Refuse a report whose last three lines are missing.', who: 'Checker', status: 'new', job: '', added: 1_795_000_000, decidedBy: '', decidedAt: 0, reason: '', history: [] },
    { id: 'IMP-2', title: 'Run logs are read whole', path: 'crew/claude-bot.sh', evidence: 'A 4 MB log was read in one call.', fix: 'Cut it to its errors before reading.', who: 'Lead', status: 'rejected', job: '', added: 1_794_000_000, decidedBy: 'owner', decidedAt: 1_794_900_000, reason: 'Logs are small enough today.', history: [{ by: 'lead', status: 'accepted', at: 1_794_800_000 }] },
    { id: 'IMP-1', title: 'Old briefs stay in the folder', path: 'briefs', evidence: '212 files, 190 older than a month.', fix: 'Move them to old-YYYY-MM.', who: 'Checker', status: 'done', job: 'LH-20', added: 1_793_000_000, decidedBy: 'lead', decidedAt: 1_793_500_000, reason: 'Cheap and safe.', history: [] },
  ],
  counts: { new: 1, ask: 0, accepted: 0, done: 1, rejected: 1, stale: 0 },
  lead: 'Lead',
};
const spend = {
  bots: crewBots.bots.filter((b) => b.tokensWeek).map((b) => ({ id: b.id, name: b.name, engine: b.engine, model: b.model, today: b.tokensToday, tokens: b.tokensWeek, cached: 0, cents: 0, runs: 20, waste: b.waste ? 360_000 : 0 })),
  models: [{ name: 'DeepSeek V4.1 Flash, free', tokens: 6_400_000 }, { name: 'Nemotron 3.5 Super VL, free', tokens: 2_100_000 }, { name: 'Sonnet 5.5', tokens: 1_900_000 }].map((m) => ({ ...m, cached: 0, cents: 0, runs: 10 })),
  providers: [],
  projects: [{ name: 'Lighthouse', tokens: 6_100_000 }, { name: 'Harbour', tokens: 3_300_000 }, { name: 'No project', tokens: 1_200_000 }].map((m) => ({ ...m, cached: 0, cents: 0, runs: 10 })),
  pace: { week: 0.7, cap: 0.9, perHourNow: 0.004, perHourAllowed: 0.0055, resets: Date.now() + 83 * 3600_000, at: Date.now() },
  priced: false, at: Date.now(),
};
const timers = [
  { id: 'health-check', name: 'Health check: tells the lead what is wrong', next: Date.now() + 12 * 60_000, last: Date.now() - 18 * 60_000 },
  { id: 'free-scout', name: 'Looks for new free models and tries each one', next: Date.now() + 3 * 3600_000, last: Date.now() - 3600_000 },
  { id: 'token-guard', name: 'Token guard paces Claude to the weekly reset', next: Date.now() + 40 * 60_000, last: Date.now() - 20 * 60_000 },
];
const library = {
  items: [
    { id: 'a1', kind: 'image', title: 'Lighthouse title screen', file: 'p1', document: '', preview: '', job: map, project: 'Lighthouse', bot: 'Builder', at: minutes(30) },
    { id: 'a2', kind: 'image', title: 'Lighthouse map', file: 'p2', document: '', preview: '', job: map, project: 'Lighthouse', bot: 'Builder', at: minutes(32) },
    { id: 'a3', kind: 'document', title: 'Plan', file: '', document: 'plan', preview: 'Find where the tile cache fills, then clear it before a large map loads.', job: map, project: 'Lighthouse', bot: 'Builder', at: minutes(20) },
    { id: 'a4', kind: 'text', title: 'crash-log.txt', file: 'f1', document: '', preview: '', job: saves, project: 'Harbour', bot: 'Checker', at: minutes(80) },
  ],
  next: '',
};
const company = {
  name: 'Lighthouse Labs', about: 'The tea shop\'s site and its ordering app, built by a bot crew.', code: 'LH',
  members: [{ id: 'm1', name: 'Owner', role: 'owner', active: true, since: minutes(60 * 24 * 40) }],
  invites: [{ id: 'i1', role: 'viewer', expires: new Date(Date.now() + 6 * 86_400_000).toISOString() }],
};

// ── shaping a studio: the crew editor, Setup, the first run, projects, routines ─────────────
// Kept in memory, so the preview answers a change the way the door would until the page is reloaded.

const refuse = (message: string, more: object = {}) => Object.assign(new Error(message), more);
const choices = {
  bosses: [{ id: 'lead', name: 'Lead' }],
  roles: [{ id: 'ceo', name: 'Leads the crew' }, { id: 'engineer', name: 'Builds' }, { id: 'qa', name: 'Checks' }, { id: 'researcher', name: 'Looks things up' }, { id: 'designer', name: 'Designs' }, { id: 'general', name: 'A bit of everything' }],
  efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
  mayNot: [
    { id: 'push', name: 'Push, merge, publish or delete', about: 'Always on. Only you send work out of the studio or delete anything.' },
    { id: 'commit', name: 'Commit', about: 'It may change files, and another bot or you commit them.' },
    { id: 'edit', name: 'Change any file', about: 'It reads and reports only: a checker, a planner.' },
  ],
  ais: [
    { id: 'free', name: 'Free models', about: 'Costs nothing and needs no account. Slower, and each model has a daily limit.', effort: true, turns: false, setup: 'opencode', models: [{ id: 'auto', name: 'The best that answers' }, { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash' }, { id: 'opencode/nemotron-3.5-super-free', name: 'Nemotron 3.5 Super VL' }] },
    { id: 'claude', name: 'Claude', about: 'Your Claude subscription, through Claude Code.', effort: true, turns: true, setup: 'claude', models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }] },
    { id: 'codex', name: 'Codex', about: 'Your ChatGPT subscription, through Codex.', effort: true, turns: false, setup: 'codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }, { id: 'gpt-6-luna', name: 'GPT 6 Luna' }] },
    { id: 'gemini', name: 'Gemini', about: 'Your Google account, through Gemini.', effort: false, turns: false, setup: 'gemini', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
  ],
};
const skillList = [
  { name: 'closing-a-job', about: 'How to hand a job back: what was done, what was checked, what is left', on: true },
  { name: 'writing-tests', about: 'When a change needs a test and how to write one', on: true },
  { name: 'reading-a-diff', about: 'How to check a change line by line', on: false },
];
type SampleBot = Record<string, unknown> & { id: string; name: string; variables: { name: string; secret: boolean; set: boolean }[] };
const teaBot = (id: string, name: string, title: string, does: string, role: string, ai: string, model: string, mayNot: string[], more: object = {}): SampleBot => ({
  id, name, title, does, role, reportsTo: id === 'lead' ? '' : 'lead', paused: false, ai, model, effort: '', minutes: 60, turns: null, atOnce: 1, mayNot, mayNotKept: ai === 'claude',
  skills: { mode: 'set', all: skillList }, variables: [], openJobs: 0, reports: [],
  connectors: [{ id: 'cloudflare', name: 'Cloudflare', level: id === 'builder' ? 'read' : 'off' }], look: looks[id]?.look, ...more,
});
const teaBots: SampleBot[] = [
  teaBot('lead', 'Lead', 'Hands out the work', 'Reads every new job, decides who does it, and asks you when a choice is yours to make.', 'ceo', 'claude', 'sonnet', ['push', 'edit'], { reports: ['Builder', 'Checker', 'Reviewer'], openJobs: 1 }),
  teaBot('builder', 'Builder', 'Builds what a job asks for', 'Writes the code for one job at a time on its own branch, runs the tests, and says what it changed.', 'engineer', 'free', 'opencode/deepseek-v4.1-flash-free', ['push'], { openJobs: 2, minutes: 90, variables: [{ name: 'SHOP_API_KEY', secret: true, set: true }, { name: 'STAGING_URL', secret: false, set: true }] }),
  teaBot('checker', 'Checker', 'Checks every build before you see it', 'Reads each finished build against its job, runs it, and sends back what is wrong. Never changes the code itself.', 'qa', 'free', 'opencode/nemotron-3.5-super-free', ['push', 'edit']),
  teaBot('reviewer', 'Reviewer', 'Reviews what the checker passed', 'Reads the builds the checker passed with a stronger model, and says whether each is good enough to merge.', 'qa', 'claude', 'opus', ['push', 'edit'], { paused: true, effort: 'high', turns: 200 }),
];
const settingsOf = (id: string) => {
  const bot = teaBots.find((b) => b.id === id) ?? teaBots[1];
  return { ...bot, choices: { ...choices, bosses: teaBots.filter((b) => b.id !== bot.id).map(({ id: boss, name }) => ({ id: boss, name })) } };
};
const rules: Record<string, { content: string; history: { id: string; at: string; by: string; bytes: number }[] }> = {};
const rulesOf = (id: string) => {
  const bot = teaBots.find((b) => b.id === id) ?? teaBots[1];
  rules[bot.id] ??= {
    content: `# ${bot.name}\n\nYou are ${bot.name} of Lighthouse Labs. ${bot.does}\n\n## Every run\n\n1. Read the job and its comments before anything else.\n2. Work only on the job's own branch.\n3. Run the tests before you say a job is done.\n4. Close the job with what you did, what you checked and what is left.\n\n## Never\n\n- Push, merge, publish or delete. The owner does those.\n- Guess at a choice that is the owner's: ask on the job instead.\n`,
    history: [{ id: 'h3', at: minutes(35), by: 'You', bytes: 1_480 }, { id: 'h2', at: minutes(60 * 26), by: 'You', bytes: 1_310 }, { id: 'h1', at: minutes(60 * 24 * 6), by: 'The default crew', bytes: 1_120 }],
  };
  return rules[bot.id];
};
const template = (slug: string, bot: SampleBot, needs = '') => ({
  id: `starter/${slug}`, set: 'starter', default: true, setName: 'The default crew', name: bot.name, title: bot.title, does: bot.does, ai: bot.ai, aiName: choices.ais.find((a) => a.id === bot.ai)?.name ?? '', model: bot.model, needs,
  fields: { name: bot.name, title: bot.title, does: bot.does, role: bot.role, ai: bot.ai, model: bot.model, mayNot: bot.mayNot, minutes: bot.minutes, ...(bot.turns ? { turns: bot.turns } : {}), ...(bot.effort ? { effort: bot.effort } : {}) },
});
const newBot = { choices, lead: 'lead', templates: [template('lead', teaBots[0], 'claude'), template('builder', teaBots[1]), template('checker', teaBots[2]), template('reviewer', teaBots[3], 'claude')] };

const setupRows = [
  { id: 'opencode', name: 'OpenCode', kind: 'free', needed: true, state: 'ok', stateWords: 'Ready', what: 'Runs the free models. With it alone a whole crew can work.', detail: 'Version 1.4.2, 9 free models answer', action: null, forget: false },
  { id: 'openrouter', name: 'OpenRouter key', kind: 'free', needed: false, state: 'missing', stateWords: 'No key', what: 'More free models, and 1,000 requests a day shared between them.', detail: '', action: { kind: 'key', label: 'Paste a key', keysPage: 'https://openrouter.ai/keys' }, forget: false },
  { id: 'nvidia', name: 'NVIDIA key', kind: 'free', needed: false, state: 'ok', stateWords: 'Key saved', what: 'The Nemotron family, 40 requests a minute.', detail: 'Saved 3 days ago', action: { kind: 'key', label: 'Replace the key', keysPage: 'https://build.nvidia.com/settings/api-keys' }, forget: true },
  { id: 'claude', name: 'Claude', kind: 'ai', needed: false, state: 'signed-out', stateWords: 'Not signed in', what: 'Your Claude subscription, through Claude Code. Reviewer waits for it.', detail: 'Claude Code 3.1 is installed', action: { kind: 'start', label: 'Sign in', command: 'claude setup-token', here: false }, forget: false },
  { id: 'codex', name: 'Codex', kind: 'ai', needed: false, state: 'missing', stateWords: 'Not installed', what: 'Your ChatGPT subscription, through Codex.', detail: '', action: { kind: 'link', label: 'How to install it', url: 'https://developers.openai.com/codex/cli' }, forget: false },
  { id: 'gemini', name: 'Gemini', kind: 'ai', needed: false, state: 'unknown', stateWords: 'Installed', what: 'Your Google account, through Gemini.', detail: 'Whether it is signed in shows at its first run', action: { kind: 'start', label: 'Sign in', command: 'gemini', here: false }, forget: false },
  { id: 'git', name: 'Git', kind: 'needs', needed: true, state: 'ok', stateWords: 'Ready', what: 'Every job gets its own branch.', detail: 'Version 2.51', action: null, forget: false },
  { id: 'github', name: 'GitHub', kind: 'needs', needed: false, state: 'signed-out', stateWords: 'Not signed in', what: 'For copying a private repository, and for the pushes you approve.', detail: '', action: { kind: 'start', label: 'Sign in', command: 'gh auth login', here: false }, forget: false },
];
const setupState = () => {
  const out = setupRows.filter((r) => r.kind !== 'needs' && r.state !== 'ok').length;
  return { available: true, ready: true, summary: `The studio can run: free models answer and git is ready. ${out} optional things are not set up yet.`, checkedAt: Date.now() - 4 * 60_000, rows: setupRows };
};

const helperJobs = [
  { name: 'health-check', kind: 'script', what: 'Tells the lead what is wrong with the crew', when: 'Every 30 minutes', on: true, ready: true, notReady: '', running: false, lastAt: Date.now() - 18 * 60_000, lastOk: true, lastError: '', nextAt: Date.now() + 12 * 60_000 },
  { name: 'hand-out-work', kind: 'script', what: 'Gives each free bot its next job from the highest project', when: 'Every 5 minutes', on: true, ready: true, notReady: '', running: true, lastAt: Date.now() - 4 * 60_000, lastOk: true, lastError: '', nextAt: Date.now() + 60_000 },
  { name: 'free-scout', kind: 'script', what: 'Looks for new free models and tries each one', when: 'Every day at 05:00', on: true, ready: true, notReady: '', running: false, lastAt: Date.now() - 9 * 3600_000, lastOk: false, lastError: 'OpenRouter did not answer', nextAt: Date.now() + 15 * 3600_000 },
  { name: 'token-guard', kind: 'script', what: 'Paces Claude so it lasts to the weekly reset', when: 'Every hour, on the hour', on: false, ready: false, notReady: 'Waits for Claude to be signed in', running: false, lastAt: null, lastOk: true, lastError: '', nextAt: null },
];
const helpers = { available: true, state: 'on', why: '', jobs: helperJobs };
/** The sample PC's pace: Jog by day, Run at night, set from the phone or the page. */
const pcLoad = { configured: true, levels: ['sprint', 'run', 'jog', 'walk', 'crawl', 'stop'], now: 'jog', day: 'jog', night: 'run', paused: 0, heldGb: 0, label: 'Pace', labelSays: 'How fast the crew works. Sprint ignores the weekly Claude limit; Stop pauses heavy work.', line: 'Jog: a little slower. Up to 4 Claude, 8 free, 3 heavy (day Jog, night Run)', about: [{ id: 'sprint', name: 'Sprint', says: 'Sprint: everything at once, no weekly Claude limit; the week may run out early', numbers: 'Up to 6 Claude, 12 free, 4 heavy', warn: 'The weekly Claude limit is off: the week may run out early.' }, { id: 'run', name: 'Run', says: 'Run: full speed, keeps to the weekly Claude pace', numbers: 'Up to 6 Claude, 10 free, 4 heavy', warn: '' }, { id: 'jog', name: 'Jog', says: 'Jog: a little slower', numbers: 'Up to 4 Claude, 8 free, 3 heavy', warn: '' }, { id: 'walk', name: 'Walk', says: 'Walk: about half speed', numbers: 'Up to 3 Claude, 6 free, 2 heavy', warn: '' }, { id: 'crawl', name: 'Crawl', says: 'Crawl: slowest, the PC stays quiet', numbers: 'Up to 2 Claude, 3 free, 1 heavy', warn: '' }, { id: 'stop', name: 'Stop', says: 'Stop: heavy work paused, no new builds', numbers: '', warn: 'Asks first. Heavy work pauses and no new build starts until you press Resume or pick another pace.' }] };
const loadNames: Record<string, string> = { sprint: 'Sprint', run: 'Run', jog: 'Jog', walk: 'Walk', crawl: 'Crawl', stop: 'Stop' };
function pcLoadLine() {
  if (pcLoad.now === 'stop') return `Stop: ${pcLoad.paused} job${pcLoad.paused === 1 ? '' : 's'} paused${pcLoad.heldGb ? `, ${pcLoad.heldGb} GB held` : ''}`;
  const about = pcLoad.about.find((a) => a.id === pcLoad.now);
  return `${about ? [about.says, about.numbers].filter(Boolean).join('. ') : loadNames[pcLoad.now]}${pcLoad.day !== pcLoad.night ? ` (day ${loadNames[pcLoad.day]}, night ${loadNames[pcLoad.night]})` : ''}`;
}

const firstNotes = { name: 'Lighthouse Labs', skipped: [] as string[], seen: ['setup'], closed: false, projects: [] as { id: string; name: string }[], job: null as null | { id: string; ref: string; title: string } };
const archived = [{ id: 'old-site', name: 'Old tea site' }];
const firstRun = () => {
  const done: Record<string, boolean> = { name: firstNotes.name !== 'My studio', setup: firstNotes.seen.includes('setup'), crew: teaBots.length > 0, chat: teaBots.length > 0, phone: true, project: firstNotes.projects.length > 0, job: Boolean(firstNotes.job) };
  const steps = ['name', 'setup', 'crew', 'chat', 'project', 'job', 'phone'].map((id) => ({ id, state: done[id] ? 'done' : firstNotes.skipped.includes(id) ? 'skipped' : 'todo' }));
  const left = steps.filter((x) => x.state !== 'done').map((x) => x.id);
  return {
    studio: { id: 'tea', name: firstNotes.name }, steps, step: steps.find((x) => x.state === 'todo')?.id ?? '', left,
    // Add ?first to the web address to have the preview open on the first run, as an empty studio does.
    show: !firstNotes.closed && left.length > 0 && typeof window !== 'undefined' && window.location.search.includes('first'),
    empty: false, crew: teaBots.map(({ id, name, paused }) => ({ id, name, paused: Boolean(paused) })), projects: firstNotes.projects, archived, firstJob: firstNotes.job,
  };
};

const routinePage = (id: string) => {
  const r = routines.find((x) => x.id === id) ?? routines[0];
  return {
    ...r, description: 'Run every test, and open a job for each one that fails with the output that shows why.', botId: 'builder', projectId: r.project, timezone: 'UTC',
    runs: [
      { id: 'rr1', at: minutes(1300), state: 'Done', failed: false, why: '', by: 'On time', job: { id: 'j1', ref: 'LH-31', title: 'Nightly tests: all 212 passed' } },
      { id: 'rr2', at: minutes(2740), state: 'Failed', failed: true, why: "A free model's limit was reached", by: 'On time', job: null },
      { id: 'rr3', at: minutes(4180), state: 'Done', failed: false, why: '', by: 'By hand', job: { id: 'j2', ref: 'LH-27', title: 'Nightly tests: 2 failed in the map loader' } },
    ],
    revisions: [{ id: 'rv1', number: 1, at: minutes(9000), by: 'You or a crew script', title: r.title }],
  };
};
const docRevisions = [
  { id: 'd2', number: 2, at: minutes(20), note: 'Added the test step', by: 'Builder' },
  { id: 'd1', number: 1, at: minutes(95), note: 'First plan', by: 'Builder' },
];

/** Answers the routes that shape a studio; undefined for any other, so the older samples answer. */
function shaping(route: string, method: string, body: Record<string, any> = {}): unknown {
  const get = method === 'GET';
  const bot = /^\/bots\/([^/]+)\/(settings|remove|variables|variables\/remove|instructions|instructions\/restore)$/.exec(route);
  if (route === '/bots/new' && get) return newBot;
  if (route === '/bots/starter') return { ok: true, added: [], already: teaBots.length };
  if (route === '/bots' && !get) {
    if (!String(body.name || '').trim()) throw refuse('A bot needs a name');
    const made = teaBot(`bot-${teaBots.length + 1}`, body.name, body.title || '', body.does || '', body.role || 'general', body.ai || 'free', body.model || 'auto', ['push', ...(body.mayNot?.[0] && body.mayNot[0] !== 'push' ? [body.mayNot[0]] : [])]);
    teaBots.push(made);
    return { id: made.id, name: made.name, paused: body.ai === 'claude', needs: body.ai === 'claude' ? 'claude' : '' };
  }
  if (bot) {
    const [, id, what] = bot;
    const one = teaBots.find((b) => b.id === id) ?? teaBots[1];
    if (what === 'settings' && get) return settingsOf(id);
    if (what === 'settings') {
      const { mayNot, skills, ...rest } = body;
      Object.assign(one, rest, mayNot ? { mayNot: mayNot[0] === 'push' ? ['push'] : ['push', mayNot[0]] } : {});
      if (skills) one.skills = { mode: Array.isArray(skills) ? 'list' : skills, all: skillList.map((k) => ({ ...k, on: Array.isArray(skills) ? skills.includes(k.name) : skills === 'all' || k.on })) };
      return { ok: true, changed: Object.keys(body), moved: Boolean(body.ai) };
    }
    if (what === 'variables') {
      // Like the door, the preview keeps the name and drops the value.
      one.variables = [...one.variables.filter((v) => v.name !== body.name), { name: String(body.name), secret: true, set: true }];
      return { ok: true, variables: one.variables };
    }
    if (what === 'variables/remove') {
      one.variables = one.variables.filter((v) => v.name !== body.name);
      return { ok: true, variables: one.variables };
    }
    if (what === 'remove') {
      teaBots.splice(teaBots.indexOf(one), 1);
      return { ok: true, name: one.name, openJobs: one.openJobs };
    }
    const kept = rulesOf(id);
    if (what === 'instructions' && get) return { file: 'AGENTS.md', managed: true, content: kept.content, revisionId: kept.history[0].id, history: kept.history };
    if (what === 'instructions') kept.content = String(body.content ?? '');
    kept.history = [{ id: `h${kept.history.length + 1}`, at: new Date().toISOString(), by: 'You', bytes: kept.content.length }, ...kept.history];
    return { ok: true };
  }
  if (route === '/setup') {
    const row = setupRows.find((r) => r.id === body.id);
    if (body.action === 'start') throw refuse('A sign-in opens on the computer Botyard runs on. Run the line shown there.');
    if (row && body.action === 'key') Object.assign(row, { state: 'ok', stateWords: 'Key saved', detail: 'Saved just now', forget: true, action: { ...row.action, label: 'Replace the key' } });
    if (row && body.action === 'forget') Object.assign(row, { state: 'missing', stateWords: 'No key', detail: '', forget: false, action: { ...row.action, label: 'Paste a key' } });
    return get || body.action === 'check' ? { ...setupState(), checkedAt: body.action === 'check' ? Date.now() : setupState().checkedAt } : { ok: true, state: setupState() };
  }
  if (route === '/throttle') {
    if (!get && pcLoad.levels.includes(String(body.level))) {
      const level = String(body.level);
      if (body.scope !== 'night') pcLoad.day = level;
      if (body.scope !== 'day') pcLoad.night = level;
      pcLoad.now = pcLoad.day;
      Object.assign(pcLoad, level === 'stop' ? { paused: 2, heldGb: 9.4 } : { paused: 0, heldGb: 0 });
    }
    return { ...pcLoad, line: pcLoadLine() };
  }
  if (route === '/helpers') {
    const one = helperJobs.find((j) => j.name === body.name);
    if (body.action === 'run' && one) Object.assign(one, { running: true });
    else if (one) one.on = body.action === 'on';
    else if (body.action) Object.assign(helpers, { state: body.action, why: body.action === 'off' ? 'you turned it off' : '' });
    return helpers;
  }
  if (route === '/first-run') {
    if (body.action === 'name') firstNotes.name = String(body.name);
    else if (body.mark === 'close') firstNotes.closed = true;
    else if (body.mark === 'skip') firstNotes.skipped.push(body.step);
    else if (body.mark === 'seen') firstNotes.seen.push(body.step);
    else if (body.mark === 'again') firstNotes.skipped = firstNotes.skipped.filter((x) => x !== body.step);
    return firstRun();
  }
  if (route === '/projects' && !get) {
    const where = String(body.folder || body.repo || '');
    // A folder named "new" stands in for one with no git yet, to show the offer to start it.
    if (/new/.test(where) && !body.init) throw refuse(`${where} is not a git repository yet. The crew works in branches, so a project needs one`, { canInit: true });
    const made = { id: 'Lighthouse', name: body.name || where.split('/').filter(Boolean).pop() || 'Project', folder: where };
    firstNotes.projects.push({ id: made.id, name: made.name });
    return made;
  }
  if (/^\/projects\/[^/]+\/(rename|move|archive|restore)$/.test(route)) {
    if (route.endsWith('/move') && /new/.test(String(body.folder)) && !body.init) throw refuse(`${body.folder} is not a git repository yet. The crew works in branches, so a project needs one`, { canInit: true });
    if (route.endsWith('/restore')) archived.splice(0, archived.length, ...archived.filter((p) => !route.includes(`/${p.id}/`)));
    return { ok: true };
  }
  if (route === '/jobs' && !get && !firstNotes.job) firstNotes.job = { id: 'j1', ref: 'LH-34', title: String(body.title || 'Your first job') };
  if (/^\/routines\/[^/]+\/schedule$/.test(route)) return { ok: true, when: 'Saved' };
  if (/^\/routines\/[^/]+\/edit$/.test(route)) return { ok: true };
  if (/^\/routines\/[^/]+$/.test(route) && get) return routinePage(route.split('/')[2]);
  if (/^\/jobs\/[^/]+\/documents\/[^/]+\/revisions$/.test(route)) return { revisions: docRevisions };
  if (/^\/jobs\/[^/]+\/documents\/[^/]+\/restore$/.test(route)) return { ok: true };
  return undefined;
}

/** A job to review in the preview: the bot's last message, the brief, a plan and a picture. */
const reviewSample = {
  jobId: 'j1', ref: 'HAR-15', title: 'Checkout: one page instead of three', chat: false, bot: 'Builder', projectId: null, gate: null,
  pieces: [
    { id: 'message:c1', kind: 'message', ref: 'c1', title: 'Last message from Builder', text: 'Halfway. Address and delivery are on the one page and check as you type.\n\nPayment is next. I have a question for you on a card: it decides how the last step is built.' },
    { id: 'brief', kind: 'brief', ref: '', title: 'The brief', text: 'One page for the whole checkout.\nA first-time buyer pays in under a minute on a phone.' },
    { id: 'document:plan', kind: 'document', ref: 'plan', title: 'Plan', text: '# Checkout on one page\n\n1. Address: postcode first\n2. Delivery: two choices\n3. Payment: the provider\'s form, in place' },
    { id: 'picture:p1', kind: 'picture', ref: 'p1', title: 'checkout-phone.png' },
  ],
};

const bn = (id: string, area: string, kind: 'decision' | 'preference' | 'fact', date: string, title: string, excerpt: string, more: Partial<{ links: string[]; supersededBy: string[]; supersedes: string[]; pinned: boolean; private: boolean; imported: boolean; status: string }> = {}) => ({
  id, path: `${kind}s/${id}.md`, title, date, folder: '', kind, status: more.status ?? 'accepted', supersedes: more.supersedes ?? [], supersededBy: more.supersededBy ?? [], tags: [area],
  private: more.private ?? false, imported: more.imported ?? false, links: more.links ?? [], excerpt, words: 80, area, pinned: more.pinned ?? false,
});
/** A made-up notes vault, the same story as the PC demo's. */
const brainSample = {
  on: true as const, folder: '/demo/brain', name: 'brain', from: '2026-09-02', to: '2026-11-18',
  areas: [{ id: 'life', name: 'life', count: 1, private: true }, { id: 'crew', name: 'crew', count: 3, private: false }, { id: 'shop', name: 'shop', count: 3, private: false }],
  notes: [
    bn('one-shop-one-repo', 'shop', 'decision', '2026-09-02', 'One repo per shop', 'Each client shop lives in its own repository.'),
    bn('weekly-release-train', 'shop', 'decision', '2026-09-05', 'Weekly release train', 'Shops release every Friday together.', { status: 'superseded', supersededBy: ['release-when-green'] }),
    bn('short-briefs', 'crew', 'preference', '2026-09-14', 'Short briefs', 'A brief fits on one screen: goal, done when, first step.'),
    bn('mornings-are-for-making', 'life', 'preference', '2026-10-05', 'Mornings are for making', 'No meetings before noon.', { private: true, imported: true }),
    bn('release-when-green', 'shop', 'decision', '2026-10-14', 'Release when green', 'A shop releases as soon as its checks pass.', { supersedes: ['weekly-release-train'], pinned: true, links: ['weekly-release-train'] }),
    bn('night-builds-on-branches', 'crew', 'decision', '2026-11-10', 'Night builds on branches', 'The crew builds at night on its own branches.', { pinned: true, links: ['short-briefs'] }),
    bn('ask-before-spending', 'crew', 'decision', '2026-11-17', 'Ask before any spend', 'A bot asks on a card before anything costs money.', { links: ['night-builds-on-branches'] }),
  ],
};

/** A page of the studio's own on the phone (src/ownView.ts): made-up store sales, one month at a time. */
function salesView(month: string, product = '', q = '') {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const sold = [8200, 9100, 7600, 10400, 11900, 12400];
  const names = ['May', 'June', 'July', 'August', 'September', 'October'];
  const at = Math.max(0, months.indexOf(month));
  const products = [['Harbour, full game', 0.7], ['Soundtrack', 0.2], ['Art book', 0.1]] as const;
  const one = products.find(([name]) => name === product);
  if (one) {
    // A product opened from the month: its own months, side by side, and its orders.
    const share = one[1];
    const orders = [['Studio licence', 1490], ['Single copy', 149], ['Single copy', 149], ['Gift copy', 149]].filter(([name]) => !q || String(name).toLowerCase().includes(q.toLowerCase()));
    return {
      title: one[0],
      note: 'What it sold. Made-up numbers.',
      blocks: [
        { kind: 'chart', title: 'Sold each month', param: 'month', mark: Math.round(sold.reduce((a, b) => a + b, 0) / sold.length * share), items: months.map((m, i) => ({ label: names[i].slice(0, 3), value: Math.round(sold[i] * share), shown: `${Math.round(sold[i] * share)} kr`, on: i === at, pick: m })) },
        { kind: 'table', title: 'Months side by side', columns: names.map((n) => n.slice(0, 3)), rows: [
          { label: 'Sold', cells: sold.map((x) => `${Math.round(x * share)} kr`) },
          { label: 'Orders', cells: sold.map((x) => String(Math.round((x * share) / 98))) },
          { label: 'Refunds', cells: ['0', '1', '0', '0', '2', '1'], tones: ['', 'warn', '', '', 'bad', 'warn'] },
        ] },
        { kind: 'search', param: 'q', value: q, placeholder: 'Search the orders' },
        { kind: 'rows', title: `Orders in ${names[at]}`, items: orders.map(([name, kr]) => ({ title: String(name), detail: names[at], right: `${kr} kr` })) },
      ],
    };
  }
  return {
    title: 'Sales',
    note: 'What the Harbour store sold. Made-up numbers.',
    blocks: [
      { kind: 'chart', title: 'Sold each month', param: 'month', items: months.map((m, i) => ({ label: names[i].slice(0, 3), value: sold[i], shown: `${sold[i]} kr`, on: i === at, pick: m })) },
      { kind: 'heading', text: `${names[at]} 2026` },
      { kind: 'tiles', items: [
        { label: 'Sold', value: `${sold[at]} kr`, note: at ? `${sold[at] >= sold[at - 1] ? '+' : ''}${Math.round((sold[at] / sold[at - 1] - 1) * 100)}% on the month before` : '', tone: at && sold[at] >= sold[at - 1] ? 'good' : '' },
        { label: 'Orders', value: String(Math.round(sold[at] / 98)) },
        { label: 'Refunds', value: '2', tone: 'warn' },
      ] },
      { kind: 'split', title: 'Where it came from', items: products.map(([name, share]) => ({ label: name, value: sold[at] * share, shown: `${Math.round(sold[at] * share)} kr`, open: { product: name } })) },
      { kind: 'bars', title: 'By product', items: [
        { label: 'Harbour, full game', value: sold[at] * 0.7, shown: `${Math.round(sold[at] * 0.7)} kr`, mark: sold[at] * 0.6, note: 'the line is the usual month', open: { product: 'Harbour, full game' } },
        { label: 'Soundtrack', value: sold[at] * 0.2, shown: `${Math.round(sold[at] * 0.2)} kr`, open: { product: 'Soundtrack' } },
        { label: 'Art book', value: sold[at] * 0.1, shown: `${Math.round(sold[at] * 0.1)} kr`, open: { product: 'Art book' } },
      ] },
      { kind: 'rows', title: 'Biggest orders', items: [
        { title: 'Studio licence', detail: 'Harbour, 10 seats', right: '1 490 kr' },
        { title: 'Bundle', detail: 'Game and soundtrack', right: '249 kr', note: 'Refunded', tone: 'warn' },
      ] },
      { kind: 'actions', items: [{ label: 'Fetch now', call: '/sync', done: 'The store\'s new orders are in.' }] },
      { kind: 'fold', title: 'How these are counted', blocks: [{ kind: 'text', text: 'An order counts on the day it was paid. A refund takes it off the month it was **paid** in.' }] },
    ],
  };
}

export function sample(path: string, method: string, _body?: unknown) {
  const [route] = path.split('?');
  const shaped = shaping(route, method, (_body ?? {}) as Record<string, any>);
  if (shaped !== undefined) return shaped;
  if (route === '/marks/sources') return reviewSample;
  if (route === '/tray' && method === 'GET') return { items: [] };
  if (route === '/tray' && method === 'POST') return { items: [], sent: 0, failed: 0 };
  if (route === '/tray/questions') return { jobId: 'j1', job: 'HAR-15 Checkout: one page instead of three', questions: [{ id: 'q1', kind: 'choice', title: 'How should a buyer pay on the one page?', items: [{ id: 'pay', prompt: 'Which payment form goes on the checkout page?', multiple: false, required: true, options: [{ id: 'in', label: 'The provider\'s form, in the page', hint: 'Fewer steps.' }, { id: 'out', label: 'Send the buyer to the provider\'s page', hint: 'One more step.' }] }] }] };
  if (route === '/marks' && method === 'POST') return { id: 'r1', text: '', verdict: 'back', marks: ((_body as { marks?: unknown[] })?.marks ?? []).map((_, i) => ({ n: i + 1 })), createdAt: new Date().toISOString(), piece: { kind: 'work', title: '' }, jobRef: 'HAR-15', note: '', gate: null };
  if (route === '/marks' && method === 'GET') return { reviews: [] };
  if (route === '/bots') return crewBots;
  if (route.startsWith('/bots/') && method === 'GET') return botPage(route.slice('/bots/'.length));
  if (route === '/runs') return { runs, total: runs.length, page: 0, pages: 1, bots: named(['Lead', 'Builder', 'Checker', 'Reviewer']) };
  if (route.startsWith('/runs/')) return { ...runs[1], model: 'DeepSeek V4.1 Flash, free', started: 'Given a job', trimmed: true, log: [{ kind: 'said', text: 'Reading the save loader first.' }, { kind: 'tool', text: 'bash: npm test -- saves' }, { kind: 'error', text: 'Rate limit exceeded: free-models-per-day' }] };
  if (route === '/activity') return { items: [{ at: ago(4), who: 'Reviewer', what: 'commented on', to: '', job: map, kind: 'commented', times: 3 }, { at: ago(18), who: 'Builder', what: 'had a run fail on', to: '', job: saves, kind: 'failed', run: 'u2', times: 1 }, { at: ago(40), who: 'Lead', what: 'handed on', to: 'Builder', job: map, kind: 'delegated', times: 1 }], total: 3, page: 0, pages: 1, since: null };
  if (route === '/spend') return spend;
  if (route === '/improvements') return improvements;
  if (route === '/own') return { pages: [{ name: 'sales', title: 'Sales', does: 'What the Harbour store sold, by month', phone: true, icon: 'activity' }] };
  if (route === '/own/sales/api/phone') {
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    return salesView(query.get('month') ?? '2026-10', query.get('product') ?? '', query.get('q') ?? '');
  }
  if (route.startsWith('/own/sales/api/') && method === 'POST') return { ok: true };
  if (route === '/brain') return brainSample;
  if (route === '/brain/note') { const id = decodeURIComponent(/id=([^&]+)/.exec(path)?.[1] ?? ''); const n = brainSample.notes.find((x) => x.id === id); return n ? { ...n, meta: {}, text: `# ${n.title}\n\n${n.excerpt}\n\nSee [[${n.links[0] ?? n.id}]].` } : null; }
  if (route.startsWith('/improvements/') && method === 'POST') return { ok: true, jobRef: '' };
  if (route === '/jobs' && method === 'GET') {
    const pile = /pile=(\w+)/.exec(path)?.[1] ?? 'active';
    const rows = pile === 'done' ? [jobRow('j5', 'LH-29', 'Write the Harbour store text', 'done', 'Done', 'Builder', 'Harbour', 300)] : pile === 'backlog' ? [] : jobRows;
    return { jobs: rows, page: 0, more: false, bots: named(['Lead', 'Builder', 'Checker', 'Reviewer']), projects: named(['Lighthouse', 'Harbour', 'Jetty']) };
  }
  if (route.endsWith('/more')) return jobMore;
  if (route === '/projects') return ranked;
  if (route.startsWith('/projects/')) return projectPage(route.slice('/projects/'.length));
  if (route === '/timers') return { timers };
  if (route === '/library') return library;
  if (route === '/company') return company;
  if (path === '/models') return models;
  if (path.endsWith('/changes')) return changes;
  if (path === '/connectors' || route.startsWith('/connectors/')) {
    const cloudflare = { id: 'cloudflare', name: 'Cloudflare', about: 'Use Cloudflare from a bot: look things up and, where you allow it, change them.', address: 'https://mcp.cloudflare.com/mcp', how: 'signin', state: 'ready', stateWords: 'Ready', trouble: '', signedInAt: Date.now() - 3 * 3600_000, checkedAt: Date.now() - 600_000,
      tools: [{ name: 'whoami', about: 'Who is signed in', reads: true, allowed: true }, { name: 'search', about: 'Search the documentation', reads: true, allowed: true }, { name: 'execute', about: 'Run a change on the account', reads: false, allowed: false }], reads: 2, changes: 1,
      bots: [{ id: 'lead', name: 'Lead', level: 'read' }, { id: 'builder', name: 'Builder', level: 'off' }] };
    if (path !== '/connectors') return cloudflare;
    return { connectors: [cloudflare], engines: [
      { id: 'claude', name: 'Claude', for: 'Lead and Reviewer', ok: true, words: "Signed in with the crew's own token, good for a year", fix: '' },
      { id: 'codex', name: 'Codex', for: 'No bot yet', ok: false, words: 'Not signed in', fix: 'In a terminal run `codex login`' },
    ] };
  }
  if (path === '/routines' && method === 'GET') return { routines };
  if (path === '/devices' && method === 'GET') return devices;
  if (path === '/guard') return summary.guard;
  if (path === '/summary') return summary;
  if (path === '/manager') return manager;
  if (route === '/flow') return flow((/window=(now|24h|7d)/.exec(path)?.[1] as FlowWindow | undefined) ?? 'now');
  if (path === '/chats') return { bots: chats };
  if (/^\/chats\/[^/]+\/pictures/.test(path) && method === 'POST') return { id: `shot-${Date.now()}`, name: (_body as { name?: string })?.name || 'picture' };
  if (path.startsWith('/chats/') && method === 'GET') return { ...thread, bot: chats.find((c) => path.endsWith(c.id)) ?? thread.bot };
  if (path.startsWith('/jobs/') && method === 'GET') return detail;
  return { id: 'j1', ref: 'LH-34' };
}
