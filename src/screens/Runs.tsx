import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityItem, Connection, getActivity, getRun, getRuns, RunRow } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Chips, Group, Label, Row, Segmented, Txt } from '../ui/kit';
import { ago, Line, More, Page, seconds, Tag, tokens, useLoad } from '../ui/page';
import { clock } from '../ui/time';
import { RunLine } from './Crew';

type View_ = 'runs' | 'activity';
const ENDINGS = [{ id: '', name: 'All' }, { id: 'failed', name: 'Failed' }, { id: 'running', name: 'Running' }, { id: 'succeeded', name: 'Done' }];

/** Every run across the crew, and who did what to which job: one list or the other. */
export function RunsScreen({ connection, nav, bot }: { connection: Connection; nav: Nav; bot?: string }) {
  const { t } = useLook();
  const [view, setView] = useState<View_>('runs');
  const [status, setStatus] = useState('');
  const [extra, setExtra] = useState<{ runs: RunRow[]; items: ActivityItem[]; page: number }>({ runs: [], items: [], page: 0 });
  const [busy, setBusy] = useState(false);
  const runs = useLoad(() => {
    setExtra({ runs: [], items: [], page: 0 });
    return view === 'runs' ? getRuns(connection, { bot, status }) : Promise.resolve(null);
  }, [connection, bot, status, view]);
  const activity = useLoad(() => {
    setExtra({ runs: [], items: [], page: 0 });
    return view === 'activity' ? getActivity(connection, { bot }) : Promise.resolve(null);
  }, [connection, bot, view]);
  const name = bot ? runs.data?.bots.find((b) => b.id === bot)?.name : '';

  const more = async () => {
    setBusy(true);
    try {
      const page = extra.page + 1;
      if (view === 'runs') {
        const next = await getRuns(connection, { bot, status, page });
        setExtra({ ...extra, runs: [...extra.runs, ...next.runs], page });
      } else {
        const next = await getActivity(connection, { bot, page });
        setExtra({ ...extra, items: [...extra.items, ...next.items], page });
      }
    } catch (err) {
      tell('That did not load', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shownRuns = [...(runs.data?.runs ?? []), ...extra.runs];
  const shownItems = [...(activity.data?.items ?? []), ...extra.items];
  const current = view === 'runs' ? runs : activity;
  const pages = view === 'runs' ? runs.data?.pages ?? 1 : activity.data?.pages ?? 1;
  return (
    <Page title={name ? `${name}'s runs` : 'Runs'} onBack={nav.back} onRefresh={current.load} error={current.error} loading={!current.data}>
      <Segmented<View_> value={view} options={[{ id: 'runs', name: 'Runs' }, { id: 'activity', name: 'Activity' }]} onChange={setView} />
      {view === 'runs' ? <Chips value={status} options={ENDINGS} onChange={setStatus} /> : null}
      {view === 'runs' && runs.data ? (
        <>
          <Label>{`${runs.data.total} run${runs.data.total === 1 ? '' : 's'}${status ? ` ${ENDINGS.find((e) => e.id === status)?.name.toLowerCase()}` : ''}, newest first`}</Label>
          {shownRuns.length ? (
            <Group>
              {shownRuns.map((run, index) => <RunLine key={run.id} run={run} showBot={!bot} last={index === shownRuns.length - 1} onOpen={() => nav.push({ name: 'run', id: run.id })} />)}
            </Group>
          ) : <Txt color={t.ink2}>None.</Txt>}
        </>
      ) : null}
      {view === 'activity' && activity.data ? (
        <>
          <Label>Who did what, newest first</Label>
          {shownItems.length ? (
            <Group>
              {shownItems.map((item, index) => (
                <Line
                  key={`${item.at}-${index}`}
                  title={`${item.who} ${item.what}${item.times > 1 ? ` (${item.times} times)` : ''}${item.to ? `, to ${item.to}` : ''}`}
                  detail={item.job ? `${item.job.ref} ${item.job.title}` : undefined}
                  note={`${clock(new Date(item.at).toISOString())}, ${ago(item.at)}`}
                  tone={item.kind === 'failed' ? t.bad : undefined}
                  last={index === shownItems.length - 1}
                  onPress={item.run ? () => nav.push({ name: 'run', id: item.run! }) : item.job ? () => nav.push({ name: 'job', id: item.job!.id }) : undefined}
                />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>Nothing this week.</Txt>}
        </>
      ) : null}
      {current.data && extra.page + 1 < pages ? <More onPress={more} busy={busy} /> : null}
    </Page>
  );
}

const LOG_TONE = { said: 'ink', tool: 'ink3', error: 'bad', note: 'ink2' } as const;

/** One run: how it ended and why, what it cost, its job, and the end of its log. */
export function RunScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data: run, error, load } = useLoad(() => getRun(connection, id), [connection, id]);
  return (
    <Page title={run ? `${run.bot}: ${run.state}` : 'Run'} onBack={nav.back} onRefresh={load} error={error} loading={!run}>
      {run ? (
        <>
          {run.failed ? <Txt size={15} weight={600} color={t.bad}>{run.why}</Txt> : null}
          <Group>
            {run.job ? <Row title={`${run.job.ref} ${run.job.title}`} detail="Open the job" onPress={() => nav.push({ name: 'job', id: run.job!.id })} /> : null}
            <Row title={[run.started, run.at ? ago(run.at) : '', seconds(run.seconds)].filter(Boolean).join(', ')} detail={[run.model, run.tokens ? `${tokens(run.tokens)} tokens` : '', run.cached ? `${tokens(run.cached)} cached` : ''].filter(Boolean).join(', ')} last />
          </Group>
          <Label>{run.trimmed ? 'The end of its log' : 'Its log'}</Label>
          {run.log.length ? (
            <Group>
              <View style={styles.log}>
                {run.log.map((line, index) => (
                  <View key={index} style={styles.logLine}>
                    {line.kind === 'tool' || line.kind === 'error' ? <Tag text={line.kind === 'tool' ? 'Ran' : 'Error'} color={line.kind === 'error' ? t.bad : t.ink3} /> : null}
                    <Txt size={13} color={t[LOG_TONE[line.kind] ?? 'ink2']} selectable style={styles.logText}>{line.text}</Txt>
                  </View>
                ))}
              </View>
            </Group>
          ) : <Txt color={t.ink2}>No log was kept.</Txt>}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  log: { gap: 8, padding: 14 },
  logLine: { alignItems: 'flex-start', flexDirection: 'row', gap: 6 },
  logText: { flex: 1 },
});
