import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { addRoutine, Connection, getHelpers, getRoutines, getSummary, getTimers, Helper, helperAction, Helpers, Plan, Project, Routine, routineAction, Timer } from '../api';
import { Crew, handsOf, leadOf, Nav } from '../crew';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { Note, planProblem, Small, START_PLAN, timezone, useAct, WhenPicker } from '../ui/form';
import { Button, Chips, Field, GlassButton, Group, Label, Title, Toggle, Txt, useTap } from '../ui/kit';
import { shortWhen } from '../ui/time';
import { ago, dayClock, Line, Tag } from '../ui/page';

const DAYS = 7;
const NONE = 'none';
const ms = (at: number | string | null) => (typeof at === 'string' ? Date.parse(at) : at) || 0;

/** Whether a routine runs on a day of the week (0 is Sunday), from its plan; a hand-written timetable is read by its last part. */
const runsOn = (routine: Routine, day: number) => {
  const plan = routine.plan;
  if (plan && plan.kind !== 'cron') return plan.kind === 'weekly' ? plan.day === day : plan.kind === 'weekdays' ? day >= 1 && day <= 5 : true;
  const field = (plan?.kind === 'cron' ? plan.cron : routine.cron).trim().split(/\s+/)[4];
  if (!field) return false;
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const [from, to] = part.split('-').map((n) => Number(n) % 7);
    return to === undefined ? from === day : from <= to ? day >= from && day <= to : day >= from || day <= to;
  });
};

/** The next seven days, with a dot for each routine that runs. Paused routines are left out. */
function Week({ routines }: { routines: Routine[] }) {
  const { t } = useLook();
  const days = useMemo(() => Array.from({ length: DAYS }, (_, offset) => {
    const date = new Date(Date.now() + offset * 86_400_000);
    return { name: date.toLocaleDateString(undefined, { weekday: 'narrow' }), long: date.toLocaleDateString(undefined, { weekday: 'long' }), number: date.getDate(), today: offset === 0, count: routines.filter((r) => !r.paused && r.cron && runsOn(r, date.getDay())).length };
  }), [routines]);
  return (
    <Group>
      <View style={styles.week}>
        {days.map((day) => (
          <View key={day.number} accessible accessibilityLabel={`${day.today ? 'Today, ' : ''}${day.long} ${day.number}: ${day.count ? `${day.count} routine${day.count === 1 ? '' : 's'}` : 'nothing'} due`} style={styles.day}>
            <Txt size={12} color={t.ink3}>{day.name}</Txt>
            <View style={[styles.date, day.today && { backgroundColor: t.accent }]}>
              <Txt size={14} weight={600} color={day.today ? t.accentInk : t.ink}>{day.number}</Txt>
            </View>
            <View style={styles.dots}>{Array.from({ length: Math.min(day.count, 3) }, (_, n) => <View key={n} style={[styles.dot, { backgroundColor: t.accent }]} />)}</View>
          </View>
        ))}
      </View>
    </Group>
  );
}

