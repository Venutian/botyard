import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, decideImprovement, getImprovements, Improvement, ImprovementAction, ImprovementList, ImprovementState } from '../api';
import { decidedLine, historyLine, STATUS_NAMES } from '../improvementText';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Button, Field, GlassButton, Group, Segmented, Title, Txt } from '../ui/kit';

type Filter = 'open' | 'all' | ImprovementState;
const FILTERS: { id: Filter; name: string }[] = [
  { id: 'open', name: 'To decide' }, { id: 'all', name: 'All' }, { id: 'new', name: 'New' }, { id: 'ask', name: 'Ask me' },
  { id: 'accepted', name: 'Accepted' }, { id: 'done', name: 'Done' }, { id: 'rejected', name: 'Rejected' }, { id: 'stale', name: 'Stale' },
];

function Finding({ item, last, busy, onDecide, onJob }: { item: Improvement; last: boolean; busy: boolean; onDecide: (action: ImprovementAction, reason?: string) => void; onJob: (ref: string) => void }) {
  const { t } = useLook();
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState('');
  const tone = item.status === 'done' ? t.good : item.status === 'accepted' ? t.accentText : item.status === 'rejected' || item.status === 'stale' ? t.ink3 : t.warn;
  const decided = decidedLine(item);
  const story = historyLine(item);
  return (
    <View style={[styles.item, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.head}>
        <Txt size={16} weight={600} style={styles.title}>{item.title}</Txt>
        <Txt size={13} weight={700} color={tone} accessibilityLabel={`Status: ${STATUS_NAMES[item.status] ?? item.status}`}>{STATUS_NAMES[item.status] ?? item.status}</Txt>
      </View>
      <Txt size={12} color={t.ink3}>{[item.id, item.path, item.who].filter(Boolean).join(' · ')}</Txt>
      {item.evidence ? <Txt size={14} color={t.ink2}>{`Evidence: ${item.evidence}`}</Txt> : null}
      {item.fix ? <Txt size={14} color={t.ink2}>{`Smallest fix: ${item.fix}`}</Txt> : null}
      {decided ? <Txt size={14}>{`${decided}. ${item.reason ? `Why: ${item.reason}` : 'No reason written.'}`}</Txt> : null}
      {story ? <Txt size={12} color={t.ink3}>{story}</Txt> : null}
      {item.job ? <Button kind="quiet" label={`Job ${item.job}`} onPress={() => onJob(item.job)} /> : <Txt size={13} color={t.ink3}>No job yet</Txt>}
      <View style={styles.buttons}>
        <View style={styles.cell}><Button label="Accept" disabled={busy} onPress={() => onDecide('accept')} /></View>
        <View style={styles.cell}><Button kind="quiet" label="Reject" disabled={busy} onPress={() => setRejecting(!rejecting)} /></View>
        <View style={styles.cell}><Button kind="quiet" label="Ask me" disabled={busy} onPress={() => onDecide('ask')} /></View>
        <View style={styles.cell}><Button kind="quiet" label="Send to Tony" disabled={busy} onPress={() => onDecide('send')} /></View>
      </View>
      {rejecting ? (
        <View style={styles.reject}>
          <Field label="Why reject it? One line" value={why} onChangeText={setWhy} maxLength={400} />
          <Button kind="danger" label="Reject it" disabled={busy || !why.trim()} onPress={() => { onDecide('reject', why.trim()); setRejecting(false); setWhy(''); }} />
        </View>
      ) : null}
    </View>
  );
}

/** What Freya's audits and Tony found worth improving: the same list, filters and fields as the PC's Improvements page. */
export function ImprovementsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<ImprovementList | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getImprovements(connection));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const decide = async (id: string, action: ImprovementAction, reason = '') => {
    setBusy(true);
    try {
      await decideImprovement(connection, id, action, reason);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const shown = (data?.items ?? []).filter((i) => filter === 'all' || (filter === 'open' ? i.status === 'new' || i.status === 'ask' : i.status === filter));
  const count = (id: Filter) => (id === 'all' ? data?.items.length ?? 0 : id === 'open' ? (data?.counts.new ?? 0) + (data?.counts.ask ?? 0) : data?.counts[id] ?? 0);

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Improvements</Title>
      <Txt color={t.ink2}>What Freya's audits and Tony found worth improving, who decided and why, and the job that carries each. Your decision always wins. Pull down to refresh.</Txt>
      {error ? <Txt size={14} color={t.bad}>{data ? 'Showing the last update. ' : ''}{error}</Txt> : null}
      {!data && !error ? <ActivityIndicator color={t.accent} style={styles.spinner} /> : null}
      {!data && error ? <Button label="Try again" onPress={load} /> : null}
      {data ? (
        <>
          {[FILTERS.slice(0, 4), FILTERS.slice(4)].map((row) => (
            <Segmented<Filter> key={row[0].id} value={filter} options={row.map((f) => ({ id: f.id, name: `${f.name} ${count(f.id)}` }))} onChange={setFilter} />
          ))}
          {shown.length ? (
            <Group>{shown.map((item, index) => <Finding key={item.id} item={item} last={index === shown.length - 1} busy={busy} onDecide={(action, reason) => decide(item.id, action, reason)} onJob={(ref) => nav.push({ name: 'job', id: ref })} />)}</Group>
          ) : (
            <Txt color={t.ink2}>{data.items.length ? 'Nothing in this state.' : 'No improvements listed yet.'}</Txt>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { gap: 12, paddingHorizontal: 16 },
  spinner: { marginTop: 24 },
  item: { gap: 4, padding: 16 },
  head: { alignItems: 'baseline', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  title: { flex: 1 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: '45%' },
  reject: { gap: 8 },
});
