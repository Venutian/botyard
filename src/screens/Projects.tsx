import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Connection, getProject, getProjects, ManagerProject, ProjectGoal, ProjectPlan, RankedProject, setGoal, setGuard } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Icon } from '../ui/Icon';
import { Button, Field, Group, Label, Row, styles as kit, Toggle, Txt, useTap } from '../ui/kit';
import { Markdown } from '../ui/Markdown';
import { Line, Page, plural, Tag, tokens, useLoad } from '../ui/page';
import { JobLine } from './Jobs';
import { stateTone } from './Crew';

/** A project's counts in one line: what runs, waits, is stuck, was done today, is not pushed. */
export function countsLine(p: ManagerProject | null) {
  if (!p) return 'Quiet';
  const parts = [
    p.running && `${p.running} running`,
    p.queued && `${p.queued} waiting`,
    p.blocked && `${p.blocked} blocked`,
    p.doneToday && `${p.doneToday} done today`,
    p.unpushed && `${p.unpushed} not pushed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Quiet';
}

function Move({ icon, label, disabled, onPress }: { icon: 'up' | 'down'; label: string; disabled: boolean; onPress: () => void }) {
  const { t } = useLook();
  const tap = useTap();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={4} onPress={() => { tap(); onPress(); }}
      style={({ pressed }) => [styles.move, { backgroundColor: t.control, borderColor: t.edge, opacity: disabled ? 0.3 : 1 }, pressed && kit.dim]}>
      <Icon name={icon} size={18} color={t.ink} />
    </Pressable>
  );
}

/**
 * The projects in the owner's order, highest first. A free bot takes its next job from the highest
 * project that has work for it. One on the shelf gets no new work and holds no rank.
 */
export function ProjectsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load, setData } = useLoad(() => getProjects(connection), [connection], 30_000);
  const [saving, setSaving] = useState(false);

  const save = async (change: { ranked?: string[]; shelved?: string[] }, shown: RankedProject[]) => {
    if (!data) return;
    const before = data;
    setData({ ...data, ...change, projects: shown });
    setSaving(true);
    try {
      await setGuard(connection, change);
      await load();
    } catch (err) {
      setData(before);
      tell('That did not work', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const live = data?.projects.filter((p) => !p.shelved) ?? [];
  const shelf = data?.projects.filter((p) => p.shelved) ?? [];
  const move = (name: string, by: number) => {
    const order = live.map((p) => p.name);
    const from = order.indexOf(name);
    const to = from + by;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    const byName = new Map(data!.projects.map((p) => [p.name, p]));
    save({ ranked: order }, [...order.map((n) => byName.get(n)!), ...shelf]);
  };
  const shelve = (project: RankedProject, on: boolean) => {
    const names = new Set(data!.shelved);
    if (on) names.delete(project.name);
    else names.add(project.name);
    save({ shelved: [...names] }, data!.projects.map((p) => (p.name === project.name ? { ...p, shelved: !on } : p)));
  };

  return (
    <Page title="Projects" note="Highest first: a free bot takes its next job from the highest project with work it can do." onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {live.length ? (
        <Group>
          {live.map((project, index) => (
            <View key={project.id} style={[styles.rank, index < live.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <Txt size={17} weight={700} color={t.accentText} style={styles.number}>{index + 1}</Txt>
              <Pressable accessibilityRole="button" onPress={() => nav.push({ name: 'project', id: project.id })} style={({ pressed }) => [kit.flex, styles.open, pressed && kit.dim]}>
                <Txt size={15} weight={600}>{project.name}</Txt>
                <Txt size={13} color={project.blocked ? t.bad : t.ink2}>{countsLine(project)}</Txt>
              </Pressable>
              <Move icon="up" label={`Rank ${project.name} higher`} disabled={saving || index === 0} onPress={() => move(project.name, -1)} />
              <Move icon="down" label={`Rank ${project.name} lower`} disabled={saving || index === live.length - 1} onPress={() => move(project.name, 1)} />
            </View>
          ))}
        </Group>
      ) : null}
      {shelf.length ? (
        <>
          <Label>On the shelf: no new work</Label>
          <Group>
            {shelf.map((project, index) => (
              <Row key={project.id} title={project.name} detail={countsLine(project)} last={index === shelf.length - 1}
                right={<Toggle label={`${project.name} is active`} value={false} onChange={(on) => shelve(project, on)} />} />
            ))}
          </Group>
        </>
      ) : null}
      {live.length ? <Txt size={12} color={t.ink3}>Open a project to put it on the shelf. The lead hears of a new order within half an hour.</Txt> : null}
      {data && !data.projects.length ? <Txt color={t.ink2}>This studio has no projects yet. Add the folder your code is in, and the crew can work there.</Txt> : null}
      {data ? (
        <Group>
          <Line title="Add a project" detail="A folder on the computer Botyard runs on, or a GitHub address" onPress={() => nav.push({ name: 'projectNew' })} last />
        </Group>
      ) : null}
    </Page>
  );
}

/**
 * A project's goal as the lead reads it, so the owner sees what the lead is working towards and can
 * change it. With no goal, what the lead does instead. Edit writes it where the lead reads it and,
 * unless switched off, tells the lead in its chat.
 */
function GoalCard({ goal, standing, onSave }: { goal: ProjectGoal; standing: string; onSave: (g: ProjectGoal & { tell: boolean }) => Promise<void> }) {
  const { t } = useLook();
  const [draft, setDraft] = useState<(ProjectGoal & { tell: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft) {
    const set = (k: keyof ProjectGoal) => (v: string) => setDraft({ ...draft, [k]: v });
    return (
      <View style={[styles.goal, { borderColor: t.accent }]}>
        <Field label="The goal" value={draft.goal} onChangeText={set('goal')} multiline tall placeholder="The outcome you want, in one or two lines" />
        <Field label="Done when" value={draft.doneWhen} onChangeText={set('doneWhen')} multiline tall placeholder="The checks or numbers that prove it" />
        <Field label="The next step" value={draft.first} onChangeText={set('first')} placeholder="What the crew does first" />
        <Field label="Set aside for now" value={draft.parked} onChangeText={set('parked')} placeholder="What this goal pushes aside" />
        <Field label="What the project is" value={draft.about} onChangeText={set('about')} multiline />
        <Row title="Tell the lead now" detail="So it works toward the goal from its next wake" last right={<Toggle label="Tell the lead" value={draft.tell} onChange={(tell) => setDraft({ ...draft, tell })} />} />
        <Button label="Save the goal" busy={busy} onPress={async () => { setBusy(true); try { await onSave(draft); setDraft(null); } finally { setBusy(false); } }} />
        <Button label="Keep it as it is" kind="quiet" onPress={() => setDraft(null)} />
      </View>
    );
  }
  const part = (name: string, text: string) => (text ? (
    <View style={styles.goalPart}>
      <Txt size={12} color={t.ink3}>{name}</Txt>
      <Txt size={14}>{text}</Txt>
    </View>
  ) : null);
  return (
    <View style={[styles.goal, { borderColor: t.accent, backgroundColor: t.card }]}>
      <View style={styles.goalHead}>
        <Txt size={14} weight={700} color={t.accentText}>Goal</Txt>
        {goal.setBy ? <Txt size={12} color={t.ink3} style={kit.flex}>set by {goal.setBy}</Txt> : <View style={kit.flex} />}
        <Button label={goal.goal ? 'Edit' : 'Set a goal'} kind="quiet" onPress={() => setDraft({ ...goal, tell: true })} />
      </View>
      {goal.goal ? <Txt size={18} weight={700}>{goal.goal}</Txt> : (
        <>
          <Txt size={16} weight={600} color={t.ink2}>No goal is set.</Txt>
          <Txt size={14} color={t.ink2}>{standing}</Txt>
        </>
      )}
      {part('Done when', goal.doneWhen)}
      {part('In the way now', goal.open)}
      {part('Next step', goal.first)}
      {part('Set aside', goal.parked)}
    </View>
  );
}

/** The lead's newest plan for the project: its aim, and the steps when they are written. */
function PlanCard({ plan, onOpen }: { plan: ProjectPlan; onOpen: () => void }) {
  const { t } = useLook();
  const [open, setOpen] = useState(false);
  const state = ({ done: 'Planned', in_progress: 'Planning now', todo: 'Waiting to plan', blocked: 'Blocked', cancelled: 'Dropped' } as Record<string, string>)[plan.status] || plan.status;
  return (
    <>
      <Label>The lead's plan</Label>
      <Group>
        <Line title={plan.title} detail={plan.goal ? `Aim: ${plan.goal}` : undefined} note={[plan.ref, state].filter(Boolean).join(', ')} onPress={onOpen} last={!plan.report} />
        {plan.report ? <Line title={open ? 'Hide the steps' : 'The steps and why'} onPress={() => setOpen(!open)} last /> : null}
      </Group>
      {open && plan.report ? <View style={styles.planText}><Markdown text={plan.report} ink={t.ink} size={14} /></View> : null}
    </>
  );
}

/** One project: who is in it now, its open work, its routines, what it used this week, and what was done. */
export function ProjectScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data: p, error, load } = useLoad(() => getProject(connection, id), [connection, id], 30_000);
  const [shelved, setShelved] = useState<boolean | null>(null);
  const onShelf = shelved ?? p?.shelved ?? false;

  const flip = async (active: boolean) => {
    if (!p) return;
    setShelved(!active);
    try {
      const all = await getProjects(connection);
      const names = new Set(all.shelved);
      if (active) names.delete(p.name);
      else names.add(p.name);
      await setGuard(connection, { shelved: [...names] });
      await load();
    } catch (err) {
      tell('That did not work', (err as Error).message);
    }
    setShelved(null);
  };

  return (
    <Page title={p?.name ?? 'Project'} note={p ? countsLine(p.counts) : undefined} onBack={nav.back} onRefresh={load} error={error} loading={!p}>
      {p ? (
        <>
          {p.goal ? <GoalCard goal={p.goal} standing={onShelf ? 'It is on the shelf: the lead gives nobody work here until you take it off.' : 'Without one, the lead works from what the project is and its own plan and notes, and briefs nothing toward a finish line. Set a goal to give the crew one.'}
            onSave={async (g) => {
              try {
                const done = await setGoal(connection, id, { about: g.about, goal: g.goal, doneWhen: g.doneWhen, first: g.first, parked: g.parked, tell: g.tell });
                tell(done.changed ? 'Goal saved' : 'Nothing changed', done.changed ? (done.told ? 'The lead is told in its chat and works toward it from its next wake.' : 'The lead reads it on its next wake.') : 'The goal was already this.');
                await load();
              } catch (err) {
                tell('The goal was not saved', (err as Error).message);
                throw err;
              }
            }} /> : null}
          <Group>
            <Row title={onShelf ? 'On the shelf' : 'Active'} detail={onShelf ? 'The lead gives nobody work here until you take it off' : 'The lead can give the crew work here'} last={!p.paused && !p.budget}
              right={<Toggle label={`${p.name} is active`} value={!onShelf} onChange={flip} />} />
            {p.paused ? <Row title="Paused" detail={p.paused} last={!p.budget} /> : null}
            {p.budget ? <Row title={`Budget: ${Math.round(p.budget.share)} % used`} detail={`${p.budget.used} of ${p.budget.amount} ${p.budget.metric}, ${p.budget.window}`} last /> : null}
          </Group>

          {p.bots.length ? (
            <>
              <Label>Here now</Label>
              <Group>
                {p.bots.map((bot, index) => (
                  <Line key={bot.id} title={bot.name} detail={bot.job ? `${bot.job.stage}: ${bot.job.ref} ${bot.job.title}` : bot.why || 'Free'} note={bot.model}
                    right={<Tag text={bot.status === 'running' ? 'Working' : bot.status} color={stateTone(bot.status, t)} />}
                    last={index === p.bots.length - 1} onPress={() => nav.push({ name: 'bot', botId: bot.id })} />
                ))}
              </Group>
            </>
          ) : null}

          <Label>Open work</Label>
          {p.lines.filter((l) => l.open).length ? (
            <Group>
              {p.lines.filter((l) => l.open).map((line, index, all) => (
                <Line key={line.id} title={line.title} detail={line.note} note={[line.ref, line.bot].filter(Boolean).join(', ')} tone={line.steps.includes('failed') ? t.bad : line.late ? t.warn : undefined}
                  last={index === all.length - 1} onPress={() => nav.push({ name: 'job', id: line.id })} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>Nothing open.</Txt>}
          <Line title="Every job in this project" onPress={() => nav.push({ name: 'jobs', project: id })} last />
          {p.plan ? <PlanCard plan={p.plan} onOpen={() => nav.push({ name: 'job', id: p.plan!.id })} /> : null}

          {p.routines.length ? (
            <>
              <Label>Routines</Label>
              <Group>
                {p.routines.map((r, index) => <Line key={r.id} title={r.title} detail={[r.when, r.bot].filter(Boolean).join(', ')} onPress={() => nav.push({ name: 'routine', id: r.id })} right={r.paused ? <Tag text="Paused" color={t.warn} /> : undefined} last={index === p.routines.length - 1} />)}
              </Group>
            </>
          ) : null}

          <Group>
            <Line title="Name, folder, archive" detail="Rename it, point it at another folder, or put it away" onPress={() => nav.push({ name: 'projectEdit', id })} last />
          </Group>

          <Label>This week</Label>
          <Txt color={t.ink2}>{p.spend.tokens || p.spend.runs ? `${tokens(p.spend.tokens)} tokens over ${plural(p.spend.runs, 'run')}${p.spend.cents ? `, $${(p.spend.cents / 100).toFixed(2)}` : ''}` : 'Nothing used this week.'}</Txt>

          {p.done.length ? (
            <>
              <Label>Done lately</Label>
              <Group>
                {p.done.map((job, index) => <JobLine key={job.id} job={job} last={index === p.done.length - 1} onOpen={() => nav.push({ name: 'job', id: job.id })} />)}
              </Group>
            </>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  rank: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 60, paddingHorizontal: 14, paddingVertical: 9 },
  number: { textAlign: 'center', width: 22 },
  open: { justifyContent: 'center', minHeight: 44 },
  move: { alignItems: 'center', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, height: 44, justifyContent: 'center', width: 44 },
  goal: { borderLeftWidth: 3, borderRadius: 14, gap: 10, marginBottom: 14, padding: 14 },
  goalHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  goalPart: { gap: 2 },
  planText: { paddingHorizontal: 4, paddingVertical: 8 },
});