/** The helper scripts the service runs for the crew: each one's last run, its next, run now, and on or off. */
function HelpersPart({ connection, helpers, onChange }: { connection: Connection; helpers: Helpers | null; onChange: (next: Helpers) => void }) {
  const { t } = useLook();
  const { busy, run } = useAct();
  if (!helpers) return null;
  const off = helpers.state !== 'on';
  const act = (action: 'on' | 'off' | 'run', name?: string) => run(`${action}:${name ?? ''}`, async () => onChange(await helperAction(connection, action, name)));
  const whole = () => {
    if (off) return void act('on');
    ask('Turn the whole timetable off?', 'No helper runs by itself until you turn it on again: nothing checks on the crew, hands out work or watches the limits. "Run now" still works for each one.', 'Turn it off', () => { act('off'); });
  };
  const state = (j: Helper) => (!j.ready ? <Tag text="Not ready" color={t.ink3} /> : j.running ? <Tag text="Running" color={t.accentText} /> : !j.on || off ? <Tag text="Off" color={t.ink3} /> : j.lastAt && !j.lastOk ? <Tag text="Failed" color={t.bad} /> : <Tag text="On" color={t.good} />);
  return (
    <>
      <Label>Helpers</Label>
      <Txt size={13} color={t.ink2}>The small scripts the service runs for the crew, each on its own timetable.</Txt>
      {!helpers.available || !helpers.jobs.length ? <Txt color={t.ink2}>{helpers.why || 'This studio has no helpers yet. They come with a crew: add one from Bots.'}</Txt> : (
        <>
          {off ? <Note tone="warn">{`The helper timetable is off${helpers.why ? `: ${helpers.why}` : '.'} "Run now" still works.`}</Note> : null}
          {helpers.jobs.map((j) => (
            <View key={j.name} style={[styles.card, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0, borderRadius: t.r.card, boxShadow: t.shadow }]}>
              <View style={styles.cardHead}>
                <View style={styles.fill}>
                  <Txt size={15} weight={600}>{j.name}</Txt>
                  <Txt size={13} color={t.ink2}>{[j.what, j.when].filter(Boolean).join('. ')}</Txt>
                </View>
                {state(j)}
              </View>
              {j.notReady ? <Txt size={12} weight={600} color={t.warn}>{j.notReady}</Txt> : null}
              <Txt size={12} color={t.ink3}>
                {j.lastAt ? `Last ran ${ago(j.lastAt)}${j.lastOk ? '' : `: ${j.lastError || 'it ended with an error'}`}` : 'Not run yet'}
                {j.nextAt && j.on && !off ? `. Next ${dayClock(ms(j.nextAt))}` : ''}
              </Txt>
              <View style={styles.actions}>
                <Small label="Run now" disabled={j.running || !j.ready || Boolean(busy)} onPress={() => act('run', j.name)} />
                <Small label={j.on ? 'Turn off' : 'Turn on'} disabled={Boolean(busy)} onPress={() => act(j.on ? 'off' : 'on', j.name)} />
              </View>
            </View>
          ))}
          <Button label={off ? 'Turn the timetable on' : 'Turn the whole timetable off'} kind={off ? 'primary' : 'quiet'} busy={busy === 'on:' || busy === 'off:'} disabled={Boolean(busy)} onPress={whole} />
        </>
      )}
    </>
  );
}

