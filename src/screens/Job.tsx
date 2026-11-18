import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  acceptQuestion, addComment, addJob, Answer, answerQuestion, Connection, DocRevision, getDocRevisions, getJob, restoreDoc, getJobMore, getSummary, jobAction, JobDetail, JobMore, LinkedJob, Project, Question, QuestionItem, rejectQuestion,
} from '../api';
import { Crew, handsOf, leadOf, Nav } from '../crew';
import { BotBadge } from '../mascot/BotBadge';
import { portraitOf } from '../mascot/look';
import { readable } from '../theme/color';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { ProofRow } from '../ui/Proof';
import { clock } from '../ui/time';
import { Button, Chips, Field, GlassButton, Group, Label, Segmented, plainField, Title, Txt, useTap } from '../ui/kit';
import { Small, useAct } from '../ui/form';
import { ago, Line, plural, seconds, Tag, tokens } from '../ui/page';
import { RunLine } from './Crew';

const REFRESH_MS = 20_000;

const PRIORITIES = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'critical', name: 'Critical' }];
const NONE = 'none';

export function NewJobScreen({ connection, crew, nav }: { connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [game, setGame] = useState(NONE);
  const [owner, setOwner] = useState(NONE);
  const [priority, setPriority] = useState('medium');

  useEffect(() => {
    getSummary(connection).then((summary) => setProjects(summary.projects ?? [])).catch(() => undefined);
  }, [connection]);

  const submit = async () => {
    setBusy(true);
    try {
      const job = await addJob(connection, {
        title,
        description: details,
        priority,
        ...(game !== NONE ? { projectId: game } : {}),
        ...(owner !== NONE ? { botId: owner } : {}),
      });
      nav.replace({ name: 'job', id: job.id });
    } catch (err) {
      tell('The job was not added', (err as Error).message);
      setBusy(false);
    }
  };

  const lead = leadOf(crew.bots);
  const bots = handsOf(crew.bots).map((bot) => ({ id: bot.id, name: portraitOf(bot, p.bots[bot.id]).name }));
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
        <GlassButton icon="back" label="Back" onPress={nav.back} />
        <Title>New job</Title>
        <Txt color={t.ink2}>{lead ? 'The lead reads this, writes the brief and starts the right sessions. Name a bot to skip the lead.' : 'This studio has no lead to hand work out, so name the bot that should do it.'}</Txt>
        <Field label="What needs doing?" value={title} onChangeText={setTitle} maxLength={200} placeholder="Fix the map loading crash" />
        <Field label="Details" value={details} onChangeText={setDetails} multiline tall maxLength={8000} placeholder="Anything the bots should know" />
        {projects.length ? (
          <View style={styles.choice}>
            <Txt size={14} weight={600} color={t.ink2}>Game</Txt>
            <Chips value={game} options={[{ id: NONE, name: 'None' }, ...projects]} onChange={setGame} />
          </View>
        ) : null}
        <View style={styles.choice}>
          <Txt size={14} weight={600} color={t.ink2}>Who starts it</Txt>
          <Chips value={owner} options={lead ? [{ id: NONE, name: 'The lead decides' }, ...bots] : [{ id: NONE, name: 'Nobody yet' }, ...bots]} onChange={setOwner} />
        </View>
        <View style={styles.choice}>
          <Txt size={14} weight={600} color={t.ink2}>Priority</Txt>
          <Segmented value={priority} options={PRIORITIES} onChange={setPriority} />
        </View>
        <Button label={owner === NONE && lead ? 'Send to the lead' : 'Send'} onPress={submit} busy={busy} disabled={!title.trim()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const STATUS_WORDS: Record<string, string> = { backlog: 'Backlog', todo: 'Queued', in_progress: 'Running', in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };

export function ChoiceCard({ question, onAnswer, busy }: { question: Extract<Question, { kind: 'choice' }>; onAnswer: (answers: Answer[]) => void; busy: boolean }) {
  const { t } = useLook();
  const tap = useTap();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  // The owner's own answer, typed in Other; it replaces a one-choice pick.
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (item: QuestionItem, option: string) => {
    tap();
    setPicked((current) => {
      const now = current[item.id] ?? [];
      const next = item.multiple ? (now.includes(option) ? now.filter((id) => id !== option) : [...now, option]) : [option];
      return { ...current, [item.id]: next };
    });
  };
  const ready = question.items.every((item) => !item.required || picked[item.id]?.length || other[item.id]?.trim());
  const answers = (): Answer[] => question.items.map((item) => {
    const text = other[item.id]?.trim() ?? '';
    return { questionId: item.id, optionIds: text && !item.multiple ? [] : picked[item.id] ?? [], ...(text ? { otherText: text } : {}) };
  });
  return (
    <View style={[styles.question, { backgroundColor: t.card, borderColor: t.accent, borderWidth: t.hair }]}>
      <Txt size={12} weight={700} color={t.accentText}>Question for you</Txt>
      <Txt size={16} weight={600}>{question.title}</Txt>
      {question.items.map((item) => (
        <View key={item.id} style={styles.choice}>
          {item.prompt !== question.title ? <Txt size={14} color={t.ink2}>{item.prompt}</Txt> : null}
          {item.options.map((option) => {
            const active = picked[item.id]?.includes(option.id);
            return (
              <Pressable
                key={option.id}
                accessibilityRole={item.multiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: Boolean(active) }}
                onPress={() => toggle(item, option.id)}
                style={[styles.option, { backgroundColor: active ? t.accent : t.control }]}
              >
                <View style={styles.flex}>
                  <Txt size={15} weight={600} color={active ? t.accentInk : t.ink}>{option.label}</Txt>
                  {option.hint ? <Txt size={13} color={active ? t.accentInk : t.ink2}>{option.hint}</Txt> : null}
                </View>
                {active ? <Icon name="check" size={18} color={t.accentInk} weight={3} /> : null}
              </Pressable>
            );
          })}
          <TextInput
            value={other[item.id] ?? ''}
            onChangeText={(value) => setOther((current) => ({ ...current, [item.id]: value }))}
            multiline
            maxLength={4000}
            accessibilityLabel={item.options.length ? 'Other answer' : 'Your answer'}
            placeholder={item.options.length ? 'Other: none of these? Write your own answer' : 'Write your answer'}
            placeholderTextColor={t.ink3}
            style={[styles.other, plainField, { backgroundColor: t.control, color: t.ink, borderColor: other[item.id]?.trim() ? t.accent : t.edge }]}
          />
        </View>
      ))}
      <Button label="Send answer" busy={busy} disabled={!ready} onPress={() => onAnswer(answers())} />
    </View>
  );
}

export function ConfirmCard({ question, onAccept, onReject, busy }: { question: Extract<Question, { kind: 'confirm' }>; onAccept: () => void; onReject: () => void; busy: boolean }) {
  const { t } = useLook();
  return (
    <View style={[styles.question, { backgroundColor: t.card, borderColor: t.accent, borderWidth: t.hair }]}>
      <Txt size={12} weight={700} color={t.accentText}>Needs your yes or no</Txt>
      <Txt size={16} weight={600}>{question.title}</Txt>
      {question.prompt ? <Txt size={14} color={t.ink2}>{question.prompt}</Txt> : null}
      <View style={styles.pair}>
        <View style={styles.flex}><Button label={question.accept} onPress={onAccept} busy={busy} /></View>
        <View style={styles.flex}><Button label={question.reject} kind="danger" onPress={onReject} busy={busy} /></View>
      </View>
    </View>
  );
}

function Linked({ jobs, nav }: { jobs: LinkedJob[]; nav: Nav }) {
  const { t } = useLook();
  return (
    <Group>
      {jobs.map((job, index) => (
        <Line key={job.id} title={job.title} note={job.ref} last={index === jobs.length - 1} onPress={() => nav.push({ name: 'job', id: job.id })}
          right={<Tag text={job.state} color={job.status === 'done' ? t.good : job.status === 'blocked' ? t.bad : t.ink3} />} />
      ))}
    </Group>
  );
}

/** A document a bot wrote on the job, shut until opened: they run long. Its earlier versions can be restored. */
function Doc({ doc, job, connection, onRestored }: { doc: JobMore['documents'][number]; job: string; connection: Connection; onRestored: () => void }) {
  const { t } = useLook();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<DocRevision[] | null>(null);
  const [showing, setShowing] = useState(false);
  const [trouble, setTrouble] = useState('');
  const { busy, run } = useAct();

  const read = async () => {
    try {
      setVersions((await getDocRevisions(connection, job, doc.key)).revisions);
      setTrouble('');
    } catch (err) {
      setTrouble((err as Error).message);
    }
  };
  const toggle = () => {
    setShowing(!showing);
    if (!showing) read();
  };
  const restore = (v: DocRevision) => ask(`Restore version ${v.number} of \u201c${doc.title}\u201d?`, 'It is saved as a new version; nothing is lost.', 'Restore', () => {
    run(v.id, async () => {
      await restoreDoc(connection, job, doc.key, v.id);
      onRestored();
      await read();
    }, 'That version was not restored');
  });
  const earlier = versions?.filter((v) => v.number !== doc.revision) ?? [];

  return (
    <View style={[styles.doc, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.docHead}>
        <View style={styles.flex}>
          <Txt size={15} weight={600}>{doc.title}</Txt>
          <Txt size={12} color={t.ink3}>{`Version ${doc.revision}, by ${doc.by}`}</Txt>
        </View>
        <Icon name={open ? 'up' : 'down'} size={18} color={t.ink3} />
      </Pressable>
      {open ? <Markdown text={doc.body} ink={t.ink} size={14} /> : null}
      {open && doc.trimmed ? <Txt size={12} color={t.ink3}>The rest is on the PC.</Txt> : null}
      {open ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showing }} onPress={toggle} style={({ pressed }) => [styles.versionsHead, { borderTopColor: t.line }, pressed && styles.pressed]}>
          <Txt size={14} weight={600} color={t.accentText}>{showing ? 'Hide earlier versions' : 'Earlier versions'}</Txt>
        </Pressable>
      ) : null}
      {open && showing ? (
        trouble ? <Txt size={13} color={t.bad}>{trouble}</Txt>
          : !versions ? <ActivityIndicator color={t.accent} />
            : earlier.length ? earlier.map((v) => (
              <View key={v.id} style={styles.version}>
                <View style={styles.flex}>
                  <Txt size={14} weight={600}>{`Version ${v.number}`}</Txt>
                  <Txt size={12} color={t.ink3} numberOfLines={2}>{[v.by, ago(v.at), v.note].filter(Boolean).join(', ')}</Txt>
                </View>
                <Small label="Restore" disabled={Boolean(busy)} onPress={() => restore(v)} />
              </View>
            )) : <Txt size={13} color={t.ink2}>This is its only version. Each change a bot saves is kept here.</Txt>
      ) : null}
    </View>
  );
}

