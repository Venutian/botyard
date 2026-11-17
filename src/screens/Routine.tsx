/** One routine: what it does and who runs it, when it runs (the same plain choices as adding one), its last runs, and removing it. */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Connection, editRoutine, getRoutine, getSummary, Plan, Project, routineAction, setRoutineSchedule } from '../api';
import { Crew, Nav } from '../crew';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { ask } from '../ui/ask';
import { planProblem, timezone, useAct, useLeaveGuard, WhenPicker } from '../ui/form';
import { Button, Chips, Field, Group, Label, Row, Toggle, Txt } from '../ui/kit';
import { ago, Line, Page, Tag, useLoad } from '../ui/page';
import { shortWhen } from '../ui/time';

const samePlan = (a: Plan, b: Plan | null) => {
  if (!b || a.kind !== b.kind) return false;
  const [x, y] = [a, b] as Record<string, unknown>[];
  return ['n', 'at', 'day', 'cron'].every((key) => String(x[key] ?? '') === String(y[key] ?? ''));
};

export function RoutineScreen({ id, connection, crew, nav }: { id: string; connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const { data: r, error, load } = useLoad(() => getRoutine(connection, id), [connection, id]);
  const { busy, run } = useAct();
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [bot, setBot] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  /** The picker starts again from what was saved. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    getSummary(connection).then((summary) => setProjects(summary.projects ?? [])).catch(() => undefined);
  }, [connection]);

  const change = r ? {
    ...(title !== null && title.trim() !== r.title ? { title: title.trim() } : {}),
    ...(details !== null && details.trim() !== r.description ? { description: details.trim() } : {}),
    ...(bot && bot !== r.botId ? { botId: bot } : {}),
    ...(project && project !== r.projectId ? { projectId: project } : {}),
  } : {};
  const changed = Object.keys(change).length > 0;
  const planChanged = Boolean(r && plan && !samePlan(plan, r.plan));
  useLeaveGuard('routine', changed || planChanged, nav.back, 'The changes to this routine have not been saved.');
  const problem = plan ? planProblem(plan) : '';

  const save = () => run('save', async () => {
    await editRoutine(connection, id, change);
    await load();
    setTitle(null);
    setDetails(null);
    setBot(null);
    setProject(null);
  }, 'The changes were not saved');
  const saveTime = () => plan && run('time', async () => {
    await setRoutineSchedule(connection, id, plan, r?.timezone || timezone());
    await load();
    setPlan(null);
    setRound((n) => n + 1);
  }, 'The time was not saved');
  const act = (action: 'run' | 'pause' | 'resume') => run(action, async () => {
    await routineAction(connection, id, action);
    await load();
  });
  const remove = () => r && ask('Remove this routine?', `${r.title}. It stops running by itself. The jobs it already made stay.`, 'Remove', () => {
    run('remove', async () => {
      await routineAction(connection, id, 'remove');
      nav.back();
    }, 'The routine was not removed');
  });

  const bots = (crew.bots ?? []).map((b) => ({ id: b.id, name: portraitOf(b, p.bots[b.id]).name }));
  return (
    <Page title={r?.title ?? 'Routine'} note={r ? [r.when || 'No time set', r.bot, r.project].filter(Boolean).join(', ') : undefined} onBack={nav.back} onRefresh={changed || planChanged ? undefined : load} error={error} loading={!r}>
      {r ? (
        <>
          <Group>
            <Row title={r.paused ? 'Paused' : 'Runs by itself'} detail={r.paused ? 'It does not start until you switch it on' : r.nextAt ? `Next run ${shortWhen(r.nextAt)}` : 'Waiting for its first run'} last
              right={<Toggle label={`${r.title}: runs by itself`} value={!r.paused} onChange={(on) => { act(on ? 'resume' : 'pause'); }} />} />
          </Group>
          <Button label="Run it now" kind="quiet" busy={busy === 'run'} disabled={Boolean(busy)} onPress={() => { act('run'); }} />

          <Label>When it runs</Label>
          <Group><WhenPicker key={round} start={r.plan} onChange={setPlan} /></Group>
          {r.timezone ? <Txt size={12} color={t.ink3}>{`Times are in ${r.timezone}.`}</Txt> : null}
          {planChanged && problem ? <Txt size={13} color={t.bad}>{problem}</Txt> : null}
          <Button label="Save the time" busy={busy === 'time'} disabled={!planChanged || Boolean(problem) || Boolean(busy)} onPress={() => { saveTime(); }} />

          <Label>What it does</Label>
          <View style={styles.stack}>
            <Field label="What should happen?" value={title ?? r.title} onChangeText={setTitle} maxLength={200} />
            <Field label="Details" value={details ?? r.description} onChangeText={setDetails} multiline tall maxLength={4000} placeholder="What to check and what to report" />
            {bots.length ? (
              <View style={styles.pick}>
                <Txt size={14} weight={600} color={t.ink2}>Who runs it</Txt>
                <Chips value={bot ?? r.botId} options={bots} onChange={setBot} />
              </View>
            ) : null}
            {projects.length ? (
              <View style={styles.pick}>
                <Txt size={14} weight={600} color={t.ink2}>Project</Txt>
                <Chips value={project ?? r.projectId} options={projects} onChange={setProject} />
              </View>
            ) : null}
            {changed ? <Tag text="Changed since last save" color={t.warn} /> : null}
            <Button label="Save changes" busy={busy === 'save'} disabled={!changed || (title !== null && !title.trim()) || Boolean(busy)} onPress={save} />
          </View>

          <Label>Last runs</Label>
          {r.runs.length ? (
            <Group>
              {r.runs.map((one, index) => (
                <Line key={one.id} title={one.job ? `${one.job.ref} ${one.job.title}` : 'No job was made'} detail={one.failed ? one.why || undefined : undefined} tone={t.bad} note={[ago(one.at), one.by].filter(Boolean).join(', ')}
                  right={<Tag text={one.state} color={one.failed ? t.bad : t.ink3} />} onPress={one.job ? () => nav.push({ name: 'job', id: one.job!.id }) : undefined} last={index === r.runs.length - 1} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>It has not run yet. Run it now to see the job it makes.</Txt>}

          <Label>Remove</Label>
          <Button label="Remove this routine" kind="danger" busy={busy === 'remove'} disabled={Boolean(busy)} onPress={remove} />
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  pick: { gap: 8 },
});