export function RoutinesScreen({ connection, crew, nav }: { connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const tap = useTap();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [plan, setPlan] = useState<Plan>(START_PLAN);
  const [owner, setOwner] = useState(NONE);
  const [game, setGame] = useState(NONE);
  const [busy, setBusy] = useState(false);
  const [timers, setTimers] = useState<Timer[] | null>(null);
  const [helpers, setHelpers] = useState<Helpers | null>(null);

  const load = useCallback(async () => {
    try {
      setRoutines((await getRoutines(connection)).routines);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => {
    load();
    getSummary(connection).then((summary) => setProjects(summary.projects ?? [])).catch(() => undefined);
    getTimers(connection).then((answer) => setTimers(answer.timers)).catch(() => undefined);
    getHelpers(connection).then(setHelpers).catch(() => undefined);
  }, [connection, load]);

  const act = async (routine: Routine, action: 'run' | 'pause' | 'resume' | 'remove') => {
    try {
      await routineAction(connection, routine.id, action);
      tap('done');
      await load();
    } catch (err) {
      tell('That did not work', (err as Error).message);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await addRoutine(connection, {
        title,
        description: details,
        plan,
        timezone: timezone(),
        ...(owner !== NONE ? { botId: owner } : {}),
        ...(game !== NONE ? { projectId: game } : {}),
      });
      setTitle('');
      setDetails('');
      setPlan(START_PLAN);
      setAdding(false);
      await load();
    } catch (err) {
      tell('The routine was not added', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lead = leadOf(crew.bots);
  const bots = handsOf(crew.bots).map((bot) => ({ id: bot.id, name: portraitOf(bot, p.bots[bot.id]).name }));
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.head}>
          <GlassButton icon="back" label="Back" onPress={nav.back} />
          <GlassButton icon={adding ? 'close' : 'plus'} label={adding ? 'Close the form' : 'New routine'} onPress={() => setAdding(!adding)} />
        </View>
        <Title>Routines and helpers</Title>
        <Txt color={t.ink2}>Work that starts by itself. Each routine run becomes a job you can open; the helpers are the small scripts that keep the crew moving.</Txt>

        {adding ? (
          <View style={styles.form}>
            <Field label="What should happen?" value={title} onChangeText={setTitle} maxLength={200} placeholder="Run the test suite" />
            <Field label="Details" value={details} onChangeText={setDetails} multiline tall maxLength={8000} placeholder="What to check and what to report" />
            <View style={styles.choice}>
              <Txt size={14} weight={600} color={t.ink2}>When it runs</Txt>
              <Group><WhenPicker onChange={setPlan} /></Group>
              {planProblem(plan) ? <Txt size={13} color={t.bad}>{planProblem(plan)}</Txt> : null}
            </View>
            <View style={styles.choice}>
              <Txt size={14} weight={600} color={t.ink2}>Who runs it</Txt>
              <Chips value={owner} options={[{ id: NONE, name: lead ? 'The lead decides' : 'Nobody yet' }, ...bots]} onChange={setOwner} />
            </View>
            {projects.length ? (
              <View style={styles.choice}>
                <Txt size={14} weight={600} color={t.ink2}>Project</Txt>
                <Chips value={game} options={[{ id: NONE, name: 'None' }, ...projects]} onChange={setGame} />
              </View>
            ) : null}
            <Button label="Add routine" onPress={create} busy={busy} disabled={!title.trim() || Boolean(planProblem(plan))} />
          </View>
        ) : null}

        {error ? <Txt color={t.bad}>{error}</Txt> : null}
        {!routines && !error ? <ActivityIndicator color={t.accent} /> : null}
        {routines?.length ? <Label>Next 7 days</Label> : null}
        {routines?.length ? <Week routines={routines} /> : null}
        {routines?.length ? <Label>All routines</Label> : null}
        {routines && !routines.length && !adding ? <Txt color={t.ink2} style={styles.empty}>Nothing runs by itself yet. Tap the plus above to add a nightly test run or a weekly check.</Txt> : null}
        {routines?.map((routine) => {
          const words = routine.when || 'No time set';
          return (
            <View key={routine.id} style={[styles.card, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0, borderRadius: t.r.card, boxShadow: t.shadow }]}>
              <View style={styles.cardHead}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Open ${routine.title}`} onPress={() => nav.push({ name: 'routine', id: routine.id })} style={({ pressed }) => [styles.fill, pressed && styles.dim]}>
                  <Txt size={16} weight={600}>{routine.title}</Txt>
                  <Txt size={13} color={t.ink2}>{[words, routine.bot, routine.project].filter(Boolean).join(', ')}</Txt>
                </Pressable>
                <Toggle label={`${routine.title}: runs on its timetable`} value={!routine.paused} onChange={(on) => act(routine, on ? 'resume' : 'pause')} />
              </View>
              <Txt size={12} color={t.ink3}>
                {routine.paused ? 'Paused' : routine.nextAt ? `Next run ${shortWhen(routine.nextAt)}` : 'Waiting for its first run'}
                {routine.lastAt ? `. Last ran ${shortWhen(routine.lastAt)}${routine.lastStatus ? `, ${routine.lastStatus.replace(/_/g, ' ')}` : ''}.` : ''}
              </Txt>
              <View style={styles.actions}>
                <Small label="Run now" onPress={() => act(routine, 'run')} />
                <Small label="Change" onPress={() => nav.push({ name: 'routine', id: routine.id })} />
                <Small label="Remove" danger onPress={() => ask('Remove this routine?', `${routine.title}. It stops running by itself. The jobs it already made stay.`, 'Remove', () => act(routine, 'remove'))} />
              </View>
            </View>
          );
        })}

        <HelpersPart connection={connection} helpers={helpers} onChange={setHelpers} />

        {timers?.length && !helpers?.jobs.length ? (
          <>
            <Label>The crew's timers</Label>
            <Group>
              {timers.map((timer, index) => (
                <Line key={timer.id} title={timer.name} detail={timer.next ? `Next ${dayClock(timer.next)}` : 'Not planned'} note={timer.last ? `Last ran ${ago(timer.last)}` : undefined} last={index === timers.length - 1} />
              ))}
            </Group>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dim: { opacity: 0.6 },
  page: { gap: 12, paddingHorizontal: 16 },
  head: { flexDirection: 'row', justifyContent: 'space-between' },
  form: { gap: 12 },
  choice: { gap: 8 },
  empty: { marginTop: 12 },
  week: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 12 },
  day: { alignItems: 'center', gap: 4, width: 40 },
  date: { alignItems: 'center', borderRadius: 16, height: 32, justifyContent: 'center', width: 32 },
  dots: { flexDirection: 'row', gap: 3, height: 6 },
  dot: { borderRadius: 3, height: 6, width: 6 },
  card: { borderRadius: 18, gap: 8, padding: 14 },
  cardHead: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