/** What the PC's job page has beyond the phone's first read: where it sits, documents, runs and cost. */
function JobExtras({ more, nav, job, connection, onChange }: { more: JobMore; nav: Nav; job: string; connection: Connection; onChange: () => void }) {
  const { t } = useLook();
  return (
    <>
      {more.parent ? (<><Label>Part of</Label><Linked jobs={[more.parent]} nav={nav} /></>) : null}
      {more.children.length ? (<><Label>{`Sub-jobs, ${more.children.filter((c) => c.status === 'done').length} of ${more.children.length} done`}</Label><Linked jobs={more.children} nav={nav} /></>) : null}
      {more.blocks.length ? (<><Label>Holds up</Label><Linked jobs={more.blocks} nav={nav} /></>) : null}
      {more.documents.length ? (<><Label>Documents</Label>{more.documents.map((doc) => <Doc key={doc.key} doc={doc} job={job} connection={connection} onRestored={onChange} />)}</>) : null}
      {more.files.length || more.products.length ? (
        <>
          <Label>Files</Label>
          <Group>
            {more.products.map((w, index) => <Line key={w.id} title={w.title} detail={w.summary || undefined} last={!more.files.length && index === more.products.length - 1} onPress={() => Linking.openURL(w.url)} />)}
            {more.files.map((f, index) => <Line key={f.id} title={f.name} note={`${f.kind}, ${Math.max(1, Math.round(f.size / 1024))} KB`} last={index === more.files.length - 1} />)}
          </Group>
        </>
      ) : null}
      {more.runs.length ? (
        <>
          <Label>{`Runs, ${more.runs.filter((r) => r.failed).length} failed`}</Label>
          <Group>
            {more.runs.map((run, index) => <RunLine key={run.id} run={run} showBot last={index === more.runs.length - 1} onOpen={() => nav.push({ name: 'run', id: run.id })} />)}
          </Group>
        </>
      ) : null}
      {more.cost && (more.cost.tokens || more.cost.runs) ? (
        <Txt size={13} color={t.ink3}>{['Used', `${tokens(more.cost.tokens)} tokens`, more.cost.cached ? `${tokens(more.cost.cached)} cached` : '', plural(more.cost.runs, 'run'), seconds(more.cost.seconds), more.cost.cents ? `$${(more.cost.cents / 100).toFixed(2)}` : '', more.cost.withSubJobs ? 'with its sub-jobs' : ''].filter(Boolean).join(', ').replace('Used, ', 'Used ')}</Txt>
      ) : null}
    </>
  );
}

