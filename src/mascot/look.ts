import { BotRole, Look } from '../api';
import { hsl, isHex } from '../theme/color';

/**
 * How a bot is drawn on the phone. The picture comes from what the bot IS in its studio, never from
 * its name: its role, and the look its settings give it (suit colour, hat, build, gear, face), the
 * same words the PC's map draws from. What the look leaves out is filled in from the role.
 */
export type Hat = 'crown' | 'wizard' | 'beret' | 'feelers' | 'hardhat' | 'cog' | 'headphones' | 'tophat' | 'antenna';
export type Build = 'standard' | 'heavy' | 'barrel' | 'slim' | 'robed' | 'curvy' | 'lady' | 'vee';
/** Where a bot's work stands, as the phone shows it. */
export type BotState = 'free' | 'working' | 'waiting' | 'blocked' | 'off';

/** What the owner changed for one bot on this phone only. */
export type OwnLook = { nickname?: string; colour?: string; photo?: string; frame?: 'plate' | 'round' };

export type Portrait = {
  id?: string;
  name: string;
  role: BotRole;
  colour: string;
  hat: Hat;
  build: Build;
  gear: string[];
  /** A light screen with dark eyes, or a dark screen with lit eyes. */
  screen: 'shade' | 'light';
  state: BotState;
  /** The owner's own picture for this bot on this phone, shown in place of the drawing. */
  photo?: string;
  /** What the photo is loaded with: the door's key, for a portrait from the PC. */
  photoHeaders?: Record<string, string>;
  frame: 'plate' | 'round';
};

export const HATS: Hat[] = ['crown', 'wizard', 'beret', 'feelers', 'hardhat', 'cog', 'headphones', 'tophat', 'antenna'];
export const BUILDS: Build[] = ['standard', 'heavy', 'barrel', 'slim', 'robed', 'curvy', 'lady', 'vee'];

/** What a bot of each role wears when its settings do not say. */
const BY_ROLE: Record<BotRole, { hat: Hat; build: Build; colour: string | null; screen: 'shade' | 'light' }> = {
  lead: { hat: 'crown', build: 'standard', colour: '#2b2f38', screen: 'light' },
  builder: { hat: 'hardhat', build: 'barrel', colour: '#2f7cf6', screen: 'shade' },
  checker: { hat: 'feelers', build: 'slim', colour: '#f06fae', screen: 'shade' },
  reviewer: { hat: 'beret', build: 'curvy', colour: '#e2404d', screen: 'shade' },
  ruler: { hat: 'wizard', build: 'robed', colour: '#c49a6c', screen: 'shade' },
  researcher: { hat: 'tophat', build: 'vee', colour: '#f08a1c', screen: 'shade' },
  general: { hat: 'antenna', build: 'standard', colour: null, screen: 'shade' },
};

/** Suit paints offered when the owner picks a colour. */
export const SUIT_COLOURS = ['#2f7cf6', '#2fbf5a', '#f06fae', '#e2404d', '#f08a1c', '#6457e8', '#c49a6c', '#19a7a0', '#d9a514', '#7a8794', '#2b2f38', '#ffb454'];

/** A colour of its own for a bot nobody gave one: the same id always gets the same paint. */
function paintFor(key: string) {
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum = (sum * 31 + key.charCodeAt(i)) % 3600;
  return hsl(sum % 360, 0.62, 0.52);
}

/** The engine's and the door's words for what a bot is doing, as one of ours. */
export function stateOf(status?: string): BotState {
  switch ((status ?? '').toLowerCase()) {
    case 'running': case 'working': case 'busy': case 'active': return 'working';
    case 'queued': case 'waiting': case 'in_review': return 'waiting';
    case 'blocked': case 'error': case 'failed': return 'blocked';
    case 'paused': case 'off': case 'terminated': return 'off';
    default: return 'free';
  }
}

/** In words, for a screen reader and for the tag beside a name. */
export const STATE_WORDS: Record<BotState, string> = { free: 'Free', working: 'Working', waiting: 'Waiting', blocked: 'Blocked', off: 'Off' };

type Known = { id?: string; name: string; role?: BotRole | string; look?: Look; status?: string };

/** A bot's picture: its settings' look first, then its role's, with the owner's own changes on this phone on top. */
/** The portraits the PC shows, by bot id, once the phone has read them through its door. */
let shared: Record<string, { uri: string; headers?: Record<string, string> }> = {};
export function setSharedFaces(faces: typeof shared) {
  shared = faces;
}

export function portraitOf(bot: Known, own?: OwnLook & { color?: string }): Portrait {
  const role = (bot.role && bot.role in BY_ROLE ? bot.role : 'general') as BotRole;
  const base = BY_ROLE[role];
  const look = bot.look ?? {};
  // `color` is how an older version of the app kept the owner's choice on this phone.
  const given = own?.colour ?? own?.color ?? look.colour;
  return {
    id: bot.id,
    name: own?.nickname?.trim() || bot.name,
    role,
    colour: given && isHex(given) ? given : base.colour ?? paintFor(bot.id ?? bot.name),
    hat: HATS.includes(look.hat as Hat) ? (look.hat as Hat) : base.hat,
    build: BUILDS.includes(look.build as Build) ? (look.build as Build) : base.build,
    gear: Array.isArray(look.gear) ? look.gear : [],
    screen: look.face === 'light' || look.face === 'shade' ? look.face : base.screen,
    state: stateOf(bot.status),
    // A photo chosen on this phone wins; else the portrait the PC shows, if the bot has one.
    photo: own?.photo ?? shared[bot.id ?? '']?.uri,
    photoHeaders: own?.photo ? undefined : shared[bot.id ?? '']?.headers,
    frame: own?.frame ?? 'plate',
  };
}
