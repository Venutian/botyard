import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, TextStyle, useColorScheme } from 'react-native';
import { OwnLook } from '../mascot/look';
import { alpha, contrast, inkOn, mix, readable, shiftHue } from './color';
import { FontChoice, FONT_CHOICES, FontId, fontStyle, loadFont, loadSign, signStyle, Weight } from './fonts';
import { LookChoice, Plates, platesFor } from './plates';

const STORE_KEY = 'studio-prefs';
const SAVE_DELAY_MS = 300;
/** A slow font must never hold the app back for long. */
const FONT_WAIT_MS = 1500;

export const WALLPAPERS = ['none', 'dots', 'grid', 'plus', 'diagonal', 'waves', 'stars', 'confetti', 'aurora', 'sunset', 'tide'] as const;
export type WallpaperId = (typeof WALLPAPERS)[number];

/** What the owner changed for one bot on this phone: its picture's own changes, and how its chat behaves. */
export type BotLook = OwnLook & {
  wallpaper?: WallpaperId;
  pinned?: boolean;
  speak?: boolean;
};

export type Room = { id: string; name: string; botIds: string[] };

export type Prefs = {
  /** Day, night, or whichever the phone is on. */
  skin: LookChoice;
  accent: string | null;
  wallpaper: WallpaperId;
  wallpaperStrength: number;
  wallpaperEverywhere: boolean;
  bubbleShape: 'tail' | 'corner' | 'round';
  bubbleRadius: number;
  mineFill: 'skin' | 'accent' | 'gradient' | 'bot' | 'custom';
  mineColor: string;
  botFill: 'card' | 'tint' | 'none';
  spacing: 'tight' | 'normal' | 'airy';
  textScale: number;
  font: FontChoice;
  showTimes: boolean;
  showPreviews: boolean;
  tabLabels: boolean;
  /** Write what each button does under it. Off: the words go to the screen reader only. */
  explain: boolean;
  haptics: boolean;
  notify: boolean;
  prompts: string[];
  rooms: Room[];
  bots: Record<string, BotLook>;
  /** The newest message read in each chat, so a newer one can show as unread. */
  seen: Record<string, string>;
  /** Which of the app's own looks these settings were last moved to: 3 is Plates by day and night only. */
  lookVersion: number;
};

export const DEFAULT_PREFS: Prefs = {
  skin: 'system',
  accent: null,
  wallpaper: 'none',
  wallpaperStrength: 0.5,
  wallpaperEverywhere: false,
  bubbleShape: 'tail',
  bubbleRadius: 12,
  mineFill: 'skin',
  mineColor: '#8057c8',
  botFill: 'card',
  spacing: 'normal',
  textScale: 1,
  font: 'skin',
  showTimes: true,
  showPreviews: true,
  tabLabels: true,
  explain: false,
  haptics: true,
  notify: true,
  prompts: ['Status', 'What is blocked?', 'What should I look at next?'],
  rooms: [],
  bots: {},
  seen: {},
  lookVersion: 3,
};

/** Corner sizes of a plate and of what sits on one. */
export type Corners = { card: number; button: number; chip: number; field: number };
/**
 * What a screen paints with: the plates' colours, plus what is worked out from them. `plates` and
 * `outline` are always true and false now that Plates is the only look; screens still ask.
 */
export type Theme = Plates & { glass: string; hair: number; shadow?: string; r: Corners; plates: true; outline: false };

function themeFor(plates: Plates, accent: string | null): Theme {
  const base: Theme = {
    ...plates,
    plates: true,
    outline: false,
    glass: alpha(plates.raised, 0.94),
    hair: 1,
    // A soft lift under a plate: near and tight, then wide and faint, so it reads as depth, not an outline.
    shadow: plates.dark ? '0px 1px 2px rgba(0,0,0,0.45), 0px 8px 24px rgba(0,0,0,0.35)' : `0px 1px 2px ${alpha(plates.ink, 0.08)}, 0px 8px 24px ${alpha(plates.ink, 0.08)}`,
    r: { card: 18, button: 14, chip: 12, field: 12 },
  };
  if (!accent) return base;
  // Your own paint: what can be pressed and your own messages follow it. A colour that would leave a
  // button's word or a link hard to read is moved just far enough to read, so any colour is safe to pick.
  const surfaces = [plates.app, plates.panel, plates.card, plates.raised, plates.control];
  const ink = inkOn(accent);
  const fill = contrast(accent, ink) >= 4.5 ? accent : readable(accent, [ink], 4.5, ink === '#ffffff' ? '#000000' : '#ffffff');
  return {
    ...base,
    accent: fill,
    accentText: readable(accent, surfaces, 4.5, plates.dark ? '#ffffff' : '#000000'),
    accentInk: ink,
    mine: fill,
    mineInk: ink,
  };
}

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

type Look = {
  p: Prefs;
  t: Theme;
  /** The text style for a weight in the chosen font. */
  font: (weight: Weight) => TextStyle;
  /** The style for a name, a code or a title: the sign face, or the bold body font until it has loaded. */
  sign: () => TextStyle;
  update: (next: Partial<Prefs>) => void;
  updateBot: (id: string, next: BotLook) => void;
  resetBot: (id: string) => void;
  markSeen: (id: string, at: string) => void;
  /** A text code of the whole look, to keep or give to someone. Photos stay on this phone. */
  lookCode: () => string;
  /** Applies a look code. Says false if the code is not one. */
  applyLookCode: (code: string) => boolean;
  surprise: () => void;
  /** Brings back the look from before the last surprise, when there is one. */
  undo: (() => void) | null;
  reset: () => void;
};

