/**
 * The first run of an empty studio, as a punched job card of steps: name it, sign in an AI, pick a
 * crew, say hello to a bot, add a project, give a first job, pair a phone. Each step can be skipped
 * and is found again in Setup. Says the same as the PC's first run.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  addJob, addStarterCrew, checkSetup, Connection, FIRST_STEP_NAMES, FirstRun, FirstStep, getFirstRun, getNewBot, getSetup, markFirstRun, nameStudio,
} from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Icon } from '../ui/Icon';
import { Note, Small, useAct } from '../ui/form';
import { Button, Chips, Field, Group, Sign, styles as kit, Txt, useTap } from '../ui/kit';
import { Line, Page, useLoad } from '../ui/page';
import { ProjectAddForm } from './ProjectEdit';
import { SetupRows } from './Setup';

const REFRESH_MS = 10_000;
const YELLOW = '#ffc61a';
const INK = '#15181d';
const NONE = '';

/** The steps as a job card: a punched hole for each one done, the open one painted yellow. */
function StepCard({ first, at, onOpen }: { first: FirstRun; at: string; onOpen: (step: FirstStep) => void }) {
  const { t } = useLook();
  const tap = useTap();
  const edge = t.plates && t.dark ? '#05070a' : t.ink;
  return (
    <View accessibilityRole="list" accessibilityLabel="Steps" style={[styles.card, { backgroundColor: t.card, borderColor: t.outline ? edge : t.line, borderRadius: t.r.card, boxShadow: t.shadow }]}>
      <View style={[styles.cardHead, { borderBottomColor: edge }]}>
        <Sign size={15} color={t.ink2}>JOB CARD</Sign>
        <Sign size={15} color={t.ink2} numberOfLines={1} style={styles.cardName}>{first.studio.name}</Sign>
      </View>
      {first.steps.map((step, n) => {
        const now = step.id === at;
        const done = step.state === 'done';
        const ink = now ? INK : t.ink;
        const word = done ? 'Done' : step.state === 'skipped' ? 'Skipped' : now ? 'Now' : '';
        return (
          <Pressable key={step.id} accessibilityRole="button" accessibilityState={{ selected: now }} accessibilityLabel={`Step ${n + 1}, ${FIRST_STEP_NAMES[step.id]}${word ? `, ${word.toLowerCase()}` : ''}`}
            onPress={() => { tap(); onOpen(step.id); }}
            style={({ pressed }) => [styles.step, now && { backgroundColor: YELLOW }, n < first.steps.length - 1 && { borderBottomColor: now ? edge : t.line, borderBottomWidth: now ? 2 : StyleSheet.hairlineWidth }, now && n > 0 && { borderTopColor: edge, borderTopWidth: 2, marginTop: -1 }, pressed && kit.dim]}>
            {/* A done step is punched through: the hole shows the page behind the card. */}
            <View style={[styles.hole, { borderColor: now ? INK : done ? edge : t.ink3 }, done ? { backgroundColor: t.app } : { borderStyle: step.state === 'skipped' ? 'dashed' : 'solid' }]}>
              {done ? <Icon name="check" size={14} color={t.good} weight={3} /> : <Txt size={13} weight={700} color={now ? INK : t.ink2}>{n + 1}</Txt>}
            </View>
            <Sign size={21} color={done && !now ? t.ink2 : ink} style={kit.flex}>{FIRST_STEP_NAMES[step.id]}</Sign>
            {word ? <Txt size={12} weight={700} color={now ? INK : done ? t.good : t.ink3}>{word}</Txt> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function FirstRunScreen({ step, connection, nav }: { step?: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data: first, error, load, setData } = useLoad(() => getFirstRun(connection), [connection], REFRESH_MS);
  const [at, setAt] = useState<string | null>(step ?? null);
  const setup = useLoad(() => getSetup(connection).catch(() => null), [connection]);
  const fresh = useLoad(() => getNewBot(connection).catch(() => null), [connection]);
  const { busy, run } = useAct();
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [who, setWho] = useState(NONE);

  // The step to show is the door's until the owner picks one or finishes one.
  useEffect(() => {
    if (at === null && first) setAt(first.step);
  }, [at, first]);
  const shown = at ?? first?.step ?? '';
  const stateOf = (id: string) => first?.steps.find((s) => s.id === id)?.state;
  const done = stateOf(shown) === 'done';

  const took = (next: FirstRun) => {
    setData(next);
    setAt(next.step);
  };
  const mark = (id: FirstStep, what: 'skip' | 'seen') => run(`${what}:${id}`, async () => took(await markFirstRun(connection, { step: id, mark: what })));
  const next = () => {
    if (!first) return;
    const ids = first.steps.map((s) => s.id);
    setAt(first.step && first.step !== shown ? first.step : ids[ids.indexOf(shown as FirstStep) + 1] ?? '');
  };
  const close = () => run('close', async () => {
    await markFirstRun(connection, { mark: 'close' });
    nav.back();
  });
  const skip = (id: FirstStep, words = 'Skip this step') => <Button label={words} kind="quiet" busy={busy === `skip:${id}`} disabled={Boolean(busy)} onPress={() => mark(id, 'skip')} />;
  const nextButton = <Button label="Next step" disabled={Boolean(busy)} onPress={next} />;

  const starter = (fresh.data?.templates ?? []).filter((x) => x.default ?? x.set === 'starter');
  const studioName = name ?? (first && first.studio.name !== 'My studio' ? first.studio.name : '');
  const crew = first?.crew ?? [];
  const projectId = project ?? first?.projects[0]?.id ?? NONE;

  let body = null;
  if (first && shown === '') {
    body = (
      <>
        <Sign size={26}>The studio is set up</Sign>
        <Txt color={t.ink2}>Everything here stays in Setup. From now on the Now tab shows the crew at work, and the Studio tab holds every section.</Txt>
        <Button label="Go to the studio" busy={busy === 'close'} disabled={Boolean(busy)} onPress={close} />
        <Button label="Open Setup" kind="quiet" disabled={Boolean(busy)} onPress={() => nav.replace({ name: 'setup' })} />
      </>
    );
  } else if (first && shown === 'name') {
    body = (
      <>
        <Sign size={26}>What is this studio called?</Sign>
        <Txt color={t.ink2}>A studio is your crew of AI bots and the projects they work on. Its name is on every page and in what the bots are told.</Txt>
        <Field label="Studio name" value={studioName} onChangeText={setName} maxLength={80} placeholder="Like “Tea Shop Studio”" />
        <Button label={done ? 'Change the name' : 'Name the studio'} busy={busy === 'name'} disabled={!studioName.trim() || (done && studioName.trim() === first.studio.name) || Boolean(busy)}
          onPress={() => run('name', async () => { took(await nameStudio(connection, studioName.trim())); setName(null); }, 'The studio was not named')} />
        {done ? nextButton : skip('name', 'Keep “My studio” for now')}
      </>
    );
  } else if (first && shown === 'setup') {
    const s = setup.data;
    body = (
      <>
        <Sign size={26}>Sign in an AI, or start on free models</Sign>
        <Txt color={t.ink2}>Bots need an AI to run on. Free models need no account, so a crew can start today; sign in your own subscriptions when you want stronger ones.</Txt>
        {s?.available ? <Note tone={s.ready ? 'good' : 'warn'}>{s.summary}</Note> : null}
        {s ? <SetupRows data={s} connection={connection} onData={setup.setData} /> : <Txt color={t.ink2}>{setup.error || 'Reading what is installed and signed in.'}</Txt>}
        <View style={styles.acts}>
          <Button label={s?.ready ? 'Next step' : 'Carry on anyway'} busy={busy === 'seen:setup'} disabled={Boolean(busy)} onPress={() => mark('setup', 'seen')} />
          {s?.available ? <Button label="Check again" kind="quiet" busy={busy === 'check'} disabled={Boolean(busy)} onPress={() => run('check', async () => setup.setData(await checkSetup(connection)), 'It could not be checked')} /> : null}
          {done ? null : skip('setup')}
        </View>
      </>
    );
  } else if (first && shown === 'crew') {
    body = (
      <>
        <Sign size={26}>Pick a crew</Sign>
        <Txt color={t.ink2}>A crew is a few bots with different jobs: one hands out the work, one builds, one checks. Start with ours or with nothing; every bot can be changed later.</Txt>
        {crew.length ? <Note tone="good">{`The crew so far: ${crew.map((b) => `${b.name}${b.paused ? ' (off)' : ''}`).join(', ')}.`}</Note> : null}
        <Sign size={19} style={styles.part}>The default crew</Sign>
        {starter.length ? (
          <>
            <Group>
              {starter.map((x, index) => <Line key={x.id} title={x.name} detail={x.does || x.title} note={`${x.aiName}${x.needs ? ', off until signed in' : ''}`} noteLines={1} last={index === starter.length - 1} />)}
            </Group>
            <Button label="Add the default crew" busy={busy === 'starter'} disabled={Boolean(busy)}
              onPress={() => run('starter', async () => { await addStarterCrew(connection); took(await getFirstRun(connection)); }, 'The crew was not added')} />
          </>
        ) : <Txt color={t.ink2}>{fresh.data ? 'This copy of Botyard has no default crew. Start blank instead.' : 'Reading the default crew.'}</Txt>}
        <Sign size={19} style={styles.part}>Start blank</Sign>
        <Txt size={13} color={t.ink2}>Make your own bots one at a time: you name each, pick its AI and write what it does.</Txt>
        <Button label="Add a bot" kind="quiet" disabled={Boolean(busy)} onPress={() => nav.push({ name: 'botNew', from: '' })} />
        {done ? nextButton : skip('crew')}
      </>
    );
  } else if (first && shown === 'chat') {
    const chat = first.chat;
    const greet = first.greet;
    const talkTo = chat?.botId || greet?.id || '';
    body = (
      <>
        <Sign size={26}>{chat?.answered ? 'A bot answered you' : 'Say hello to a bot'}</Sign>
        <Txt color={t.ink2}>The quickest proof that everything works: the bot's AI starts on the PC, reads what you wrote and answers in the chat. Ask it what it can do.</Txt>
        {chat?.answered ? <Note tone="good">{`${chat.bot} answered: “${chat.text.length > 200 ? `${chat.text.slice(0, 200)}…` : chat.text}”`}</Note>
          : chat ? <Note tone="warn">{`${chat.bot} has your message. A first answer can take a minute or two while its AI starts.`}</Note> : null}
        {talkTo ? <Button label={chat ? `Open the chat with ${chat.bot}` : `Say hello to ${greet?.name ?? 'the lead'}`} kind={chat?.answered ? 'quiet' : undefined} disabled={Boolean(busy)} onPress={() => nav.push({ name: 'chat', botId: talkTo })} />
          : <Note tone="warn">There is no bot switched on to talk to yet. Go back a step and pick a crew first.</Note>}
        <Txt size={13} color={t.ink2}>No answer after five minutes? Check in Setup that the bot's AI is ready, and in Bots that the bot is switched on; its last run says what went wrong.</Txt>
        {done ? nextButton : skip('chat')}
      </>
    );
  } else if (first && shown === 'phone') {
    body = (
      <>
        <Sign size={26}>This phone is paired</Sign>
        <Txt color={t.ink2}>{`You are reading this on a phone with its own key${first.phones && first.phones > 1 ? `, one of ${first.phones}` : ''}. To pair another, use Pair a phone on the PC's map. Keys can be taken back on the map, under Phones.`}</Txt>
        {nextButton}
      </>
    );
  } else if (first && shown === 'project') {
    body = (
      <>
        <Sign size={26}>Add a project</Sign>
        <Txt color={t.ink2}>A project is a folder of code the crew works in. Each job gets its own branch there, so nothing touches your work until you take it.</Txt>
        {first.projects.length ? <Note tone="good">{`Projects so far: ${first.projects.map((p) => p.name).join(', ')}.`}</Note> : null}
        <ProjectAddForm connection={connection} onAdded={() => { getFirstRun(connection).then(took).catch(() => load()); }} />
        {done ? nextButton : skip('project')}
      </>
    );
  } else if (first && shown === 'job') {
    const job = first.firstJob;
    body = job ? (
      <>
        <Sign size={26}>Your first job</Sign>
        <Group>
          <Line title={job.title} note={job.ref || undefined} onPress={() => nav.push({ name: 'job', id: job.id })} last />
        </Group>
        <Txt size={13} color={t.ink2}>{crew.some((b) => !b.paused) ? 'A bot takes it within a minute. Open it to read what the bot says and see its changes.' : 'No bot is switched on to take it. Add one, or switch one on, from Bots.'}</Txt>
        <Button label="Open the job" disabled={Boolean(busy)} onPress={() => nav.push({ name: 'job', id: job.id })} />
        <Button label="Go to the studio" kind="quiet" busy={busy === 'close'} disabled={Boolean(busy)} onPress={close} />
      </>
    ) : (
      <>
        <Sign size={26}>Give a first job</Sign>
        <Txt color={t.ink2}>Say what you want done, as you would to a person. The bot that leads the crew takes it and hands it on, unless you pick who does it.</Txt>
        <Field label="What should be done" value={title} onChangeText={setTitle} maxLength={180} placeholder="Like “Add a README that says what this project is”" />
        <Field label="Details" value={details} onChangeText={setDetails} multiline tall maxLength={8000} placeholder="What done looks like, where to look, what not to touch" />
        <View style={styles.pick}>
          <Txt size={14} weight={600} color={t.ink2}>Project</Txt>
          <Chips value={projectId} options={[{ id: NONE, name: 'None' }, ...first.projects]} onChange={setProject} />
        </View>
        <View style={styles.pick}>
          <Txt size={14} weight={600} color={t.ink2}>Who</Txt>
          <Chips value={who} options={[{ id: NONE, name: crew.length ? 'The lead decides' : 'Nobody yet' }, ...crew.map((b) => ({ id: b.id, name: `${b.name}${b.paused ? ' (off)' : ''}` }))]} onChange={setWho} />
        </View>
        {crew.length ? null : <Note tone="warn">There is no bot to take a job yet. Go back a step and pick a crew first.</Note>}
        <Button label="Give the job" busy={busy === 'job'} disabled={!title.trim() || !crew.length || Boolean(busy)}
          onPress={() => run('job', async () => {
            await addJob(connection, { title: title.trim(), description: details.trim(), priority: 'medium', ...(projectId ? { projectId } : {}), ...(who ? { botId: who } : {}) });
            setTitle('');
            setDetails('');
            const now = await getFirstRun(connection);
            setData(now);
            setAt('job');
          }, 'The job was not given')} />
        {skip('job')}
      </>
    );
  }

  return (
    <Page title="First run" note="A few steps to a studio that works. Skip any of them; each is found again in Setup." onBack={nav.back} onRefresh={load} error={error} loading={!first}
      right={first ? <Small label="Close the first run" disabled={Boolean(busy)} onPress={close} /> : undefined}>
      {first ? (
        <>
          <StepCard first={first} at={shown} onOpen={setAt} />
          <View style={styles.body}>{body}</View>
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 2, marginTop: 6, overflow: 'hidden' },
  cardHead: { alignItems: 'center', borderBottomWidth: 2, flexDirection: 'row', gap: 10, justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 7 },
  cardName: { flexShrink: 1 },
  step: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 9 },
  hole: { alignItems: 'center', borderRadius: 14, borderWidth: 2, height: 28, justifyContent: 'center', width: 28 },
  body: { gap: 12, marginTop: 14 },
  acts: { gap: 10 },
  part: { marginTop: 10 },
  pick: { gap: 8 },
});
