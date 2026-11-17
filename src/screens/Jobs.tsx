import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Connection, getJobs, JobListRow, JobPile } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Icon } from '../ui/Icon';
import { Chips, Group, plainField, Segmented, Txt } from '../ui/kit';
import { ago, Line, More, Page, Tag } from '../ui/page';

const ALL = '';
const PILES: { id: JobPile; name: string }[] = [{ id: 'active', name: 'Active' }, { id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }];
const SEARCH_WAIT_MS = 350;

export function JobLine({ job, last, onOpen }: { job: JobListRow; last?: boolean; onOpen: () => void }) {
  const { t } = useLook();
  const tone = job.status === 'blocked' ? t.bad : job.status === 'in_review' ? t.warn : job.status === 'in_progress' ? t.accentText : t.ink3;
  return (
    <Line
      title={job.title}
      detail={job.snippet}
      note={[job.ref, job.project, job.bot, ago(job.at)].filter(Boolean).join(', ')}
      right={<Tag text={job.state} color={tone} />}
      last={last}
      onPress={onOpen}
    />
  );
}

/** Any job: one pile at a time, narrowed by project and bot, or found by words. */
export function JobsScreen({ connection, nav, project: firstProject, bot: firstBot }: { connection: Connection; nav: Nav; project?: string; bot?: string }) {
  const { t, font } = useLook();
  const [pile, setPile] = useState<JobPile>('active');
  const [project, setProject] = useState(firstProject ?? ALL);
  const [bot, setBot] = useState(firstBot ?? ALL);
  const [words, setWords] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState(Boolean(firstBot));
  const [jobs, setJobs] = useState<JobListRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<{ bots: { id: string; name: string }[]; projects: { id: string; name: string }[] }>({ bots: [], projects: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQ(words.trim()), SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [words]);

  const read = async (at: number) => {
    const answer = await getJobs(connection, { pile, project, bot, q, page: at });
    setNames({ bots: answer.bots, projects: answer.projects });
    setMore(answer.more);
    setPage(at);
    return answer.jobs;
  };
  const load = async () => {
    try {
      setJobs(await read(0));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    setJobs(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, pile, project, bot, q]);

  const next = async () => {
    setBusy(true);
    try {
      const rows = await read(page + 1);
      setJobs((now) => [...(now ?? []), ...rows]);
    } catch (err) {
      tell('That did not load', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const narrowed = [names.projects.find((p) => p.id === project)?.name, names.bots.find((b) => b.id === bot)?.name].filter(Boolean).join(', ');
  return (
    <Page title="Jobs" onBack={nav.back} onRefresh={load} error={error} loading={!jobs}>
      <View style={[styles.search, { backgroundColor: t.card, borderColor: t.edge, borderWidth: StyleSheet.hairlineWidth }]}>
        <Icon name="search" size={18} color={t.ink2} />
        <TextInput value={words} onChangeText={setWords} placeholder="Search every job" accessibilityLabel="Search every job" placeholderTextColor={t.ink3} autoCorrect={false} returnKeyType="search" style={[styles.input, font(400), plainField, { color: t.ink }]} />
        {words ? <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" hitSlop={8} onPress={() => setWords('')} style={styles.clear}><Icon name="close" size={16} color={t.ink2} /></Pressable> : null}
      </View>
      <Segmented<JobPile> value={pile} options={PILES} onChange={setPile} />
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: filters }} onPress={() => setFilters(!filters)} style={styles.filters}>
        <Txt size={14} weight={600} color={t.accentText}>{filters ? 'Hide filters' : narrowed ? `Filtered: ${narrowed}` : 'Filter by project or bot'}</Txt>
        <Icon name={filters ? 'up' : 'down'} size={16} color={t.accentText} />
      </Pressable>
      {filters ? (
        <>
          <Chips value={project} options={[{ id: ALL, name: 'Every project' }, ...names.projects]} onChange={setProject} />
          <Chips value={bot} options={[{ id: ALL, name: 'Every bot' }, ...names.bots]} onChange={setBot} />
        </>
      ) : null}
      {jobs && !jobs.length ? <Txt color={t.ink2}>{q ? 'No job matches that search.' : 'No jobs here.'}</Txt> : null}
      {jobs?.length ? (
        <Group>
          {jobs.map((job, index) => <JobLine key={job.id} job={job} last={index === jobs.length - 1} onOpen={() => nav.push({ name: 'job', id: job.id })} />)}
        </Group>
      ) : null}
      {jobs && more ? <More onPress={next} busy={busy} /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  search: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 12 },
  input: { flex: 1, fontSize: 16, minHeight: 44, paddingVertical: 8 },
  filters: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 44 },
  clear: { padding: 6 },
});