const LookContext = createContext<Look | null>(null);

export function useLook() {
  const look = useContext(LookContext);
  if (!look) throw new Error('useLook must be used inside LookProvider');
  return look;
}

export function LookProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [p, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [, setFontsLoaded] = useState(0);
  const [before, setBefore] = useState<Prefs | null>(null);
  const saver = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORE_KEY).catch(() => null);
      let loaded = DEFAULT_PREFS;
      try {
        if (saved) {
          const kept = JSON.parse(saved);
          loaded = { ...DEFAULT_PREFS, ...kept };
          // Settings from before Plates was the only look move to it once, so the phone and the PC share
          // one look. Each bot's own changes and everything else stay.
          if (!(kept.lookVersion >= 2)) loaded = { ...loaded, accent: null, font: 'skin', bubbleRadius: 12 };
          if (!['system', 'day', 'night'].includes(loaded.skin)) loaded = { ...loaded, skin: 'system' };
          if ((loaded.wallpaper as string) === 'mascots') loaded = { ...loaded, wallpaper: 'none' };
          loaded = { ...loaded, lookVersion: 3 };
        }
      } catch {
        // Damaged settings fall back to the defaults instead of blocking the app.
      }
      setPrefs(loaded);
      const first = loaded.font === 'skin' ? platesFor(loaded.skin, false).font : loaded.font;
      await Promise.race([Promise.all([loadFont(first), loadSign()]).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
      setReady(true);
    })();
  }, []);

  const save = useCallback((next: Prefs) => {
    if (saver.current) clearTimeout(saver.current);
    saver.current = setTimeout(() => {
      AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => undefined);
    }, SAVE_DELAY_MS);
  }, []);

  const change = useCallback((make: (current: Prefs) => Prefs) => {
    setPrefs((current) => {
      const next = make(current);
      save(next);
      return next;
    });
  }, [save]);

  const plates = useMemo(() => platesFor(p.skin, scheme === 'light'), [p.skin, scheme]);
  const t = useMemo(() => themeFor(plates, p.accent), [plates, p.accent]);
  const fontId: FontId = p.font === 'skin' ? plates.font : p.font;

  useEffect(() => {
    Promise.all([loadFont(fontId), loadSign()]).then(() => setFontsLoaded((n) => n + 1)).catch(() => undefined);
  }, [fontId]);

  useEffect(() => {
    if (Platform.OS !== 'web') SystemUI.setBackgroundColorAsync(t.app).catch(() => undefined);
  }, [t.app]);

  const value = useMemo<Look>(() => ({
    p,
    t,
    font: (weight) => fontStyle(fontId, weight),
    sign: () => signStyle(fontStyle(fontId, 700)),
    update: (next) => change((current) => ({ ...current, ...next })),
    updateBot: (id, next) => change((current) => ({ ...current, bots: { ...current.bots, [id]: { ...current.bots[id], ...next } } })),
    resetBot: (id) => change((current) => {
      const { [id]: _gone, ...bots } = current.bots;
      return { ...current, bots };
    }),
    markSeen: (id, at) => change((current) => (current.seen[id] === at ? current : { ...current, seen: { ...current.seen, [id]: at } })),
    lookCode: () => {
      const { seen: _seen, rooms: _rooms, prompts: _prompts, bots, ...look } = p;
      const faces = Object.fromEntries(Object.entries(bots).map(([id, { photo: _photo, ...rest }]) => [id, rest]));
      return JSON.stringify({ studioLook: 1, ...look, bots: faces });
    },
    applyLookCode: (code) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(code);
      } catch {
        return false;
      }
      if (parsed?.studioLook !== 1) return false;
      // Only settings this app knows are taken, and each keeps the type of its default.
      const known = Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
        key in DEFAULT_PREFS && !['seen', 'rooms', 'prompts'].includes(key) && typeof value === typeof DEFAULT_PREFS[key as keyof Prefs]));
      change((current) => ({ ...current, ...known, accent: typeof parsed.accent === 'string' ? parsed.accent : null, bots: { ...current.bots, ...(known.bots as Prefs['bots'] ?? {}) } }));
      return true;
    },
    surprise: () => {
      setBefore((kept) => kept ?? p);
      change((current) => {
        const vivid = shiftHue(t.accent, Math.floor(Math.random() * 360));
        return {
          ...current,
          accent: Math.random() < 0.5 ? vivid : null,
          wallpaper: pick(WALLPAPERS),
          wallpaperStrength: 0.3 + Math.random() * 0.5,
          bubbleShape: pick(['tail', 'corner', 'round'] as const),
          bubbleRadius: 12 + Math.floor(Math.random() * 13),
          mineFill: pick(['skin', 'accent', 'gradient', 'bot'] as const),
          botFill: pick(['card', 'tint'] as const),
          font: pick(FONT_CHOICES).id,
        };
      });
    },
    undo: before ? () => {
      change((current) => ({ ...before, bots: current.bots, seen: current.seen }));
      setBefore(null);
    } : null,
    // Reset keeps each bot's look and what has been read: those are not theme settings.
    reset: () => change((current) => ({ ...DEFAULT_PREFS, bots: current.bots, seen: current.seen })),
  }), [p, t, fontId, change, before]);

  if (!ready) return null;
  return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}
