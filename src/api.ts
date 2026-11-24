/** Talks to the studio's phone door. The app never sees the engine directly. */
import { AppState, Platform } from 'react-native';
import { normalizeHost, pickWay, ways, unreachable } from './connection';
import type { Edge, Route, Way } from './connection';
import { readView, viewPath } from './ownView';

export { normalizeHost, wayLabel, ways, unreachable } from './connection';
export type { Edge, Route, Way } from './connection';
/**
 * `host` is the PC on home Wi-Fi. `away` is the same PC through the WireGuard tunnel, and `edge`
 * through Cloudflare, once each is set up. The PC tells the app both.
 */
export type Connection = { host: string; token: string; deviceId?: string; away?: string; edge?: Edge };

/** The job a bot holds in its studio. The app tells bots apart by this, never by their names. */
export type BotRole = 'lead' | 'builder' | 'checker' | 'reviewer' | 'ruler' | 'researcher' | 'general';
/** How the studio draws a bot. `colour` is '#rrggbb'; the phone's mascot uses the colour and leaves the rest to the PC. */
export type Look = { colour?: string; build?: string; gear?: string[]; hat?: string; face?: string };
/** On every bot the door lists. Both are missing on an older door: the bot is then `general`, in a colour picked from its id. */
export type Looked = { role?: BotRole; look?: Look };
export type Bot = Looked & { id: string; name: string; title: string; status: string; model: string; spentCents: number };
export type Job = { id: string; ref: string; title: string; status: string; bot: string; project: string; projectId: string; priority: string; updatedAt: string };
/** `botId` is set on a question a bot asked in its chat: the card opens in that chat (the lead's) or on its page (anyone else's). */
export type NeedsYou = { kind: 'approval' | 'question' | 'blocked' | 'review' | 'failed'; id: string; title: string; detail: string; botId?: string; asks?: { id: string; title: string }[]; key?: string; read?: boolean; archived?: boolean };
export type Project = { id: string; name: string };
export type Usage = { provider: string; window: string; tokens: number; cachedTokens: number };
export type Session = { title: string; harness: string; project: string };
export type Comment = { id: string; from: string; text: string; at: string };
export type QuestionItem = { id: string; prompt: string; multiple: boolean; required: boolean; options: { id: string; label: string; hint: string }[] };
export type Question =
  | { id: string; kind: 'choice'; title: string; items: QuestionItem[] }
  | { id: string; kind: 'confirm'; title: string; prompt: string; accept: string; reject: string };
export type Answer = { questionId: string; optionIds: string[]; otherText?: string };
export type Proof = { id: string; name: string };
export type Preview = { name: string; ok: boolean; commit: string; builtAt: string; errors: number; note: string; url: string };
export type ChangeCounts = { files: number; added: number; removed: number };
export type ChangeFile = { path: string; added: number; removed: number; binary: boolean; patch: string };
export type Changes = { branch: string; base: string; commits: { sha: string; subject: string }[]; files: ChangeFile[]; cut: boolean };
export type Run = { id: string; live: boolean; status: string; bot: string; why: string; at: string };
export type JobDetail = Job & {
  description: string;
  comments: Comment[];
  run: Run | null;
  questions: Question[];
  proof: Proof[];
  previews: Preview[];
  changes: ChangeCounts | null;
};
/** `weekCeiling` and `leadCeiling` are the shares (0 to 1) of Claude's week at which the crew and the lead stop. */
export type Guard = { enabled: boolean; limit: number; tripped: boolean; used: number; weekCeiling: number; leadCeiling: number; /** Projects on the shelf, by name: the lead gives nobody work from them. */ shelved?: string[]; /** The owner's order of the projects, highest first. */ ranked?: string[] };
/** The subscriptions' own weekly shares (0 to 1) and reset times in epoch seconds; null where not known. */
export type Plans = {
  claude: { week: number; resets: number | null } | null;
  codex: { week: number; fiveHours: number | null; resets: number | null; fiveHoursResets: number | null } | null;
  backup: { until: number | null } | null;
} | null;
/** What the Models screen shows: every bot's model, the free models' health, the subscriptions and the last switches. */
export type ModelBot = Looked & { id: string; name: string; status: string; label: string; where: string; free: boolean };
/** Where a free model stands against Claude (the service's CLAUDE_SCALE). */
export type ClaudeChip = { chip: string; tier: 'below' | 'haiku' | 'sonnet' | 'opus' | 'unrated'; from?: 'benchmark' | 'checks'; score?: number; benchmark?: string };
export type FreeModel = {
  claude?: ClaudeChip;
  label: string;
  family: string;
  tier: 'strong' | 'light';
  demoted?: boolean;
  found?: boolean;
  state: 'answering' | 'aside' | 'unchecked';
  checkedAt?: number;
  until?: number;
  why?: string;
  pass?: number;
  fail?: number;
};
export type Switch = { at: number | null; text: string };
export type Models = {
  health: { tone: 'good' | 'warn' | 'bad'; text: string; at: number };
  bots: ModelBot[];
  subscriptions: NonNullable<Plans> & {
    thinking: { on: 'codex' | 'gemini'; since: number | null; back: number | null; onClaude: string[] };
    antigravityUsedUp: { label: string; until: number }[];
  };
  free: FreeModel[];
  freeListError: string | null;
  switches: Switch[];
  scout: Switch[];
  limits: { provider: string; note: string }[];
  at: number;
};
export type DayReport = { finished: { id: string; ref: string; title: string; bot: string; project: string }[]; finishedCount: number; tokens: Usage[] };
/**
 * When a routine runs, as plain choices. `day` is 0 for Sunday to 6 for Saturday; `at` is HH:MM on a
 * 24 hour clock; `cron` is the five-part timetable for anything the choices cannot say.
 */
export type Plan =
  | { kind: 'minutes'; n: number }
  | { kind: 'hours'; n: number }
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  | { kind: 'weekly'; day: number; at: string }
  | { kind: 'cron'; cron: string };
/** `when` is the timetable in words, written by the door, so the phone and the PC say the same. */
export type Routine = { id: string; title: string; paused: boolean; bot: string; project: string; cron: string; when?: string; plan?: Plan | null; nextAt: string | null; lastAt: string | null; lastStatus: string };
export type Device = { id: string; name: string; createdAt: string; lastSeen: string };
export type Away = { address: string; up: boolean; changed: boolean };
export type Devices = { sharedActive: boolean; current: string | null; devices: Device[]; away?: Away | null };
export type Summary = {
  /** Set when the door could not reach the engine and is showing the last answer it had. */
  error?: string;
  company: string;
  bots: Bot[];
  projects: Project[];
  usage: Usage[];
  report: DayReport;
  guard: Guard;
  plans?: Plans;
  needsYou: NeedsYou[];
  running: Job[];
  /** Jobs marked in progress with no run going (an older door leaves it out). */
  stalled?: number;
  queued: Job[];
  finished: Job[];
  sessions: Session[];
  spentCents: number;
  at: number;
};

