import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Connection, getPcLoad, LoadLevel, PaceAbout, PcLoad, setPcLoad } from '../api';
import { useLook } from '../theme/prefs';
import { ask } from './ask';
import { Label, Segmented, styles as kit, Txt } from './kit';

const NAMES: Record<LoadLevel, string> = { sprint: 'Sprint', run: 'Run', jog: 'Jog', walk: 'Walk', crawl: 'Crawl', stop: 'Stop' };
const LEVELS: LoadLevel[] = ['sprint', 'run', 'jog', 'walk', 'crawl', 'stop'];
const SCOPES = [{ id: 'both', name: 'Day and night' }, { id: 'day', name: 'Day only' }, { id: 'night', name: 'Night only' }] as const;
type Scope = (typeof SCOPES)[number]['id'];
export const FULL_QUESTION = 'Pause all heavy work and stop new builds? The lead bot and checks keep running. You can resume any time.';

/** The paces as the PC describes them (its `about`, the same words as the page's tooltips); names only from an older PC. */
export function paceRows(state: PcLoad | null): PaceAbout[] {
  const told = state?.about || [];
  return LEVELS.map((id) => told.find((a) => a.id === id) || { id, name: NAMES[id], says: '', numbers: '', warn: '' });
}

/**
 * How fast the crew works, set from the phone as the owner: Sprint, Run, Jog, Walk, Crawl, Stop.
 * A phone has no hover, so the pace in force shows its own sentence and numbers, and a press opens the list of all
 * six, each with what it means; Sprint and Stop carry their warning. On Stop it shows the jobs paused and the memory
 * they hold. A PC that names no throttle tool answers `configured: false`, and nothing is shown.
 */
export function PcLoadCard({ connection, every = 30_000 }: { connection: Connection; every?: number }) {
  const { p, t } = useLook();
  const [state, setState] = useState<PcLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<Scope>('both');
  const [split, setSplit] = useState(false);
  const [open, setOpen] = useState(false);
  const before = useRef<LoadLevel>('run');

  const load = useCallback(async () => {
    try {
      setState(await getPcLoad(connection));
      setError('');
    } catch (err) {
      // An older PC has no such door: then there is no control to show.
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => {
    load();
    const timer = setInterval(load, every);
    return () => clearInterval(timer);
  }, [load, every]);

  const set = useCallback(async (level: LoadLevel) => {
    if (busy) return;
    if (state?.now && state.now !== 'stop') before.current = state.now;
    setBusy(true);
    try {
      setState(await setPcLoad(connection, level, scope));
      setError('');
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }, [busy, connection, scope, state]);

  const choose = (level: LoadLevel) => {
    if (level === state?.now) return setOpen(false);
    if (level === 'stop') ask('Stop', FULL_QUESTION, 'Pause all', () => set('stop'));
    else set(level);
  };

  if (!state?.configured) return null;
  const now = (state.now || '') as LoadLevel | '';
  const stopped = now === 'stop';
  const rows = paceRows(state);
  const here = rows.find((r) => r.id === now);
  return (
    <View>
      <Label>{state.label || 'Pace'}</Label>
      <View style={[styles.card, { backgroundColor: t.card, borderColor: stopped ? t.bad : t.line }, t.plates && { borderRadius: t.r.card }]}>
        {state.labelSays && p.explain ? <Txt size={13} color={t.ink2}>{state.labelSays}</Txt> : null}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`Pace: ${here?.name || 'not known'}. Show all paces`}
          onPress={() => setOpen((v) => !v)} style={({ pressed }) => [styles.now, { borderColor: t.line }, pressed && kit.dim]}>
          <View style={kit.flex}>
            <Txt size={16} weight={700} color={stopped ? t.bad : t.ink}>{here?.name || 'Not known'}</Txt>
            {here?.numbers || here?.says ? <Txt size={13} color={t.ink2}>{here.numbers || here.says}</Txt> : null}
          </View>
          <Txt size={13} weight={600} color={t.accentText}>{open ? 'Close' : 'Change'}</Txt>
        </Pressable>
        {open ? (
          <View accessibilityRole="radiogroup" style={styles.list}>
            {rows.map((r) => {
              const on = r.id === now;
              return (
                <Pressable key={r.id} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: busy }} onPress={() => choose(r.id)}
                  style={({ pressed }) => [styles.row, { borderColor: on ? t.accent : t.line, borderWidth: on ? 2 : 1 }, pressed && kit.dim]}>
                  <View style={kit.flex}>
                    <Txt size={15} weight={700} color={r.id === 'stop' ? t.bad : t.ink}>{`${on ? '\u2713 ' : ''}${r.name}`}</Txt>
                    {r.says ? <Txt size={13} color={t.ink2}>{r.says}</Txt> : null}
                    {r.numbers ? <Txt size={13} color={t.ink2}>{r.numbers}</Txt> : null}
                    {r.warn ? <Txt size={13} weight={600} color={r.id === 'stop' ? t.bad : t.warn}>{r.warn}</Txt> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {busy || error || stopped ? <View style={styles.status}>
          {busy ? <ActivityIndicator size="small" color={t.accent} accessibilityLabel="Setting the pace" /> : null}
          <Txt size={14} weight={stopped ? 700 : 400} color={error ? t.bad : stopped ? t.bad : t.ink2} style={kit.flex} accessibilityLiveRegion="polite">
            {error || state.line || ''}
          </Txt>
          {stopped ? (
            <Pressable accessibilityRole="button" accessibilityHint="Goes back to the pace before Stop" onPress={() => set(before.current)} style={({ pressed }) => [styles.link, pressed && kit.dim]}>
              <Txt size={14} weight={700} color={t.accentText}>Resume</Txt>
            </Pressable>
          ) : null}
        </View> : null}
        {open ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: split }} onPress={() => setSplit((v) => !v)} style={({ pressed }) => [styles.link, pressed && kit.dim]}>
          <Txt size={13} weight={600} color={t.accentText}>{split ? 'Done' : `A press sets: ${SCOPES.find((s) => s.id === scope)?.name.toLowerCase()}`}</Txt>
        </Pressable> : null}
        {open && split ? (
          <View style={styles.split}>
            <Txt size={13} color={t.ink2}>The PC can keep one pace by day (09:00 to 01:00) and another by night. Pick which one a press changes.</Txt>
            {state.day && state.night ? <Txt size={13} color={t.ink2}>{`Day: ${NAMES[state.day as LoadLevel]}. Night: ${NAMES[state.night as LoadLevel]}.`}</Txt> : null}
            <Segmented<Scope> value={scope} options={SCOPES.map((s) => ({ id: s.id, name: s.name }))} onChange={setScope} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 12 },
  now: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 56, padding: 10 },
  list: { gap: 6 },
  row: { borderRadius: 12, borderWidth: 1, minHeight: 44, padding: 10 },
  status: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 },
  link: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44, paddingHorizontal: 2 },
  split: { gap: 8 },
});
