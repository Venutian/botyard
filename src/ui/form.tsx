/** What the screens that shape a studio share: a choice row, a painted note, a small number box, the "when it runs" picker, and the guard that asks before unsaved work is left. */
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, TextStyle, View } from 'react-native';
import { Plan } from '../api';
import { useLook } from '../theme/prefs';
import { ask, tell } from './ask';
import { Icon } from './Icon';
import { Chips, styles as kit, plainField, Txt, useTap } from './kit';

/** Text as a computer writes it: a command, a variable's name, a bot's instructions. */
export const MONO: TextStyle = { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' }) };

// ── leaving a screen with unsaved work ───────────────────────────────────────────────

let guard: { route: string; stop: () => void } | null = null;
/** The app asks this before it steps back from `route`: true means the screen is asking the owner first. */
export const leaving = {
  blocked(route: string | undefined) {
    if (!guard || guard.route !== route) return false;
    guard.stop();
    return true;
  },
  /** Drop the guard, when the screen itself leaves on purpose. */
  clear() {
    guard = null;
  },
};

/** While `dirty`, stepping back from this screen asks first. `back` is the app's own step back. */
export function useLeaveGuard(route: string, dirty: boolean, back: () => void, words: string) {
  const live = useRef(back);
  live.current = back;
  useEffect(() => {
    if (!dirty) return;
    const mine = {
      route,
      stop: () => ask('Leave without saving?', words, 'Leave', () => {
        if (guard === mine) guard = null;
        live.current();
      }, 'Stay here'),
    };
    guard = mine;
    return () => {
      if (guard === mine) guard = null;
    };
  }, [route, dirty, words]);
}

/** Runs one request at a time and says the door's own words when it fails. `busy` names the one running. */
export function useAct() {
  const [busy, setBusy] = useState('');
  const tap = useTap();
  const run = async (key: string, work: () => Promise<unknown>, failed = 'That did not work') => {
    if (busy) return false;
    setBusy(key);
    try {
      await work();
      tap('done');
      return true;
    } catch (err) {
      tell(failed, (err as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };
  return { busy, run };
}

// ── small parts ──────────────────────────────────────────────────────────────────────

/** One of a few choices as a row: a round mark for "one of these", a square one for a switch that is locked on. */
export function Choice({ title, detail, active, locked, right, onPress, last, children }: {
  title: string; detail?: string; active: boolean; locked?: boolean; right?: ReactNode; onPress?: () => void; last?: boolean; children?: ReactNode;
}) {
  const { t } = useLook();
  const tap = useTap();
  // The ring of a choice not picked must show on the plate: light ink by night, dark by day.
  const edge = t.dark ? t.ink2 : t.ink;
  return (
    <Pressable
      accessibilityRole={locked ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: active, disabled: locked }}
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      disabled={locked || !onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.choice, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && kit.dim]}
    >
      <View style={[styles.mark, locked ? styles.square : styles.round, { borderColor: locked ? t.ink3 : edge, backgroundColor: active ? (locked ? t.control : t.accent) : 'transparent' }]}>
        {active ? (locked ? <Icon name="check" size={13} color={t.ink2} weight={3} /> : <View style={[styles.pip, { backgroundColor: t.accentInk }]} />) : null}
      </View>
      <View style={kit.flex}>
        <View style={styles.choiceHead}>
          <Txt size={15} weight={600} style={kit.flex}>{title}</Txt>
          {right}
        </View>
        {detail ? <Txt size={13} color={t.ink2}>{detail}</Txt> : null}
        {children}
      </View>
    </Pressable>
  );
}

/** A line that says how something stands, with a painted bar down its side. */
export function Note({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const { t } = useLook();
  const paint = tone === 'good' ? t.good : tone === 'bad' ? t.bad : t.plates ? '#ffc61a' : t.warn;
  return (
    <View style={[styles.note, { backgroundColor: t.card, borderColor: t.plates && t.dark ? '#05070a' : t.outline ? t.ink : t.line, borderRadius: t.r.field, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth }]}>
      <View style={[styles.noteBar, { backgroundColor: paint }]} />
      <Txt size={14} style={styles.noteText}>{children}</Txt>
    </View>
  );
}

/** A small button of words inside a row. `danger` paints it for something that cannot be undone. */
export function Small({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  const { t } = useLook();
  const tap = useTap();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} hitSlop={6}
      onPress={() => { tap('light'); onPress(); }}
      style={({ pressed }) => [styles.small, { borderColor: danger ? t.bad : t.ink3, borderRadius: t.plates ? t.r.chip : 14, borderWidth: t.plates ? 2 : 1 }, (pressed || disabled) && kit.dim]}>
      <Txt size={13} weight={600} color={danger ? t.bad : t.ink}>{label}</Txt>
    </Pressable>
  );
}

/** A short box for a number or a time, set inside a sentence. */
function Inline({ value, onChangeText, label, width = 58, onFocus, ...rest }: { value: string; onChangeText: (text: string) => void; label: string; width?: number; onFocus?: () => void; placeholder?: string; maxLength?: number; keyboardType?: 'number-pad' | 'numbers-and-punctuation' }) {
  const { t, font } = useLook();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onFocus={onFocus}
      accessibilityLabel={label}
      placeholderTextColor={t.ink3}
      selectTextOnFocus
      {...rest}
      style={[styles.inline, plainField, font(600), { width, backgroundColor: t.control, borderColor: t.edge, borderRadius: t.r.chip, color: t.ink }]}
    />
  );
}

// ── when a routine runs ──────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Monday first, as a week is read; the ids are the day numbers the door takes (0 is Sunday).
const DAY_CHIPS = [1, 2, 3, 4, 5, 6, 0].map((n) => ({ id: String(n), name: DAY_NAMES[n].slice(0, 3) }));
const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/;
const clock = (text: string) => (CLOCK.test(text.trim()) ? text.trim().padStart(5, '0') : text.trim());

/** What is wrong with a plan, in plain words; empty when the door will take it. */
export function planProblem(plan: Plan): string {
  if (plan.kind === 'minutes') return Number.isInteger(plan.n) && plan.n >= 5 && plan.n <= 59 ? '' : 'Pick between 5 and 59 minutes.';
  if (plan.kind === 'hours') return Number.isInteger(plan.n) && plan.n >= 1 && plan.n <= 23 ? '' : 'Pick between 1 and 23 hours.';
  if (plan.kind === 'cron') return plan.cron.trim().split(/\s+/).length === 5 ? '' : 'The timetable needs five parts, with a space between each.';
  return CLOCK.test(plan.at) ? '' : 'Write the time as hours and minutes, like 07:30.';
}

export const START_PLAN: Plan = { kind: 'daily', at: '07:00' };
export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The plain choices of when, one line each, with the five-part form behind "Advanced". It starts on
 * `start` (a new routine: every day at 07:00) and reports the plan it holds on every change.
 */
export function WhenPicker({ start, onChange }: { start?: Plan | null; onChange: (plan: Plan) => void }) {
  const { t } = useLook();
  const first = start ?? START_PLAN;
  const [kind, setKind] = useState<Plan['kind']>(first.kind);
  const [v, setV] = useState({
    minutes: first.kind === 'minutes' ? String(first.n) : '30',
    hours: first.kind === 'hours' ? String(first.n) : '4',
    daily: first.kind === 'daily' ? first.at : '07:00',
    weekdays: first.kind === 'weekdays' ? first.at : '07:00',
    weekly: first.kind === 'weekly' ? first.at : '07:00',
    day: first.kind === 'weekly' ? String(first.day) : '1',
    cron: first.kind === 'cron' ? first.cron : '',
  });
  const [advanced, setAdvanced] = useState(first.kind === 'cron');

  const planOf = (k: Plan['kind'], x: typeof v): Plan => {
    if (k === 'minutes') return { kind: k, n: x.minutes.trim() === '' ? NaN : Number(x.minutes) };
    if (k === 'hours') return { kind: k, n: x.hours.trim() === '' ? NaN : Number(x.hours) };
    if (k === 'daily') return { kind: k, at: clock(x.daily) };
    if (k === 'weekdays') return { kind: k, at: clock(x.weekdays) };
    if (k === 'weekly') return { kind: k, day: Number(x.day), at: clock(x.weekly) };
    return { kind: 'cron', cron: x.cron.trim() };
  };
  const pick = (k: Plan['kind']) => {
    setKind(k);
    onChange(planOf(k, v));
  };
  const put = (k: Plan['kind'], key: keyof typeof v, text: string) => {
    const next = { ...v, [key]: text };
    setV(next);
    setKind(k);
    onChange(planOf(k, next));
  };
  const digits = (text: string) => text.replace(/\D/g, '');
  const edge = t.dark ? t.ink2 : t.ink;

  const row = (k: Plan['kind'], words: string, parts: ReactNode, last = false, under?: ReactNode) => {
    const active = kind === k;
    return (
      <Pressable key={k} accessibilityRole="radio" accessibilityState={{ checked: active }} accessibilityLabel={words} onPress={() => pick(k)}
        style={[styles.choice, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
        <View style={[styles.mark, styles.round, styles.beside, { borderColor: edge, backgroundColor: active ? t.accent : 'transparent' }]}>
          {active ? <View style={[styles.pip, { backgroundColor: t.accentInk }]} /> : null}
        </View>
        <View style={kit.flex}>
          <View style={styles.sentence}>{parts}</View>
          {active ? under : null}
        </View>
      </Pressable>
    );
  };
  const word = (text: string) => <Txt size={15} weight={600}>{text}</Txt>;
  const time = (k: 'daily' | 'weekdays' | 'weekly', label: string) => (
    <Inline label={label} value={v[k]} width={72} maxLength={5} keyboardType="numbers-and-punctuation" placeholder="07:00" onFocus={() => kind !== k && pick(k)} onChangeText={(text) => put(k, k, text.replace(/[^\d:]/g, ''))} />
  );

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="When it runs">
      {row('minutes', `Every ${v.minutes} minutes`, <>{word('Every')}<Inline label="Minutes" value={v.minutes} maxLength={2} keyboardType="number-pad" onFocus={() => kind !== 'minutes' && pick('minutes')} onChangeText={(text) => put('minutes', 'minutes', digits(text))} />{word('minutes')}</>)}
      {row('hours', `Every ${v.hours} hours, on the hour`, <>{word('Every')}<Inline label="Hours" value={v.hours} maxLength={2} keyboardType="number-pad" onFocus={() => kind !== 'hours' && pick('hours')} onChangeText={(text) => put('hours', 'hours', digits(text))} />{word('hours, on the hour')}</>)}
      {row('daily', `Every day at ${v.daily}`, <>{word('Every day at')}{time('daily', 'Time of day')}</>)}
      {row('weekdays', `Monday to Friday at ${v.weekdays}`, <>{word('Monday to Friday at')}{time('weekdays', 'Time on weekdays')}</>)}
      {row('weekly', `Every ${DAY_NAMES[Number(v.day)]} at ${v.weekly}`, <>{word(`Every ${DAY_NAMES[Number(v.day)]} at`)}{time('weekly', 'Time on that day')}</>, !advanced,
        <View style={styles.under}><Chips value={v.day} options={DAY_CHIPS} onChange={(day) => put('weekly', 'day', day)} /></View>)}
      {advanced ? row('cron', 'A timetable you write yourself', (
        <TextInput
          value={v.cron}
          onChangeText={(text) => put('cron', 'cron', text)}
          onFocus={() => kind !== 'cron' && pick('cron')}
          accessibilityLabel="Timetable in five parts"
          placeholder="30 7 * * 1-5"
          placeholderTextColor={t.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          maxLength={120}
          style={[styles.cron, plainField, MONO, { backgroundColor: t.control, borderColor: t.edge, borderRadius: t.r.chip, color: t.ink }]}
        />
      ), true, <Txt size={12} color={t.ink3} style={styles.under}>Five parts: minute, hour, day of the month, month, day of the week. <Txt size={12} color={t.ink2} style={MONO}>30 7 * * 1-5</Txt> is 07:30 on weekdays.</Txt>) : (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }} onPress={() => setAdvanced(true)} style={({ pressed }) => [styles.advanced, pressed && kit.dim]}>
          <Txt size={14} weight={600} color={t.accentText}>Advanced: write the timetable yourself</Txt>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  choice: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 12 },
  choiceHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  mark: { alignItems: 'center', borderWidth: 2, height: 22, justifyContent: 'center', marginTop: 1, width: 22 },
  round: { borderRadius: 11 },
  beside: { marginTop: 7 },
  square: { borderRadius: 5 },
  pip: { borderRadius: 4, height: 8, width: 8 },
  note: { flexDirection: 'row', overflow: 'hidden' },
  noteBar: { width: 8 },
  noteText: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  small: { justifyContent: 'center', minHeight: 34, paddingHorizontal: 12, paddingVertical: 5 },
  inline: { borderWidth: 1, fontSize: 15, minHeight: 40, paddingHorizontal: 6, paddingVertical: 4, textAlign: 'center' },
  sentence: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 28 },
  under: { marginTop: 10 },
  cron: { borderWidth: 1, flex: 1, fontSize: 15, minHeight: 44, minWidth: 180, paddingHorizontal: 10, paddingVertical: 6 },
  advanced: { justifyContent: 'center', minHeight: 48, paddingHorizontal: 14 },
});
