import { FontId } from './fonts';

/**
 * The Plates look, by day and by night: the one identity Botyard has on the PC and on the phone.
 * A screen is a board of sign plates on a dark deck (night) or on primed board (day). Colour is paint:
 * amber for what you can press, green, amber and red for the state of work.
 */
export type PlateId = 'day' | 'night';

export type Plates = {
  id: PlateId;
  name: string;
  dark: boolean;
  /** The body font that goes with the plates. */
  font: FontId;
  /** Behind everything. */
  app: string;
  /** A bar or a sheet that sits on the app. */
  panel: string;
  /** A plate. */
  card: string;
  /** A plate lifted off another plate. */
  raised: string;
  /** A field, a switch's track, a key. */
  control: string;
  /** Where you type a message. */
  composer: string;
  /** A plate's edge, a rule between rows. */
  line: string;
  /** The outline of something you work: a field, a switch that is off, a swatch, a step not reached. At least 3:1 on every surface. */
  edge: string;
  /** Text: main, secondary, quiet. Each is at least 4.5:1 on every surface, the field included. */
  ink: string;
  ink2: string;
  ink3: string;
  /** Paint for what can be pressed, text in that paint, and text on it. */
  accent: string;
  accentText: string;
  accentInk: string;
  /** Paint for the state of work, also read as text: at least 4.5:1 on every surface. */
  good: string;
  warn: string;
  bad: string;
  /** Your own messages in a chat, and the text on them. */
  mine: string;
  mineInk: string;
};

export const NIGHT: Plates = {
  id: 'night',
  name: 'Night',
  dark: true,
  font: 'plex',
  app: '#0b0e13',
  panel: '#10141a',
  card: '#141a22',
  raised: '#1a2029',
  control: '#222a35',
  composer: '#10141a',
  line: '#2a3441',
  edge: '#697380',
  ink: '#eef1f5',
  ink2: '#a3aebb',
  ink3: '#8794a3',
  accent: '#ffb454',
  accentText: '#ffc67d',
  accentInk: '#1d1304',
  good: '#5bd693',
  warn: '#f3b94c',
  bad: '#ff6f61',
  mine: '#ffb454',
  mineInk: '#1d1304',
};

export const DAY: Plates = {
  id: 'day',
  name: 'Day',
  dark: false,
  font: 'plex',
  app: '#ece6da',
  panel: '#f4efe5',
  card: '#fffdf8',
  raised: '#ffffff',
  control: '#e6dece',
  composer: '#fffdf8',
  line: '#d3c9b6',
  edge: '#837d71',
  ink: '#15191f',
  ink2: '#4a5360',
  ink3: '#5b636e',
  accent: '#b26000',
  accentText: '#975000',
  accentInk: '#ffffff',
  good: '#177141',
  warn: '#8b5700',
  bad: '#b53227',
  mine: '#b26000',
  mineInk: '#ffffff',
};

/** What the look setting can say: follow the phone, or stay on one. */
export type LookChoice = 'system' | PlateId;
export const LOOK_CHOICES: { id: LookChoice; name: string }[] = [
  { id: 'system', name: 'Match phone' },
  { id: 'day', name: 'Day' },
  { id: 'night', name: 'Night' },
];

export const platesFor = (choice: string, phoneIsLight: boolean): Plates =>
  choice === 'day' ? DAY : choice === 'night' ? NIGHT : phoneIsLight ? DAY : NIGHT;