export type StepState = 'now' | 'failed' | 'queued' | 'done' | 'wait' | 'skipped';
/** One piece of work and how far it is: build, check, the lead's ruling, merged, pushed. */
export type WorkLine = { id: string; ref: string; title: string; project: string; projectId: string; bot: string; stage: string; note: string; steps: StepState[]; fixes: number; since: number; late: boolean; open: boolean; at: number };
export type JobRef = { id: string; ref: string; title: string };
/** One copy of a bot on an AI, when a bot has copies: the engine keeps each as an agent, the lists show one bot. */
export type BotCopy = { id: string; name: string; model: string; where?: string; engine?: string; running: boolean };
export type HeldJob = JobRef & { stage: string; minutes?: number };
export type ManagerBot = Looked & { id: string; name: string; title: string; status: string; model: string; where: string; why: string; job: (JobRef & { stage: string }) | null; jobs?: HeldJob[]; copies?: BotCopy[]; on?: string; last: (JobRef & { at: number }) | null; projectId: string; doneToday: number };
export type ManagerProject = { id: string; name: string; running: number; queued: number; blocked: number; doneToday: number; unpushed: number; bots: string[]; at: number };
export type FeedItem = { at: number; kind: string; id: string; text: string };
/** The manager's view: who is on what, where each piece of work stands, what happened, what is wrong. */
export type Manager = {
  error?: string;
  state: string;
  trouble: { level: 'bad' | 'warn'; text: string }[];
  lines: WorkLine[];
  /** Every pile of jobs with its count; an older door sends none. */
  piles?: Pile[];
  bots: ManagerBot[];
  projects: ManagerProject[];
  feed: FeedItem[];
  needsYou: NeedsYou[];
  at: number;
};

export type LastMessage = { text: string; mine: boolean; at: string };
export type ChatBot = Bot & { lastActiveAt: string | null; lastMessage: LastMessage | null };
/** Who signs a line the service itself puts in a conversation: the app's name, or the older one. */
export const SYSTEM = ['Botyard', 'Studio'];
/** `note`: Botyard's or one of the crew's scripts' words, shown as a note, not as the bot speaking. */
/** A picture sent with a message: on the studio (`id`), or, while it is still going, on this phone (`uri`). */
export type ChatPicture = { id: string; name: string; uri?: string };
export type ChatMessage = { id: string; from: string; mine: boolean; note?: boolean; text: string; at: string; pictures?: ChatPicture[] };
/** A card a bot put in a conversation. One still `pending` carries its `question` when the app can answer it; a `connect` card is finished on the Connectors page. */
export type ChatCard = { service?: string; id: string; at: string; state: 'pending' | 'done' | 'cancelled'; kind: 'choice' | 'confirm' | 'connect' | 'other'; title: string; detail?: string; question?: Question; path?: string };
export type ChatThread = { bot: Looked & { id: string; name: string; title: string }; chatId?: string; working: boolean; messages: ChatMessage[]; cards?: ChatCard[] };

type Bridge = {
  call: (path: string, method: string, body?: unknown) => Promise<{ ok: boolean; data: any; down?: boolean }>;
  image: (path: string) => Promise<string | null>;
  /** On the PC: show one of the window's other parts at this path. */
  open?: (where: 'office', path: string) => void;
  /** How the PC window reaches the door, when it can say (the local door is `home`). */
  via?: () => Promise<Way>;
};

const bridge = () => (globalThis as { studioBridge?: Bridge }).studioBridge;

/** Whether this is the PC window, where the office sits beside the studio. */
export const onPC = () => Boolean(bridge()?.open);

const TIME_LIMIT_MS = 12_000;
const KNOCK_MS = 3_000;
/** How long a way that answered is trusted before it is knocked again, so a dead address is dropped. */
const ROUTE_TTL_MS = 60_000;

class Unreachable extends Error {}

/** A refusal in the door's own words. `canInit` is set when the door offers to start git in the folder that was named. */
export type Refusal = Error & { canInit?: boolean };
const refusal = (data: { error?: string; canInit?: boolean } | null | undefined, fallback: string): Refusal =>
  Object.assign(new Error(data?.error || fallback), data?.canInit === true ? { canInit: true } : {});

