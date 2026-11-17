import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, decideImprovement, getImprovements, Improvement, ImprovementAction, ImprovementList, ImprovementState } from '../api';
import { decidedLine, historyLine, STATUS_NAMES } from '../improvementText';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Button, Chips, Field, GlassButton, Title, Txt } from '../ui/kit';
import { Tag } from '../ui/page';
import { Notes, RecordCard } from '../ui/record';

type Filter = 'open' | 'all' | ImprovementState;
const FILTERS: { id: Filter; name: string }[] = [
  { id: 'open', name: 'To decide' }, { id: 'all', name: 'All' }, { id: 'new', name: 'New' }, { id: 'ask', name: 'Ask me' },
  { id: 'accepted', name: 'Accepted' }, { id: 'done', name: 'Done' }, { id: 'rejected', name: 'Rejected' }, { id: 'stale', name: 'Stale' },
];

const OPEN: ImprovementState[] = ['new', 'ask'];

/** The four decision buttons, and the one-line reason a Reject asks for. */
function Decide({ item, lead, busy, onDecide }: { item: Improvement; lead: string; busy: boolean; onDecide: (action: ImprovementAction, reason?: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState('');
  return (
    <>
      <View style={styles.buttons}>
        <View style={styles.cell}><Button label="Accept" kind={OPEN.includes(item.status) ? 'primary' : 'quiet'} disabled={busy} onPress={() => onDecide('accept')} /></View>
        <View style={styles.cell}><Button kind="quiet" label="Reject" disabled={busy} onPress={() => setRejecting(!rejecting)} /></View>
        <View style={styles.cell}><Button kind="quiet" label="Ask me" disabled={busy} onPress={() => onDecide('ask')} /></View>
        <View style={styles.cell}><Button kind="quiet" label={`Send to ${lead || 'the lead'}`} disabled={busy} onPress={() => onDecide('send')} /></View>
      </View>
      {rejecting ? (
        <View style={styles.reject}>
          <Field label="Why reject it? One line" value={why} onChangeText={setWhy} maxLength={400} />
          <Button kind="danger" label="Reject it" disabled={busy || !why.trim()} onPress={() => { onDecide('reject', why.trim()); setRejecting(false); setWhy(''); }} />
        </View>
      ) : null}
    </>
  );
}

/**
 * One finding, as on the PC: its state and title first, the smallest fix in a line, who found it, the decision
 * and the job, each labelled. A finding that waits for you has its buttons on its face; the evidence, the file,
 * the reason and the history, and the buttons of a decided one, open under it with Details.
 */
function Finding({ item, lead, open, onToggle, busy, onDecide, onJob }: { item: Improvement; lead: string; open: boolean; onToggle: () => void; busy: boolean; onDecide: (action: ImprovementAction, reason?: string) => void; onJob: (ref: string) => void }) {
  const { t } = useLook();
  const waiting = OPEN.includes(item.status);
  const tone = item.status === 'done' ? t.good : waiting ? t.warn : t.ink3;
  const decided = decidedLine(item, lead);
  const story = historyLine(item, lead);
  return (
    <RecordCard
      title={item.title}
      line={item.fix ? `Smallest fix: ${item.fix}` : undefined}
      open={open}
      onToggle={onToggle}
      right={(
        <>
          <Tag text={STATUS_NAMES[item.status] ?? item.status} color={tone} />
          <Txt size={12} color={t.ink3}>{item.id}</Txt>
        </>
      )}
      facts={[
        { label: 'Found by', value: item.who || 'Not said' },
        { label: 'Decision', value: decided || 'Waiting for you' },
        item.job ? { label: 'Job', value: item.job, node: <Button kind="quiet" label={item.job} onPress={() => onJob(item.job)} /> } : { label: 'Job', value: 'No job yet' },
      ]}
      face={waiting ? <Decide item={item} lead={lead} busy={busy} onDecide={onDecide} /> : undefined}
      details={(
        <>
          <Notes items={[
            item.evidence ? { label: 'Evidence', text: item.evidence } : null,
            item.path ? { label: 'Where', text: item.path } : null,
            decided ? { label: 'Why', text: item.reason || 'No reason written.' } : null,
            story ? { label: 'History', text: story } : null,
          ].filter((n): n is { label: string; text: string } => Boolean(n))} />
          {waiting ? null : (
            <>
              <Txt size={13} weight={700} color={t.ink2}>Change your decision</Txt>
              <Decide item={item} lead={lead} busy={busy} onDecide={onDecide} />
            </>
          )}
        </>
      )}
    />
  );
}

/** What the crew's audits found worth improving: the same list, filters and fields as the PC's Improvements page. */
export function ImprovementsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<ImprovementList | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

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
  const waitingCount = (data?.counts.new ?? 0) + (data?.counts.ask ?? 0);
  const count = (id: Filter) => (id === 'all' ? data?.items.length ?? 0 : id === 'open' ? (data?.counts.new ?? 0) + (data?.counts.ask ?? 0) : data?.counts[id] ?? 0);

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Improvements</Title>
      <Txt color={t.ink2}>What the crew's audits found worth improving, who decided and why, and the job that carries each. Your decision always wins. Pull down to refresh.</Txt>
      {error ? <Txt size={14} color={t.bad}>{data ? 'Showing the last update. ' : ''}{error}</Txt> : null}
      {!data && !error ? <ActivityIndicator color={t.accent} style={styles.spinner} /> : null}
      {!data && error ? <Button label="Try again" onPress={load} /> : null}
      {data ? (
        <>
          {waitingCount ? (
            <Txt size={15}><Txt size={15} weight={700}>{`${waitingCount} waiting for you. `}</Txt>{`Accept, reject, ask to be asked again, or hand it to ${data.lead || 'the lead'}.`}</Txt>
          ) : data.items.length ? <Txt size={15}><Txt size={15} weight={700}>Nothing waits for you. </Txt>Open a finding to change a decision.</Txt> : null}
          <Chips<Filter> value={filter} options={FILTERS.map((f) => ({ id: f.id, name: `${f.name} ${count(f.id)}` }))} onChange={setFilter} />
          {shown.length ? (
            <View style={styles.list}>{shown.map((item) => <Finding key={item.id} item={item} lead={data.lead ?? ''} open={Boolean(opened[item.id])} onToggle={() => setOpened((o) => ({ ...o, [item.id]: !o[item.id] }))} busy={busy} onDecide={(action, reason) => decide(item.id, action, reason)} onJob={(ref) => nav.push({ name: 'job', id: ref })} />)}</View>
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
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: '45%' },
  reject: { gap: 8 },
  list: { gap: 12 },
});
