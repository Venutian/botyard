import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, getImprovements, Improvement, ImprovementList, ImprovementState } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Button, GlassButton, Group, Segmented, Title, Txt } from '../ui/kit';

const FILTERS: { id: ImprovementState | 'all'; name: string }[] = [
  { id: 'all', name: 'All' }, { id: 'new', name: 'New' }, { id: 'accepted', name: 'Accepted' }, { id: 'done', name: 'Done' }, { id: 'rejected', name: 'Rejected' },
];

function Finding({ item, last }: { item: Improvement; last: boolean }) {
  const { t } = useLook();
  const tone = item.status === 'done' ? t.good : item.status === 'accepted' ? t.accentText : item.status === 'rejected' ? t.ink3 : t.warn;
  return (
    <View style={[styles.item, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.head}>
        <Txt size={16} weight={600} style={styles.title}>{item.title}</Txt>
        <Txt size={13} weight={700} color={tone}>{item.status}</Txt>
      </View>
      <Txt size={12} color={t.ink3}>{[item.id, item.path, item.who].filter(Boolean).join(' · ')}</Txt>
      {item.evidence ? <Txt size={14} color={t.ink2}>{`Evidence: ${item.evidence}`}</Txt> : null}
      {item.fix ? <Txt size={14} color={t.ink2}>{`Smallest fix: ${item.fix}`}</Txt> : null}
      <Txt size={13} color={item.job ? t.ink : t.ink3}>{item.job ? `Job: ${item.job}` : 'No job yet'}</Txt>
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
  const [filter, setFilter] = useState<ImprovementState | 'all'>('all');

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

  const shown = (data?.items ?? []).filter((i) => filter === 'all' || i.status === filter);
  const count = (id: ImprovementState | 'all') => (id === 'all' ? data?.items.length ?? 0 : data?.counts[id] ?? 0);

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Improvements</Title>
      <Txt color={t.ink2}>What Freya's audits and Tony found worth improving, and the job that carries each. Pull down to refresh.</Txt>
      {error ? <Txt size={14} color={t.bad}>{data ? 'Showing the last update. ' : ''}{error}</Txt> : null}
      {!data && !error ? <ActivityIndicator color={t.accent} style={styles.spinner} /> : null}
      {!data && error ? <Button label="Try again" onPress={load} /> : null}
      {data ? (
        <>
          <Segmented<ImprovementState | 'all'> value={filter} options={FILTERS.map((f) => ({ id: f.id, name: `${f.name} ${count(f.id)}` }))} onChange={setFilter} />
          {shown.length ? (
            <Group>{shown.map((item, index) => <Finding key={item.id} item={item} last={index === shown.length - 1} />)}</Group>
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
});
