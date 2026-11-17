/** What every list screen shares: a back button, a title, pull to refresh, and one loader with its error. */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLook } from '../theme/prefs';
import { Icon } from './Icon';
import { Button, GlassButton, styles as kit, Title, Txt } from './kit';

/**
 * Loads once, again every `every` ms while the app is in front (0: only when asked), and keeps the
 * last answer when a later one fails, saying why.
 */
export function useLoad<T>(read: () => Promise<T>, deps: unknown[], every = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const live = useRef(read);
  live.current = read;
  const load = useCallback(async () => {
    try {
      setData(await live.current());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
    if (!every) return;
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, every);
    const front = AppState.addEventListener('change', (state) => {
      if (timer) clearInterval(timer);
      timer = state === 'active' ? setInterval(load, every) : null;
      if (state === 'active') load();
    });
    return () => {
      if (timer) clearInterval(timer);
      front.remove();
    };
  }, [load, every]);
  return { data, error, load, setData };
}

export function Page({ title, note, onBack, onRefresh, error, loading, right, children }: {
  title: string; note?: string; onBack: () => void; onRefresh?: () => Promise<void>; error?: string; loading?: boolean; right?: ReactNode; children?: ReactNode;
}) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = onRefresh ? async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  } : undefined;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28 }]}
      refreshControl={refresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} /> : undefined}
    >
      <View style={styles.head}>
        <GlassButton icon="back" label="Back" onPress={onBack} />
        {right}
      </View>
      <Title>{title}</Title>
      {note ? <Txt color={t.ink2}>{note}</Txt> : null}
      {error ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">{loading ? '' : 'Showing the last update. '}{error}</Txt> : null}
      {loading && !error ? <ActivityIndicator color={t.accent} style={styles.spinner} accessibilityLabel="Loading" /> : null}
      {loading && error && onRefresh ? <Button label="Try again" onPress={onRefresh} /> : null}
      {children}
    </ScrollView>
  );
}

/** A tappable line in a list: a title, one line under it, and something on the right. */
export function Line({ title, detail, note, alert, right, tone, onPress, last, dot, extra, noteLines = 2 }: {
  title: string; detail?: string; note?: string; alert?: string; right?: ReactNode; tone?: string; onPress?: () => void; last?: boolean;
  /** A small coloured dot before the title: unread. */ dot?: string;
  /** Under the text, inside the row: small buttons. */ extra?: ReactNode;
  /** How many lines of the note show. */ noteLines?: number;
}) {
  const { t } = useLook();
  const body = (
    <View style={[styles.line, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={kit.flex}>
        <Txt size={15} weight={600} numberOfLines={2}>{dot ? <Txt size={15} color={dot}>{'\u25CF '}</Txt> : null}{title}</Txt>
        {detail ? <Txt size={13} color={tone ?? t.ink2} numberOfLines={3}>{detail}</Txt> : null}
        {note ? <Txt size={12} color={t.ink3} numberOfLines={noteLines}>{note}</Txt> : null}
        {alert ? <Txt size={12} weight={600} color={t.bad} numberOfLines={2}>{alert}</Txt> : null}
        {extra}
      </View>
      {right}
      {onPress ? <Icon name="chevron" size={16} color={t.ink3} /> : null}
    </View>
  );
  const spoken = [dot ? 'New' : '', title, detail, note, alert].filter(Boolean).join('. ');
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={spoken} onPress={onPress} style={({ pressed }) => pressed && kit.dim}>{body}</Pressable> : body;
}

/** A small word in colour: a state, a verdict, a flag. */
export function Tag({ text, color }: { text: string; color: string }) {
  const { t } = useLook();
  // On a plate a state is painted: the colour is the fill, the word is always in ink.
  if (t.plates) {
    const paint = color === t.good ? '#35d07f' : color === t.bad ? '#ff5b4d' : color === t.warn ? '#ffc61a' : color === t.accentText || color === t.accent ? '#9db8ff' : '#dfe3e8';
    return (
      <View style={[styles.tag, styles.painted, { backgroundColor: paint, borderColor: t.dark ? '#05070a' : t.ink }]}>
        <Txt size={12} weight={700} color="#15181d">{text}</Txt>
      </View>
    );
  }
  return (
    <View style={[styles.tag, { borderColor: color }]}>
      <Txt size={12} weight={700} color={color}>{text}</Txt>
    </View>
  );
}

/** "Show more" under a list that pages. */
export function More({ label = 'Show more', onPress, busy }: { label?: string; onPress: () => void; busy?: boolean }) {
  const { t } = useLook();
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={styles.more}>
      {busy ? <ActivityIndicator color={t.accent} /> : <Txt size={14} weight={600} color={t.accentText}>{label}</Txt>}
    </Pressable>
  );
}

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How long ago a time in ms was: "just now", "10 min ago", "2 h ago", "3 d ago". */
export function ago(ms: number | string | null | undefined, now = Date.now()) {
  const at = typeof ms === 'string' ? Date.parse(ms) : ms;
  if (!at) return '';
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** A time in ms ahead, as a weekday and a 24 h clock. */
export const dayClock = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '');

export const seconds = (s: number | null) => (s == null ? '' : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

const styles = StyleSheet.create({
  page: { gap: 10, paddingHorizontal: 16 },
  head: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  spinner: { marginTop: 24 },
  line: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 52, paddingHorizontal: 14, paddingVertical: 11 },
  tag: { borderRadius: 8, borderWidth: 1.5, paddingHorizontal: 6, paddingVertical: 1 },
  painted: { borderRadius: 5, borderWidth: 2, paddingHorizontal: 7, paddingVertical: 1 },
  more: { alignItems: 'center', justifyContent: 'center', minHeight: 48 },
});