/** One request one way. Only a request that never got an answer counts as unreachable. */
async function request<T>(way: Route, token: string, path: string, method: string, body: unknown, limit: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    let res: Response;
    try {
      res = await fetch(`${way.base}/v1${path}`, {
        method,
        headers: { ...way.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Unreachable(err instanceof Error && err.name === 'AbortError' ? 'The studio did not answer in time' : 'Cannot reach the studio');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw refusal(data, `The studio answered ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// Which way answered first, per connection. At home the Wi-Fi address wins; away from home only the
// tunnel or Cloudflare answer. Coming back to the app may mean another network, so it asks again;
// and no way is trusted for longer than ROUTE_TTL_MS, so leaving the house cannot pin a dead one.
const routes = new Map<string, { at: number; found: Promise<Route> }>();
AppState.addEventListener('change', (state) => state === 'active' && routes.clear());

const routeKey = (c: Connection) => `${c.host}|${c.away ?? ''}|${c.edge?.host ?? ''}`;

/**
 * Knocks each way in turn and keeps the first to answer. Each starts after a short head start for
 * the ones before it, or at once when all of those have failed, so traffic stays in the house when
 * it can and through WireGuard before Cloudflare.
 */
function route(c: Connection, fresh = false): Promise<Route> {
  const all = ways(c);
  if (all.length === 1) return Promise.resolve(all[0]);
  const key = routeKey(c);
  const hit = routes.get(key);
  if (!fresh && hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.found;
  // Any answer at all, even a refusal, means the door is there that way.
  const knock = (way: Route) => request(way, c.token, '/hello', 'GET', undefined, KNOCK_MS).then(() => way, (err) => {
    if (err instanceof Unreachable) throw err;
    return way;
  });
  const found = pickWay(all, knock).catch((err) => {
    routes.delete(key);
    throw err;
  });
  routes.set(key, { at: Date.now(), found });
  return found;
}

/**
 * Which way the app reaches the studio now, for the device screen and the connection badge.
 * `fresh` knocks again instead of trusting the last answer, so a badge can say the truth after
 * the link has gone rather than for a minute afterwards.
 */
export async function currentRoute(c: Connection, { fresh = false } = {}): Promise<Way | null> {
  if (Platform.OS === 'web') {
    // The PC window's process carries the calls, so ask it; the plain browser preview has no way.
    const door = bridge();
    if (!door?.via) return null;
    return door.via();
  }
  try {
    return (await route(c, fresh)).name;
  } catch {
    // Say which ways were tried, so the reason is plain.
    throw new Error(unreachable(c));
  }
}

async function call<T>(connection: Connection, path: string, method = 'GET', body?: unknown): Promise<T> {
  if (Platform.OS === 'web') {
    // In the PC window, the app's own process carries the call to the door. A plain browser gets sample data.
    const door = bridge();
    if (!door) return require('./preview').sample(path, method, body) as T;
    const answer = await door.call(path, method, body);
    if (!answer.ok) {
      // The PC window's process carries the call to the door, and it says what went wrong: the
      // door is on this machine there, not somewhere else.
      throw refusal(answer.data, 'Cannot reach the phone door. Check that Botyard is running.');
    }
    return answer.data as T;
  }
  let way: Route;
  try {
    way = await route(connection);
  } catch {
    // No way answered at all, so say which ones were tried instead of waiting on each in turn.
    throw new Error(unreachable(connection));
  }
  try {
    return await request<T>(way, connection.token, path, method, body, TIME_LIMIT_MS);
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    routes.delete(routeKey(connection));
    // The network may have changed under the app. Reading is safe to repeat another way; a change is not.
    const next = method === 'GET' && ways(connection).length > 1 ? await route(connection).catch(() => way) : way;
    if (next.base !== way.base) return request<T>(next, connection.token, path, method, body, TIME_LIMIT_MS).catch((again) => {
      throw again instanceof Unreachable ? new Error(unreachable(connection)) : again;
    });
    throw new Error(err.message === 'Cannot reach the studio' ? unreachable(connection) : err.message);
  }
}

/** Asks the door the other ways to reach it, so the app works away from home with nothing typed in. */
export const hello = (c: Connection) => call<{ away: string | null; edge?: Edge | null }>(c, '/hello');

export const getSummary = (c: Connection) => call<Summary>(c, '/summary');
export const getManager = (c: Connection) => call<Manager>(c, '/manager');

export type FlowWindow = 'now' | '24h' | '7d';
export type FlowKind = 'order' | 'brief' | 'report' | 'check' | 'verdict' | 'ask' | 'ruling' | 'idea' | 'approval' | 'start' | 'card' | 'notice' | 'wait';
export type FlowRole = 'lead' | 'ruler' | 'reviewer' | 'builder' | 'checker' | 'researcher' | 'general';
export type FlowStatus = 'working' | 'waiting' | 'free' | 'resting' | 'paused' | 'error';
export type FlowOwner = { id: 'owner'; kind: 'owner'; name: string; role: 'owner'; roleName: string; needs: number };
export type FlowBot = {
  id: string; kind: 'bot'; name: string; title: string; role: FlowRole; roleName: string;
  look: { colour: string; build: string; gear: string[]; hat: string; face: string };
  reportsTo: string | null; under: string; model: string; engine: string; status: FlowStatus; why: string;
  job: null | { id: string; ref: string; title: string; stage: string; project: string; projectId: string };
  /** Every job it holds now (an older door sends none). */
  jobs?: { id: string; ref: string; title: string; stage: string; project: string; projectId: string }[];
  /** Its copies on other AIs, and the AI the running one is on (set only for a bot with copies). */
  copies?: BotCopy[]; on?: string;
  runsToday: number; failedToday: number; week: { tokens: number; share: number | null }; met: number; notMet: number;
};
export type FlowScript = { id: string; kind: 'script'; name: string; role: 'script'; roleName: string; notices: number; last: number };
export type FlowNode = FlowOwner | FlowBot | FlowScript;
export type FlowEdge = {
  id: string; kind: FlowKind; from: string; to: string; count: number; failed: number; last: number; lastFailed: boolean;
  messages: { at: number; failed: boolean; text: string; job: null | { id: string; ref: string; title: string } }[];
};
/** The crew map: who leads, who reports to whom, and the typed message lines between them. */
export type Flow = {
  at: number; window: FlowWindow; since: number; needs: number; nodes: FlowNode[]; edges: FlowEdge[];
  lanes: { id: string; name: string; rank: number; open: number; running: number; bots: string[] }[];
  kinds: { kind: string; label: string; says: string }[];
};
/** The crew map, or null when the studio does not have one yet: the phone then draws the plain crew. */
export async function getFlow(c: Connection, window: FlowWindow): Promise<Flow | null> {
  try {
    const flow = await call<Flow>(c, `/flow?window=${window}`);
    return flow && Array.isArray(flow.nodes) && Array.isArray(flow.edges) ? flow : null;
  } catch {
    return null;
  }
}
export const getJob = (c: Connection, id: string) => call<JobDetail>(c, `/jobs/${id}`);
export const getRoutines = (c: Connection) => call<{ routines: Routine[] }>(c, '/routines');
export const getModels = (c: Connection) => call<Models>(c, '/models');

// ── launch: every product on every channel, read from the channels (docs/launch.md) ──
export type LaunchCell = { state: string; tone: 'ok' | 'go' | 'look' | 'bad' | 'wait'; how: 'read' | 'told' | 'none'; version: string; detail: string; waits: string; next: string; checkedAt?: number; by?: string };
export type LaunchRow = {
  canRelease?: boolean; release?: { job: string; status: string; tripId: string; step: string; waits: boolean; tripStatus: string; cost: number } | null;
  name: string; project: string; kind: string; note: string; first: boolean; cells: Record<string, LaunchCell | null>;
  next: { channel: string; text: string; waits: string } | null;
  readiness: { group: string; text: string; state: 'pass' | 'fail' | 'unknown' | 'yours'; detail: string }[];
  history: { at: number; channel: string; from: string; to: string; how: string; by?: string }[];
};
export type LaunchBoard = { channels: { id: string; name: string }[]; rows: LaunchRow[]; checkedAt: number; stale: boolean; planFound: boolean; planFile: string };
export const getLaunch = (c: Connection) => call<LaunchBoard>(c, '/launch');
export const launchAction = (c: Connection, body: { action: 'check' } | { action: 'tell'; product: string; channel: string; state: string } | { action: 'release'; product: string }) => call<LaunchBoard>(c, '/launch', 'POST', body);

// ── tracks: how each request moves, and the owner's hand on a trip (docs/tracks.md) ──
export type TrackStep = { id: string; kind: 'bot' | 'script' | 'gate' | 'track'; title: string; bot?: string; ruling?: boolean; needs: string[]; leaves: string[] };
export type TrackLine = { from: string; to: string; on: 'pass' | 'fail' | 'always'; rounds?: number; then?: string };
export type TrackInfo = { id: string; key: string; title: string; description: string; version: number; builtIn: boolean; steps: TrackStep[]; lines: TrackLine[]; delivers: string };
export type RequestRow = { id: string; job: string; jobId: string; title: string; track: string; status: string; state: string; at: string; tripId: string; tripStatus: string; waitsForOwner: boolean; reason: string; costUsd: number; cost: string; updatedAt: string };
export type TripStep = TrackStep & {
  state: string; tries: number; current: boolean; verdict: string; findings: string; summary: string; leftNames: string[]; left: Record<string, unknown>;
  numbers: Record<string, unknown>; job: string; jobId: string; note: string; handedFindings: string; costUsd: number; cost: string; startedAt: string; finishedAt: string;
};
export type Trip = {
  id: string; status: string; state: string; reason: string; current: string; rounds: Record<string, number>; commit: string;
  track: { key: string; version: number; title: string; delivers: string; main: string }; lines: TrackLine[]; steps: TripStep[]; cost: string; costUsd: number;
  request: RequestRow; gate: { step: string; title: string; ask?: { prompt: string; accept: string; reject: string } | null; backTo: { id: string; title: string }[] } | null;
  can: { pause: boolean; resume: boolean; stop: boolean; rerun: string[] };
};
export type TripAction = 'approve' | 'back' | 'context' | 'rerun' | 'pause' | 'resume' | 'stop';
export const getTracks = (c: Connection) => call<{ tracks: TrackInfo[]; requests: RequestRow[] }>(c, '/tracks');
export const getTrip = (c: Connection, id: string) => call<Trip>(c, `/trips/${encodeURIComponent(id)}`);
export const tripAction = (c: Connection, id: string, action: TripAction, body: { step?: string; to?: string; note?: string } = {}) => call<Trip>(c, `/trips/${encodeURIComponent(id)}/${action}`, 'POST', body);
export type NewRoutine = { title: string; description: string; botId?: string; projectId?: string; plan: Plan; timezone: string };
export const addRoutine = (c: Connection, routine: NewRoutine) => call(c, '/routines', 'POST', routine);
export const routineAction = (c: Connection, id: string, action: 'run' | 'pause' | 'resume' | 'remove') => call(c, `/routines/${id}/${action}`, 'POST', {});
export const setGuard = (c: Connection, guard: Partial<Pick<Guard, 'enabled' | 'limit' | 'weekCeiling' | 'leadCeiling' | 'shelved' | 'ranked'>>) => call<Guard>(c, '/guard', 'POST', guard);
export const getDevices = (c: Connection) => call<Devices>(c, '/devices');
export const claimDevice = (c: Connection, name: string) => call<{ id: string; key: string }>(c, '/devices', 'POST', { name });
export const revokeDevice = (c: Connection, id: string) => call(c, `/devices/${id}/revoke`, 'POST', {});
export const retireSharedKey = (c: Connection) => call(c, '/devices/retire-shared', 'POST', {});
export const getChanges = (c: Connection, id: string) => call<Changes>(c, `/jobs/${id}/changes`);

export const getFaces = (c: Connection) => call<{ faces: Record<string, string> }>(c, '/faces');

/** Where to load a bot's portrait from, the same picture the map shows; null where it cannot be shown. */
export async function faceSource(c: Connection, name: string) {
  if (Platform.OS !== 'web') {
    const way = await route(c).catch(() => ways(c)[0]);
    return { uri: `${way.base}/v1/faces/${encodeURIComponent(name)}`, headers: { ...way.headers, Authorization: `Bearer ${c.token}` } };
  }
  const door = bridge();
  const uri = door ? await door.image(`/faces/${encodeURIComponent(name)}`) : null;
  return uri ? { uri } : null;
}

/** Where to load a screenshot from. On a phone the image loader sends the token itself. */
export async function proofSource(c: Connection, id: string) {
  if (Platform.OS !== 'web') {
    // An image has nowhere to show an error, so it falls back to the first way and simply fails to load.
    const way = await route(c).catch(() => ways(c)[0]);
    return { uri: `${way.base}/v1/proof/${id}`, headers: { ...way.headers, Authorization: `Bearer ${c.token}` } };
  }
  const door = bridge();
  const uri = door ? await door.image(`/proof/${id}`) : require('./preview').sampleImage;
  return uri ? { uri } : null;
}
export type NewJob = { title: string; description: string; projectId?: string; botId?: string; priority: string };
export const addJob = (c: Connection, job: NewJob) => call<{ id: string; ref: string }>(c, '/jobs', 'POST', job);
export const jobAction = (c: Connection, id: string, action: 'stop' | 'cancel' | 'reopen') => call(c, `/jobs/${id}/${action}`, 'POST', {});
export const botAction = (c: Connection, id: string, action: 'pause' | 'resume') => call(c, `/bots/${id}/${action}`, 'POST', {});
export const answerQuestion = (c: Connection, job: string, id: string, answers: Answer[]) => call(c, `/jobs/${job}/questions/${id}/respond`, 'POST', { answers });
export const acceptQuestion = (c: Connection, job: string, id: string) => call(c, `/jobs/${job}/questions/${id}/accept`, 'POST', {});
export const rejectQuestion = (c: Connection, job: string, id: string, reason?: string) => call(c, `/jobs/${job}/questions/${id}/reject`, 'POST', { reason });
export const addComment = (c: Connection, id: string, text: string) => call(c, `/jobs/${id}/comments`, 'POST', { text });
export const getChats = (c: Connection) => call<{ bots: ChatBot[]; error?: string }>(c, '/chats');
export const getChat = (c: Connection, botId: string) => call<ChatThread>(c, `/chats/${botId}`);
export const sendChat = (c: Connection, botId: string, text: string, requestId: string, pictures: string[] = []) =>
  call(c, `/chats/${botId}/messages`, 'POST', { text, requestId, ...(pictures.length ? { pictures } : {}) });

/** What a chat message may carry: the same kinds and size the studio takes. */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MOST_PICTURES = 6;
export const PICTURE_BYTES = 10 * 1024 * 1024;
export type PickedPicture = { uri: string; name: string; type: string; size?: number };

/**
 * A picture for the next chat message, sent as its own bytes before the message names it. On a phone the
 * file goes straight from where the picker left it, so a large screenshot is never read into memory here.
 */
export async function uploadChatPicture(c: Connection, botId: string, picture: PickedPicture): Promise<{ id: string; name: string }> {
  const path = `/chats/${botId}/pictures?name=${encodeURIComponent(picture.name)}`;
  if (Platform.OS === 'web') {
    // The browser preview has no studio: it pretends, so the composer can be tried.
    return require('./preview').sample(path, 'POST', picture) as { id: string; name: string };
  }
  let way: Route;
  try {
    way = await route(c);
  } catch {
    throw new Error(unreachable(c));
  }
  const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  let res: { status: number; body: string };
  try {
    res = await FileSystem.uploadAsync(`${way.base}/v1${path}`, picture.uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { ...way.headers, Authorization: `Bearer ${c.token}`, 'Content-Type': picture.type },
    });
  } catch {
    routes.delete(routeKey(c));
    throw new Error(unreachable(c));
  }
  let data: { id?: string; name?: string; error?: string } | null = null;
  try { data = JSON.parse(res.body); } catch { /* not JSON */ }
  if (res.status < 200 || res.status >= 300 || !data?.id) throw refusal(data, `The studio answered ${res.status}`);
  return { id: data.id, name: data.name || picture.name };
}

/** Identifies one message, so a retry after a dropped connection cannot send it twice. */
export const requestId = () =>
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** Mark "Needs you" cards read or archived; the map on the PC shows the same marks. */
/** Pages of the owner's own on the PC (their own-pages folder): the list, and a page's own calls to its server file. */
/** `phone`: the page's server answers `GET /phone` with a view the app draws (src/ownView.ts). */
export type OwnPage = { name: string; title: string; does: string; phone?: boolean; icon?: string };
export const getOwnPages = (c: Connection) => call<{ pages: OwnPage[] }>(c, '/own');
/** A call to one own page's server file, `/own/<page>/api/...`. A studio's own screens use this. */
export const ownCall = <T>(c: Connection, path: string, method = 'GET', body?: unknown) => {
  if (!/^\/own\/[a-z0-9][a-z0-9-]{0,31}\/api(\/|$)/.test(path)) throw new Error('Not an own page\'s call');
  return call<T>(c, path, method, body);
};
/** A page's phone view, read through `readView` so only what the app knows is drawn. */
export const getOwnView = async (c: Connection, page: string, choices: Record<string, string>) =>
  readView(await ownCall<unknown>(c, `/own/${page}/api${viewPath(choices)}`));
export const markCards = (c: Connection, keys: string[], change: { read?: boolean; archived?: boolean }) =>
  call(c, '/cards', 'POST', { keys, ...change });

export const decide = (c: Connection, id: string, decision: 'approve' | 'reject', note?: string) =>
  call(c, `/approvals/${id}/${decision}`, 'POST', { note });

// ── the map's sections, on the phone ─────────────────────────────────────────────────

export type JobLink = { id: string; ref: string; title: string };
/** One run as a row: who, which job, how it ended and why in plain words, how long, and what it used. */
export type RunRow = { id: string; bot: string; botId: string; status: string; state: string; failed: boolean; job: JobLink | null; at: number | null; seconds: number | null; tokens: number; cached: number; usd: number; why: string };
export type Waste = { runs: number; wasted: number; share: number; flagged: boolean; causes: { text: string; count: number }[] };
export type CrewBot = Looked & { id: string; name: string; title: string; status: string; state: string; resting: boolean; engine: string; model: string; why: string; tokensToday: number; tokensWeek: number; waste: Waste | null; running?: number; copies?: BotCopy[]; on?: string };
export type CrewList = { bots: CrewBot[]; wasteAt: number | null; wasteStale: boolean; at: number };
type Spend = { tokens: number; cached: number; cents: number; runs: number };
export type BotPage = Omit<CrewBot, 'tokensToday' | 'tokensWeek'> & {
  restingWhy: string; reportsTo: string; reports: string[]; job: JobLink | null; today: Spend; week: Spend;
  runs: RunRow[]; sessions: number; skills: string[]; revisions: { id: string; at: string; by: string; what: string; detail: string }[];
  instructions: { file: string } | null;
};
export type RunPage = { runs: RunRow[]; total: number; page: number; pages: number; bots: { id: string; name: string }[] };
export type RunDetail = RunRow & { model: string; started: string; trimmed: boolean; log: { kind: 'said' | 'tool' | 'error' | 'note'; text: string }[] };
export type ActivityItem = { at: number; who: string; what: string; to: string; job: JobLink | null; kind: string; times: number; run?: string };
export type ActivityPage = { items: ActivityItem[]; total: number; page: number; pages: number; since: string | null };
export type SpendLine = { name: string; tokens: number; cached: number; cents: number; runs: number };
export type SpendView = {
  bots: (SpendLine & { id: string; engine: string; model: string; today: number; waste: number })[];
  models: SpendLine[]; providers: SpendLine[]; projects: SpendLine[];
  pace: { week: number; cap: number | null; perHourNow: number; perHourAllowed: number; resets: number | null; at: number | null } | null;
  priced: boolean; at: number;
};
/** The piles jobs are sorted into; 'all' is every one. 'active' and 'done' are the older piles. */
export type JobPile = 'inhand' | 'waiting' | 'backlog' | 'blocked' | 'today' | 'cancelled' | 'all' | 'active' | 'done';
/** A pile with how many jobs it holds now. */
export type Pile = { id: JobPile; name: string; count: number };
export type JobListRow = { id: string; ref: string; title: string; status: string; state: string; priority: string; bot: string; project: string; at: number | null; snippet?: string };
export type JobListPage = { jobs: JobListRow[]; page: number; more: boolean; piles?: Pile[]; bots: { id: string; name: string }[]; projects: { id: string; name: string }[] };
export type LinkedJob = JobLink & { status: string; state: string };
export type JobMore = {
  parent: LinkedJob | null; children: LinkedJob[]; blockedBy: LinkedJob[]; blocks: LinkedJob[];
  documents: { key: string; title: string; body: string; trimmed: boolean; revision: number; by: string; at: string | null }[];
  files: { id: string; name: string; kind: string; size: number }[];
  products: { id: string; title: string; url: string; summary: string }[];
  runs: RunRow[];
  cost: { tokens: number; cached: number; cents: number; runs: number; seconds: number; withSubJobs: boolean } | null;
};
export type RankedProject = ManagerProject & { shelved: boolean };
export type ProjectList = { projects: RankedProject[]; ranked: string[]; shelved: string[] };
/** A project's goal, as the lead reads it from the project: the outcome, how done is proven, what is next. */
export type ProjectGoal = { about: string; goal: string; doneWhen: string; first: string; parked: string; open: string; setBy: string };
/** The lead's newest plan for a project, with its report of the steps. */
export type ProjectPlan = { id: string; ref: string; title: string; status: string; at: string | null; goal: string; doneWhen: string; report: string };
export type ProjectPage = {
  id: string; name: string; paused: string; shelved: boolean;
  goal?: ProjectGoal; plan?: ProjectPlan | null;
  budget: { metric: string; amount: number; used: number; share: number; window: string } | null;
  counts: ManagerProject | null;
  routines: { id: string; title: string; paused: boolean; bot: string; when: string }[];
  spend: { tokens: number; runs: number; cents: number };
  done: JobListRow[];
  bots: (Looked & { id: string; name: string; status: string; model: string; why: string; job: (JobLink & { stage: string }) | null })[];
  lines: WorkLine[];
};
export type Timer = { id: string; name: string; next: number | null; last: number | null };
export type LibraryItem = { id: string; kind: string; title: string; file: string; document: string; preview: string; job: JobLink | null; project: string; bot: string; at: string | null };
export type Company = { name: string; about: string; code: string; members: { id: string; name: string; role: string; active: boolean; since: string | null }[]; invites: { id: string; role: string; expires: string | null }[] };

const query = (params: Record<string, string | number | undefined>) => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== 0).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
export const getBots = (c: Connection) => call<CrewList>(c, '/bots');
export const getBot = (c: Connection, id: string) => call<BotPage>(c, `/bots/${id}`);
export const getRuns = (c: Connection, p: { bot?: string; status?: string; page?: number }) => call<RunPage>(c, `/runs${query(p)}`);
export const getRun = (c: Connection, id: string) => call<RunDetail>(c, `/runs/${id}`);
export const getActivity = (c: Connection, p: { bot?: string; page?: number }) => call<ActivityPage>(c, `/activity${query(p)}`);
export const getSpend = (c: Connection) => call<SpendView>(c, '/spend');
export type ImprovementState = 'new' | 'ask' | 'accepted' | 'done' | 'rejected' | 'stale';
export type Improvement = { id: string; title: string; path: string; evidence: string; fix: string; who: string; status: ImprovementState; job: string; added: number; decidedBy: '' | 'lead' | 'owner'; decidedAt: number; reason: string; history: { by: string; status: string; at: number }[] };
export type ImprovementList = { items: Improvement[]; counts: Record<ImprovementState, number>; lead?: string };
export const getImprovements = (c: Connection) => call<ImprovementList>(c, '/improvements');
export type ImprovementAction = 'accept' | 'reject' | 'ask' | 'send';
/** Your decision on one finding. It always wins over the lead's, and a second decision changes it again. */
export const decideImprovement = (c: Connection, id: string, action: ImprovementAction, reason = '') =>
  call<{ ok: boolean; jobRef: string }>(c, `/improvements/${id}`, 'POST', { action, reason });
export const getJobs = (c: Connection, p: { pile?: JobPile; project?: string; bot?: string; q?: string; page?: number }) => call<JobListPage>(c, `/jobs${query(p)}`);
export const getJobMore = (c: Connection, id: string) => call<JobMore>(c, `/jobs/${id}/more`);
export const getProjects = (c: Connection) => call<ProjectList>(c, '/projects');
export const getProject = (c: Connection, id: string) => call<ProjectPage>(c, `/projects/${id}`);
export const setGoal = (c: Connection, id: string, goal: Pick<ProjectGoal, 'about' | 'goal' | 'doneWhen' | 'first' | 'parked'> & { tell: boolean }) =>
  call<{ ok: boolean; changed: boolean; told?: boolean; goal: ProjectGoal }>(c, `/projects/${id}/goal`, 'POST', goal);
export const getTimers = (c: Connection) => call<{ timers: Timer[] }>(c, '/timers');
export const getLibrary = (c: Connection, cursor = '') => call<{ items: LibraryItem[]; next: string }>(c, `/library${query({ cursor })}`);
export const getCompany = (c: Connection) => call<Company>(c, '/company');

/** A service the crew may use. Its keys stay on the PC; the phone sees its state, its tools and who may use it. */
export type Connector = {
  id: string; name: string; about: string; address: string; how: 'signin' | 'key' | 'open';
  state: 'ready' | 'signed-out' | 'signing-in' | 'trouble'; stateWords: string; trouble: string; signedInAt: number; checkedAt: number;
  tools: { name: string; about: string; reads: boolean; allowed: boolean }[]; reads: number; changes: number;
  bots: { id: string; name: string; level: 'off' | 'read' | 'write' }[];
  /** The owner's own account (a change waits for a yes on a card) or a business's the bots may act in. */
  owner?: 'own' | 'business';
};
export type EngineSignIn = { id: string; name: string; for: string; ok: boolean; words: string; fix: string };
export const getConnectors = (c: Connection) => call<{ connectors: Connector[]; engines: EngineSignIn[] }>(c, '/connectors');
export const setConnectorAccess = (c: Connection, id: string, change: { bots?: Record<string, string>; writes?: string[]; owner?: 'own' | 'business' }) => call<Connector>(c, `/connectors/${id}/access`, 'POST', change);
export const checkConnector = (c: Connection, id: string) => call<Connector>(c, `/connectors/${id}/check`, 'POST', {});
/** Settles a bot's request for a service: connected on the PC, or no. */
export const settleConnectCard = (c: Connection, card: string, connected: boolean, service?: string) => call(c, `/connect-cards/${card}`, 'POST', { connected, service });

// ── shaping a studio from the phone: the crew editor, Setup, the first run, projects, routines ──

export type Named = { id: string; name: string };
/** One AI a bot can run on: whether it takes an effort and a turn limit, its models, and its row in Setup. */
export type AiChoice = { id: string; name: string; about: string; effort: boolean; turns: boolean; setup: string; models: Named[] };
export type BotChoices = { bosses: Named[]; roles: Named[]; efforts: Named[]; mayNot: (Named & { about: string })[]; ais: AiChoice[] };
/** A bot's own settings. `mayNot` is ['push'], ['push','commit'] or ['push','edit']: the last one is the choice. */
export type BotFields = {
  name: string; title: string; does: string; role: string; reportsTo: string; ai: string; model: string; effort: string;
  minutes: number; turns: number | null; atOnce: number; mayNot: string[];
};
export type BotSkills = { mode: 'set' | 'all' | 'list'; all: { name: string; about: string; on: boolean }[] };
export type BotSettings = BotFields & {
  id: string; paused: boolean; mayNotKept: boolean; skills: BotSkills | null; look?: Look;
  /** A variable's value never leaves the PC: the phone sees its name and that it is set. */
  variables: { name: string; secret: boolean; set: boolean }[];
  openJobs: number; reports: string[]; connectors: { id: string; name: string; level: 'off' | 'read' | 'write' }[]; choices: BotChoices;
};
/** Only the fields that changed. A new `ai` always comes with its `model`. */
export type BotChange = Partial<Omit<BotFields, 'mayNot'>> & { mayNot?: string[]; skills?: 'set' | 'all' | string[] };
export type BotInstructions = { file: string; managed: boolean; content: string; revisionId: string | null; history: { id: string; at: string; by: string; bytes: number }[] };
export type BotTemplate = { id: string; set: string; setName: string; default?: boolean; name: string; title: string; does: string; ai: string; aiName: string; model: string; needs: string; fields: Partial<BotFields> };
export type NewBotChoices = { choices: BotChoices; lead: string; templates: BotTemplate[] };
export type AddedBot = { id: string; name: string; paused: boolean; needs: string };

export const getBotSettings = (c: Connection, id: string) => call<BotSettings>(c, `/bots/${id}/settings`);
export const saveBotSettings = (c: Connection, id: string, change: BotChange) => call<{ ok: boolean; changed: string[] | boolean; moved?: boolean }>(c, `/bots/${id}/settings`, 'POST', change);
/** The value is sent once and never comes back: no answer carries it. */
export const setBotVariable = (c: Connection, id: string, name: string, value: string) => call<{ ok: boolean; variables: BotSettings['variables'] }>(c, `/bots/${id}/variables`, 'POST', { name, value });
export const removeBotVariable = (c: Connection, id: string, name: string) => call<{ ok: boolean; variables?: BotSettings['variables'] }>(c, `/bots/${id}/variables/remove`, 'POST', { name });
export const removeBot = (c: Connection, id: string) => call<{ ok: boolean; name: string; openJobs: number }>(c, `/bots/${id}/remove`, 'POST', {});
export const getBotInstructions = (c: Connection, id: string) => call<BotInstructions>(c, `/bots/${id}/instructions`);
export const saveBotInstructions = (c: Connection, id: string, content: string, base: string | null) => call(c, `/bots/${id}/instructions`, 'POST', { content, base });
export const restoreBotInstructions = (c: Connection, id: string, revision: string, base: string | null) => call(c, `/bots/${id}/instructions/restore`, 'POST', { revision, base });
export const getNewBot = (c: Connection) => call<NewBotChoices>(c, '/bots/new');
export const addBot = (c: Connection, bot: BotChange & { from?: string }) => call<AddedBot>(c, '/bots', 'POST', bot);
export const addStarterCrew = (c: Connection) => call<{ ok: boolean; added: AddedBot[]; already: number | string[] }>(c, '/bots/starter', 'POST', {});

/** One thing a studio needs: what it is for, how it stands, and the one thing to do about it. */
export type SetupRow = {
  id: string; name: string; kind: 'free' | 'ai' | 'needs'; needed: boolean; state: 'ok' | 'missing' | 'signed-out' | 'unknown'; stateWords: string; what: string; detail: string;
  /** `start` cannot be done from a phone: its `command` is run on the computer Botyard runs on. */
  action: null | { kind: 'key' | 'start' | 'link'; label: string; url?: string; command?: string; here?: boolean; keysPage?: string };
  forget: boolean;
};
export type Setup = { available: boolean; ready: boolean; summary: string; checkedAt: number | string | null; rows: SetupRow[] };
export const getSetup = (c: Connection, fresh = false) => call<Setup>(c, `/setup${fresh ? '?fresh=1' : ''}`);
/** A key is sent once, kept on the PC, and never comes back. */
export const saveSetupKey = (c: Connection, id: string, key: string) => call<{ ok: boolean; state: Setup }>(c, '/setup', 'POST', { action: 'key', id, key });
export const forgetSetupKey = (c: Connection, id: string) => call<{ ok: boolean; state?: Setup }>(c, '/setup', 'POST', { action: 'forget', id });
export const checkSetup = (c: Connection) => call<Setup>(c, '/setup', 'POST', { action: 'check' });

/** A small script the service runs for the crew, on its own timetable. */
export type Helper = { name: string; kind: string; what: string; when: string; on: boolean; ready: boolean; notReady: string; running: boolean; lastAt: number | string | null; lastOk: boolean; lastError: string; nextAt: number | string | null };
export type Helpers = { available: boolean; state: 'on' | 'off'; why: string; jobs: Helper[] };
export const getHelpers = (c: Connection) => call<Helpers>(c, '/helpers');
export const helperAction = (c: Connection, action: 'on' | 'off' | 'run', name?: string) => call<Helpers>(c, '/helpers', 'POST', name ? { action, name } : { action });

/** How fast the crew works (its pace). Hidden when the PC names no throttle tool (`configured: false`). */
export type LoadLevel = 'sprint' | 'run' | 'jog' | 'walk' | 'crawl' | 'stop';
/** One pace as the PC describes it: the same words as the page's tooltips. */
export type PaceAbout = { id: LoadLevel; name: string; says: string; numbers: string; warn: string };
export type PcLoad = { configured: boolean; levels: LoadLevel[]; now?: LoadLevel | ''; day?: LoadLevel | ''; night?: LoadLevel | ''; paused?: number; heldGb?: number; line?: string; label?: string; labelSays?: string; about?: PaceAbout[] };
export const getPcLoad = (c: Connection) => call<PcLoad>(c, '/throttle');
/** Set as the owner: the PC writes the change in its log as made from the phone. */
export const setPcLoad = (c: Connection, level: LoadLevel, scope: 'both' | 'day' | 'night' = 'both') => call<PcLoad>(c, '/throttle', 'POST', { level, scope });

export type FirstStep = 'name' | 'setup' | 'crew' | 'chat' | 'project' | 'job' | 'phone';
export type FirstRun = {
  studio: Named; steps: { id: FirstStep; state: 'done' | 'skipped' | 'todo' }[];
  /** The step to show now; empty when none is left. */ step: FirstStep | '';
  /** Whether the app should open the first run by itself. */ show: boolean;
  empty: boolean; left: FirstStep[]; crew: (Named & { paused: boolean })[]; projects: Named[]; archived: Named[]; firstJob: JobLink | null;
  /** The first conversation a bot answered, or the one still waiting on its first answer. */
  chat?: { botId: string; bot: string; answered: boolean; text: string } | null;
  /** The bot to say hello to first. */ greet?: Named | null;
  phones?: number;
};
export const FIRST_STEP_NAMES: Record<FirstStep, string> = { name: 'Name the studio', setup: 'Sign in an AI', crew: 'Pick a crew', chat: 'Say hello to a bot', project: 'Add a project', job: 'Give a first job', phone: 'Pair a phone' };
export const getFirstRun = (c: Connection) => call<FirstRun>(c, '/first-run');
export const nameStudio = (c: Connection, name: string) => call<FirstRun>(c, '/first-run', 'POST', { action: 'name', name });
export const markFirstRun = (c: Connection, mark: { step: FirstStep; mark: 'skip' | 'seen' | 'again' } | { mark: 'close' }) => call<FirstRun>(c, '/first-run', 'POST', mark);

/** A folder already on the PC, or a repository's address to copy there. `init` starts git in a folder that has none. */
export type NewProject = { name?: string; init?: boolean } & ({ folder: string } | { repo: string });
export const addProject = (c: Connection, project: NewProject) => call<{ id: string; name: string; folder: string }>(c, '/projects', 'POST', project);
export const renameProject = (c: Connection, id: string, name: string) => call(c, `/projects/${id}/rename`, 'POST', { name });
export const moveProject = (c: Connection, id: string, folder: string, init = false) => call(c, `/projects/${id}/move`, 'POST', init ? { folder, init: true } : { folder });
export const archiveProject = (c: Connection, id: string) => call(c, `/projects/${id}/archive`, 'POST', {});
export const restoreProject = (c: Connection, id: string) => call(c, `/projects/${id}/restore`, 'POST', {});

export type RoutineRun = { id: string; at: string | null; state: string; failed: boolean; why: string; by: string; job: JobLink | null };
export type RoutinePage = {
  id: string; title: string; description: string; paused: boolean; bot: string; botId: string; project: string; projectId: string;
  cron: string; timezone: string; when: string; plan: Plan | null; nextAt: string | null;
  runs: RoutineRun[]; revisions: { id: string; number: number; at: string; by: string; title: string }[];
};
export const getRoutine = (c: Connection, id: string) => call<RoutinePage>(c, `/routines/${id}`);
export const setRoutineSchedule = (c: Connection, id: string, plan: Plan, timezone: string) => call<{ ok: boolean; when: string }>(c, `/routines/${id}/schedule`, 'POST', { plan, timezone });
export const editRoutine = (c: Connection, id: string, change: { title?: string; description?: string; botId?: string; projectId?: string }) => call(c, `/routines/${id}/edit`, 'POST', change);

export type DocRevision = { id: string; number: number; at: string | null; note: string; by: string };
export const getDocRevisions = (c: Connection, job: string, key: string) => call<{ revisions: DocRevision[] }>(c, `/jobs/${job}/documents/${encodeURIComponent(key)}/revisions`);
export const restoreDoc = (c: Connection, job: string, key: string, revision: string) => call(c, `/jobs/${job}/documents/${encodeURIComponent(key)}/restore`, 'POST', { revision });

// ── reviews: the owner's marks on a bot's work ───────────────────────────────────

export type ReviewPiece = { id: string; kind: 'message' | 'brief' | 'document' | 'picture' | 'change' | 'page'; ref: string; title: string; text?: string; src?: string; at?: string };
export type ReviewGate = { tripId: string; stepId: string; title: string; before: { id: string; title: string; kind: string }[] };
export type ReviewSources = { jobId: string; ref: string; title: string; chat: boolean; bot: string; projectId: string | null; gate: ReviewGate | null; pieces: ReviewPiece[] };
export type DraftMark =
  | { n: number; kind: 'text'; pieceId: string; quote: string; line: number; lineEnd: number; comment: string }
  | { n: number; kind: 'picture'; pieceId: string; box: { x: number; y: number; w: number; h: number }; comment: string };
export type SentReview = { id: string; text: string; verdict: string; marks: { n: number }[]; createdAt: string; piece: { kind: string; title: string }; jobRef: string | null; note: string; gate: { tripId: string } | null; cuts?: string[] };
export type ReviewSend = {
  jobId: string; verdict: 'back' | 'approve'; note: string; piece: { kind: string; ref: string; title: string };
  gate?: { tripId: string; to?: string };
  marks: ({ kind: 'text'; comment: string; piece: { kind: string; ref: string }; quote: string; line: number; lineEnd: number } | { kind: 'picture'; comment: string; piece: { kind: string; ref: string }; attachmentId: string; box: { x: number; y: number; w: number; h: number } })[];
};

/** What can be marked on a job, or in the chat with a bot: the bot's last message first. */
export const getReviewSources = (c: Connection, which: { job?: string; bot?: string }) =>
  call<ReviewSources>(c, `/marks/sources?${which.bot ? `bot=${encodeURIComponent(which.bot)}` : `job=${encodeURIComponent(which.job || '')}`}`);
/** Send every mark as one message to the bot (or as the gate's answer). Only the owner's door can. */
export const sendReview = (c: Connection, review: ReviewSend) => call<SentReview>(c, '/marks', 'POST', review);
/** The kept record: what was approved or sent back, for a job or a project. */
export const getReviews = (c: Connection, which: { job?: string; project?: string }) =>
  call<{ reviews: SentReview[] }>(c, `/marks?${which.job ? `job=${encodeURIComponent(which.job)}` : which.project ? `project=${encodeURIComponent(which.project)}` : ''}`);

// ── the answer tray beside Needs you: answers held to send at once ───────────────

export type TrayQuestion =
  | { id: string; kind: 'choice'; title: string; at?: string; tripId?: string; items: { id: string; prompt: string; multiple: boolean; required: boolean; options: { id: string; label: string; hint: string }[] }[] }
  | { id: string; kind: 'confirm'; title: string; at?: string; prompt: string; accept: string; reject: string; tripId?: string };
export type TrayAnswer = { questionId: string; optionIds: string[]; otherText?: string };
export type TrayItem = {
  key: string; kind: 'answer' | 'accept' | 'reject' | 'review'; jobId: string; cardId?: string; botId?: string; tripId?: string; title: string; job: string;
  answers?: TrayAnswer[]; said?: string; reason?: string; review?: ReviewSend; heldAt: number; error?: string;
};
export type TrayHold = Omit<TrayItem, 'key' | 'heldAt' | 'error'>;
export const getTray = (c: Connection) => call<{ items: TrayItem[] }>(c, '/tray');
export const getTrayQuestions = (c: Connection, which: { job?: string; bot?: string }) =>
  call<{ jobId: string; job: string; questions: TrayQuestion[] }>(c, `/tray/questions?${which.bot ? `bot=${encodeURIComponent(which.bot)}` : `job=${encodeURIComponent(which.job || '')}`}`);
export const holdInTray = (c: Connection, item: TrayHold) => call<{ items: TrayItem[] }>(c, '/tray', 'POST', { action: 'hold', item });
export const dropFromTray = (c: Connection, key: string) => call<{ items: TrayItem[] }>(c, '/tray', 'POST', { action: 'drop', key });
export const sendTrayNow = (c: Connection) => call<{ sent: number; failed: number; items: TrayItem[] }>(c, '/tray', 'POST', { action: 'send' });

// ── Engram: the owner's notes vault, read-only ─────────────────────────────────────────

export type BrainNote = {
  id: string; path: string; title: string; date: string; folder: string;
  kind: 'decision' | 'preference' | 'fact' | 'inbox' | 'note';
  status: string; supersedes: string[]; supersededBy: string[]; tags: string[];
  private: boolean; imported: boolean; links: string[]; excerpt: string; words: number;
  area: string; pinned: boolean;
};
export type BrainArea = { id: string; name: string; count: number; private: boolean };
export type Brain = { on: true; folder: string; name: string; notes: BrainNote[]; areas: BrainArea[]; from: string; to: string } | { on: false; why: string };
export type BrainNoteText = BrainNote & { text: string; meta: Record<string, unknown> };
/** The notes, without their text: what the Engram screen draws. Read-only; editing stays in the files. */
export const getBrain = (c: Connection) => call<Brain>(c, '/brain');
export const getBrainNote = (c: Connection, id: string) => call<BrainNoteText>(c, `/brain/note?id=${encodeURIComponent(id)}`);
