import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Connection, getPcLoad, LoadLevel, PcLoad, setPcLoad } from '../api';
import { useLook } from '../theme/prefs';
import { ask } from './ask';
import { Label, Segmented, styles as kit, Txt } from './kit';

const NAMES: Record<LoadLevel, string> = { max: 'Max', none: 'None', light: 'Light', medium: 'Medium', heavy: 'Heavy', full: 'Full' };
const LEVELS: LoadLevel[] = ['max', 'none', 'light', 'medium', 'heavy', 'full'];
const SCOPES = [{ id: 'both', name: 'Day and night' }, { id: 'day', name: 'Day only' }, { id: 'night', name: 'Night only' }] as const;
type Scope = (typeof SCOPES)[number]['id'];
export const FULL_QUESTION = 'Pause all heavy work and stop new builds? The lead bot and checks keep running. You can resume any time.';

/**
 * How hard the crew may work the PC, set from the phone as the owner: Max, None, Light, Medium, Heavy, Full.
 * Shows the level in force now and, on Full, how many jobs are paused and the memory they hold.
 * A PC that names no throttle tool answers `configured: false`, and nothing is shown.
 */
export function PcLoadCard({ connection, every = 30_000 }: { connection: Connection; every?: number }) {
  const { t } = useLook();
  const [state, setState] = useState<PcLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<Scope>('both');
  const [split, setSplit] = useState(false);
  const before = useRef<LoadLevel>('none');

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
    if (state?.now && state.now !== 'full') before.current = state.now;
    setBusy(true);
    try {
      setState(await setPcLoad(connection, level, scope));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }, [busy, connection, scope, state]);

  const choose = (level: LoadLevel) => {
    if (level === state?.now) return;
    if (level === 'full') ask('Full PC load', FULL_QUESTION, 'Pause all', () => set('full'));
    else set(level);
  };

  if (!state?.configured) return null;
  const now = (state.now || '') as LoadLevel | '';
  const full = now === 'full';
  return (
    <View>
      <Label>Throttle</Label>
      <View style={[styles.card, { backgroundColor: t.card, borderColor: full ? t.bad : t.line }, t.plates && { borderRadius: t.r.card }]}>
        <Segmented<LoadLevel> value={now || 'none'} options={LEVELS.map((id) => ({ id, name: NAMES[id] }))} onChange={choose} />
        <View style={styles.status}>
          {busy ? <ActivityIndicator size="small" color={t.accent} accessibilityLabel="Setting the PC load" /> : null}
          <Txt size={14} weight={full ? 700 : 400} color={error ? t.bad : full ? t.bad : t.ink2} style={kit.flex} accessibilityLiveRegion="polite">
            {error || state.line || ''}
          </Txt>
          {full ? (
            <Pressable accessibilityRole="button" onPress={() => set(before.current)} style={({ pressed }) => [styles.link, pressed && kit.dim]}>
              <Txt size={14} weight={700} color={t.accentText}>Resume</Txt>
            </Pressable>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: split }} onPress={() => setSplit((v) => !v)} style={({ pressed }) => [styles.link, pressed && kit.dim]}>
          <Txt size={13} weight={600} color={t.accentText}>{split ? 'Done' : `A press sets: ${SCOPES.find((s) => s.id === scope)?.name.toLowerCase()}`}</Txt>
        </Pressable>
        {split ? (
          <View style={styles.split}>
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
  status: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 },
  link: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44, paddingHorizontal: 2 },
  split: { gap: 8 },
});