export function JobScreen({ id, connection, crew, nav }: { id: string; connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const tap = useTap();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const [more, setMore] = useState<JobMore | null>(null);

  const load = useCallback(async () => {
    try {
      setJob(await getJob(connection, id));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection, id]);
  // The rest of the page changes slowly and costs the engine a dozen reads: once on opening, and after each change.
  const loadMore = useCallback(() => getJobMore(connection, id).then(setMore).catch(() => undefined), [connection, id]);
  useEffect(() => {
    loadMore();
  }, [loadMore]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const send = async () => {
    setBusy(true);
    try {
      await addComment(connection, id, text);
      setText('');
      await load();
    } catch (err) {
      tell('The comment was not sent', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (work: () => Promise<unknown>) => {
    setActing(true);
    try {
      await work();
      tap('done');
      await load();
      loadMore();
    } catch (err) {
      tell('That did not work', (err as Error).message);
    } finally {
      setActing(false);
    }
  };

  const confirm = (title: string, message: string, label: string, work: () => Promise<unknown>) => ask(title, message, label, () => act(work), 'Keep going');

  const closed = job?.status === 'done' || job?.status === 'cancelled';
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
        <GlassButton icon="back" label="Back" onPress={nav.back} />
        {!job ? (error ? <Txt color={t.bad}>{error}</Txt> : <ActivityIndicator color={t.accent} />) : (
          <>
            <Txt size={26} weight={700}>{job.title}</Txt>
            <Txt size={14} color={t.ink2}>{[job.ref, STATUS_WORDS[job.status] ?? job.status, job.project, job.bot].filter(Boolean).join(', ')}</Txt>

            {more?.blockedBy.length ? (
              <>
                <Txt size={12} weight={700} color={t.bad}>Waiting on</Txt>
                <Linked jobs={more.blockedBy} nav={nav} />
              </>
            ) : null}

            {job.run?.live ? (
              <View style={[styles.banner, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}>
                <View style={styles.flex}>
                  <Txt size={15} weight={600}>{job.run.bot || 'A bot'} is working on this</Txt>
                </View>
                <Button label="Stop" kind="danger" busy={acting} onPress={() => confirm('Stop this run?', 'The job stays open. Comment on it to start it again.', 'Stop', () => jobAction(connection, id, 'stop'))} />
              </View>
            ) : null}
            {job.run?.why ? (
              <View style={[styles.failure, { borderColor: t.bad, borderWidth: t.hair }]}>
                <Txt size={12} weight={700} color={t.bad}>The last run failed</Txt>
                <Txt size={14} selectable>{job.run.why}</Txt>
              </View>
            ) : null}
            {job.run && !job.run.live && job.run.status === 'cancelled' && !closed ? <Txt size={14} color={t.ink2}>Stopped. Comment below to start it again.</Txt> : null}

            {job.questions.map((question) => (question.kind === 'choice' ? (
              <ChoiceCard key={question.id} question={question} busy={acting} onAnswer={(answers) => act(() => answerQuestion(connection, id, question.id, answers))} />
            ) : (
              <ConfirmCard key={question.id} question={question} busy={acting} onAccept={() => act(() => acceptQuestion(connection, id, question.id))} onReject={() => act(() => rejectQuestion(connection, id, question.id))} />
            )))}

            {job.previews.map((preview) => (preview.ok ? (
              <View key={preview.name} style={[styles.play, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}>
                <View style={styles.flex}>
                  <Txt size={15} weight={600}>{preview.name} is ready</Txt>
                  <Txt size={13} color={preview.errors ? t.warn : t.ink2}>
                    {preview.errors ? `Loaded with ${preview.errors} script error${preview.errors === 1 ? '' : 's'}` : `Built ${clock(preview.builtAt)} from ${preview.commit}`}
                  </Txt>
                </View>
                <Button label="Play" onPress={() => Linking.openURL(preview.url)} />
              </View>
            ) : (
              <View key={preview.name} style={[styles.failure, { borderColor: t.bad, borderWidth: t.hair }]}>
                <Txt size={12} weight={700} color={t.bad}>The {preview.name} build failed</Txt>
                {preview.note ? <Txt size={13} selectable numberOfLines={8} color={t.ink2}>{preview.note}</Txt> : null}
              </View>
            )))}

            {job.proof.length ? (
              <>
                <Label>Proof</Label>
                <ProofRow connection={connection} proof={job.proof} />
              </>
            ) : null}

            {job.changes?.files ? (
              <Pressable accessibilityRole="button" onPress={() => nav.push({ name: 'changes', id })} style={({ pressed }) => [styles.play, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }, pressed && styles.pressed]}>
                <View style={styles.flex}>
                  <Txt size={15} weight={600}>Code changes</Txt>
                  <Txt size={13} color={t.ink2}>{job.changes.files} file{job.changes.files === 1 ? '' : 's'}, <Txt size={13} color={t.good}>+{job.changes.added}</Txt> <Txt size={13} color={t.bad}>-{job.changes.removed}</Txt></Txt>
                </View>
                <Icon name="chevron" size={18} color={t.ink3} />
              </Pressable>
            ) : null}

            {job.description ? <Markdown text={job.description} ink={t.ink} size={15} /> : null}
            {more ? <JobExtras more={more} nav={nav} job={id} connection={connection} onChange={loadMore} /> : null}
            <Label>Updates</Label>
            {job.comments.length === 0 ? <Txt color={t.ink2}>No updates yet.</Txt> : null}
            {job.comments.map((comment) => {
              const bot = crew.bots?.find((b) => b.name === comment.from);
              const who = portraitOf(bot ?? { name: comment.from }, bot ? p.bots[bot.id] : undefined);
              return (
                <View key={comment.id} style={styles.update}>
                  <BotBadge who={who} size={34} />
                  <View style={[styles.updateBody, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}>
                    <Txt size={13} weight={700} color={readable(who.colour, [t.card], 4.5, t.dark ? '#ffffff' : '#000000')}>{who.name}</Txt>
                    <Markdown text={comment.text} ink={t.ink} size={15} />
                  </View>
                </View>
              );
            })}
            <Button label="Review: mark what to change" kind="quiet" icon="pin" onPress={() => nav.push({ name: 'review', job: id })} />
            <Field label="Reply to the bots" value={text} onChangeText={setText} multiline tall maxLength={8000} placeholder="Answer a question or change the plan" />
            <Button label="Send" onPress={send} busy={busy} disabled={!text.trim()} />
            {closed ? (
              <Button label="Reopen this job" kind="quiet" icon="reset" busy={acting} onPress={() => act(() => jobAction(connection, id, 'reopen'))} />
            ) : (
              <Button label="Cancel this job" kind="danger" busy={acting} onPress={() => confirm('Cancel this job?', 'You can reopen it later.', 'Cancel job', () => jobAction(connection, id, 'cancel'))} />
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  other: { borderRadius: 12, borderWidth: 1.5, fontSize: 15, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, textAlignVertical: 'top' },
  fill: { flex: 1 },
  page: { gap: 12, paddingHorizontal: 18 },
  update: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  updateBody: { borderRadius: 16, flex: 1, gap: 4, padding: 12 },
  flex: { flex: 1 },
  play: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 12, minHeight: 64, paddingHorizontal: 14, paddingVertical: 10 },
  pressed: { opacity: 0.7 },
  choice: { gap: 8 },
  pair: { flexDirection: 'row', gap: 10 },
  banner: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 12, padding: 12 },
  failure: { borderRadius: 18, gap: 4, padding: 14 },
  question: { borderRadius: 18, gap: 10, padding: 14 },
  doc: { borderRadius: 18, gap: 8, padding: 14 },
  docHead: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44 },
  versionsHead: { borderTopWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 44, paddingTop: 6 },
  version: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44 },
  option: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 9 },
});
