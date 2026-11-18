import AsyncStorage from '@react-native-async-storage/async-storage';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, FeedItem, Flow, FlowWindow, getFlow, getManager, getTray, JobPile, Manager, markCards, ManagerBot, ManagerProject, NeedsYou, StepState, TrayItem, WorkLine } from '../api';
import { portraitOf } from '../mascot/look';
import { readable } from '../theme/color';
import { pileName } from './Jobs';
import { Crew, isDecision, leadOf, Nav, waitingCount } from '../crew';
import { Theme, useLook } from '../theme/prefs';
import { ConnectionBadge } from '../ui/ConnectionBadge';
import { CrewTree } from '../ui/CrewTree';
import { PcLoadCard } from '../ui/PcLoad';
import { Icon } from '../ui/Icon';
import { DESCRIBE } from '../ui/describe';
import { Button, Chips, GlassButton, Group, Hinted, Label, Sign, styles as kit, Txt, Words } from '../ui/kit';
import { Tag } from '../ui/page';
import { clock } from '../ui/time';
import { NeedsYouCard } from './Studio';
import { TrayBar } from './Tray';

const REFRESH_MS = 15_000;
/** The last answer, kept on the phone so the screen is full the moment the app opens. */
const STORE_KEY = 'manager:last';
const SHOWN_FEED = 12;
const STEP_NAMES = ['Build', 'Check', 'Final check', 'Merge', 'Push'];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Everything but the time it was made, so an answer that says nothing new redraws nothing. */
const sameAs = (a: Manager | null, b: Manager) => Boolean(a) && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

function stepColor(state: StepState, t: Theme) {
  if (state === 'done') return t.good;
  if (state === 'now') return t.accent;
  if (state === 'failed') return t.bad;
  if (state === 'queued') return t.warn;
  return t.edge;
}

const Steps = memo(function Steps({ steps }: { steps: StepState[] }) {
  const { t } = useLook();
  const at = steps.findIndex((s) => s === 'now' || s === 'failed' || s === 'queued');
  const label = steps.map((s, i) => `${STEP_NAMES[i]}: ${s}`).join(', ');
  return (
    <View accessible accessibilityLabel={label} style={styles.steps}>
      {steps.map((state, index) => (
        <View key={index} style={[styles.step, { backgroundColor: stepColor(state, t), opacity: state === 'skipped' ? 0.35 : 1 }]} />
      ))}
      {at >= 0 ? <Txt size={12} color={t.ink3} style={styles.stepName}>{STEP_NAMES[at]}</Txt> : null}
    </View>
  );
});

/** A line of work wears the colour of the bot on it, as on the PC page; one nobody is on has a plain edge. */
const LineRow = memo(function LineRow({ line, colour, onOpen }: { line: WorkLine; colour: string; onOpen: (id: string) => void }) {
  const { t } = useLook();
  const tone = line.steps.includes('failed') ? t.bad : line.late ? t.warn : t.ink2;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onOpen(line.id)}
      style={({ pressed }) => [styles.card, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0, borderLeftWidth: 5, borderLeftColor: colour ? readable(colour, [t.card], 3, t.ink) : t.line, borderRadius: t.r.card, boxShadow: t.shadow }, pressed && kit.dim]}
    >
      <View style={styles.lineHead}>
        {t.plates ? <Sign size={18}>{line.ref}</Sign> : <Txt size={12} weight={700} color={t.accentText}>{line.ref}</Txt>}
        <Txt size={12} color={t.ink3} numberOfLines={1} style={styles.shrink}>{line.project}</Txt>
      </View>
      <Txt size={15} weight={600} numberOfLines={2}>{line.title}</Txt>
      <Txt size={13} color={tone} numberOfLines={2}>{line.note}{line.fixes ? `, ${plural(line.fixes, 'fix', 'fixes')} so far` : ''}</Txt>
      <Steps steps={line.steps} />
    </Pressable>
  );
});

function projectLine(project: ManagerProject) {
  const parts = [
    project.running && `${project.running} running`,
    project.queued && `${project.queued} waiting`,
    project.blocked && `${project.blocked} blocked`,
    project.doneToday && `${project.doneToday} done today`,
    project.unpushed && `${project.unpushed} not pushed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Quiet';
}

const FeedRow = memo(function FeedRow({ item, last, onOpen }: { item: FeedItem; last: boolean; onOpen: (id: string) => void }) {
  const { t } = useLook();
  const tone = item.kind === 'blocking' || item.kind === 'stopped' ? t.bad : item.kind === 'merged' || item.kind === 'check' || item.kind === 'done' ? t.good : t.ink3;
  return (
    <Pressable
      accessibilityRole={item.id ? 'button' : 'text'}
      disabled={!item.id}
      onPress={() => onOpen(item.id)}
      style={({ pressed }) => [styles.feed, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && kit.dim]}
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Txt size={12} color={t.ink3} style={styles.feedTime}>{clock(new Date(item.at).toISOString())}</Txt>
      <Txt size={13} color={t.ink2} style={kit.flex}>{item.text}</Txt>
    </Pressable>
  );
});

/** The manager's home: what is going on in the studio right now, on one screen. */
export function HomeScreen({ connection, crew, nav }: { connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<Manager | null>(null);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [traySaid, setTraySaid] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [allFeed, setAllFeed] = useState(false);
  const shown = useRef<Manager | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [flowWindow, setFlowWindow] = useState<FlowWindow>('now');
  const windowRef = useRef<FlowWindow>('now');
  const scroller = useRef<ScrollView>(null);
  const needsAt = useRef(0);

  const show = useCallback((next: Manager) => {
    if (sameAs(shown.current, next)) return;
    shown.current = next;
    setView(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await getManager(connection);
      show(next);
      // The door keeps the last answer it had when the engine is down, and says so.
      setError(next.error || '');
      // The crew map rides on the same poll; a studio without one answers null and the plain crew shows.
      getFlow(connection, windowRef.current).then(setFlow);
      // The answers held in the tray, the same ones the PC map holds.
      getTray(connection).then((tray) => setTray(tray.items)).catch(() => undefined);
      AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection, show]);

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY).then((saved) => {
      if (saved && !shown.current) show(JSON.parse(saved));
    }).catch(() => undefined);
    load();
    // Nothing is asked while the app is in the background; it asks again the moment it is back.
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, REFRESH_MS);
    const front = AppState.addEventListener('change', (state) => {
      if (timer) clearInterval(timer);
      timer = null;
      if (state !== 'active') return;
      load();
      timer = setInterval(load, REFRESH_MS);
    });
    return () => {
      if (timer) clearInterval(timer);
      front.remove();
    };
  }, [load, show]);

  const chooseWindow = useCallback((next: FlowWindow) => {
    windowRef.current = next;
    setFlowWindow(next);
    getFlow(connection, next).then(setFlow);
  }, [connection]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };
  const openJob = useCallback((id: string) => nav.push({ name: 'job', id }), [nav]);
  const openBot = useCallback((botId: string) => nav.push({ name: 'bot', botId }), [nav]);
  // A question the lead asked in its chat opens there. Any other bot's opens on its job page, where the
  // card is answered and a reply goes to that bot: the phone chats with the lead alone.
  const leadId = leadOf(crew.bots)?.id;
  // The owner's read and archive marks, shown at once and kept on the PC, where the map shows them too.
  const [marks, setMarks] = useState<Record<string, { read?: boolean; archived?: boolean }>>({});
  const [showArchived, setShowArchived] = useState(false);
  const mark = useCallback((items: NeedsYou[], change: { read?: boolean; archived?: boolean }) => {
    const keys = items.map((i) => i.key).filter((k): k is string => Boolean(k));
    if (!keys.length) return;
    const after = { ...change, ...(change.archived ? { read: true } : {}) };
    setMarks((m) => ({ ...m, ...Object.fromEntries(keys.map((k) => [k, { ...m[k], ...after }])) }));
    markCards(connection, keys, change).catch(() => {
      setMarks((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !keys.includes(k))));
    });
  }, [connection]);

  const openNeed = useCallback((item: NeedsYou) => {
    if (!item.read) mark([item], { read: true });
    if (item.botId && item.botId === leadId) nav.push({ name: 'chat', botId: item.botId });
    else if (item.id) nav.push({ name: 'job', id: item.id });
  }, [nav, leadId]);

  if (!view) {
    return (
      <View style={[styles.waiting, { paddingTop: insets.top }]}>
        {error ? <Txt color={t.bad} style={styles.centerText} accessibilityLiveRegion="polite">{error}</Txt> : <ActivityIndicator color={t.accent} accessibilityLabel="Loading" />}
        {error ? <Button label="Try again" onPress={load} /> : null}
      </View>
    );
  }

  const open = view.lines.filter((line) => line.open);
  // Each bot's colour by its name, the one its robot wears: a line is coloured by the bot on it.
  const colours = new Map(view.bots.map((b) => [b.name, portraitOf(b, p.bots[b.id]).colour]));
  const feed = allFeed ? view.feed : view.feed.slice(0, SHOWN_FEED);
  const cards = view.needsYou.map((item) => ({ ...item, ...(item.key ? marks[item.key] : undefined) }));
  // New first, then read; archived ones fold away at the bottom.
  const shownCards = cards.filter((c) => !c.archived).sort((a, b) => Number(Boolean(a.read)) - Number(Boolean(b.read)));
  const archivedCards = cards.filter((c) => c.archived);
  const unread = shownCards.filter((c) => !c.read);
  // Needs you holds the decisions only; the rest is informational and sits under "Also going on".
  const decisions = shownCards.filter(isDecision);
  const others = shownCards.filter((c) => !isDecision(c));
  const waiting = waitingCount(cards);
  const calm = !decisions.length;

  return (
    <ScrollView
      ref={scroller}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 120, paddingHorizontal: 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <View style={styles.head}>
        <View style={kit.flex}>
          {t.plates ? <Sign size={30} accessibilityRole="header">{view.state}</Sign> : <Txt size={22} weight={700} accessibilityRole="header" style={styles.state}>{view.state}</Txt>}
          <Txt size={12} color={t.ink3}>As of {clock(new Date(view.at).toISOString())}</Txt>
          <ConnectionBadge connection={connection} />
        </View>
        <View style={styles.headButtons}>
          <GlassButton icon="plus" label="New job" hint={DESCRIBE.icon.newJob} onPress={() => nav.push({ name: 'new' })} />
        </View>
      </View>
      {error ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">Showing the last update. {error}</Txt> : null}

      <View onLayout={(e) => { needsAt.current = e.nativeEvent.layout.y; }}>
        <Label style={styles.firstLabel}>{`Needs you (${waiting})`}</Label>
      </View>
      {calm ? <Txt color={t.ink2} style={styles.indent}>Nothing right now.</Txt> : null}
      {traySaid ? <Txt size={14} weight={600} color={t.good} accessibilityLiveRegion="polite">{traySaid}</Txt> : null}
      <TrayBar connection={connection} items={tray} onChange={(next, words) => { setTray(next); if (words) { setTraySaid(words); load(); } }} />
      {decisions.some((d) => d.kind === 'question') ? <Button label="Answer several, send once" kind="quiet" icon="check" hint={DESCRIBE.home.several} onPress={() => nav.push({ name: 'tray' })} /> : null}
      <View style={styles.stack}>
        {unread.filter(isDecision).length > 1 ? (
          <Hinted hint={DESCRIBE.home.markAllRead}>
            <Pressable accessibilityRole="button" accessibilityHint={DESCRIBE.home.markAllRead} onPress={() => mark(unread.filter(isDecision), { read: true })} style={({ pressed }) => [styles.allRead, pressed && kit.dim]}>
              <Txt size={13} weight={600} color={t.accentText}>Mark all {unread.filter(isDecision).length} read</Txt>
            </Pressable>
          </Hinted>
        ) : null}
        {decisions.map((item) => <NeedsYouCard key={item.key || `${item.kind}-${item.id}`} item={item} connection={connection} onDone={load} onOpen={openNeed} onMark={(i, change) => mark([i], change)} />)}
      </View>

      {others.length || view.trouble.length ? <Label>Also going on</Label> : null}
      <View style={styles.stack}>
        {others.map((item) => <NeedsYouCard key={item.key || `${item.kind}-${item.id}`} item={item} connection={connection} onDone={load} onOpen={openNeed} onMark={(i, change) => mark([i], change)} />)}
        {view.trouble.map((item) => (
          <View key={item.text} style={[styles.trouble, { backgroundColor: t.card, borderLeftColor: item.level === 'bad' ? t.bad : t.warn }, t.plates && { borderRadius: t.r.card }]}>
            <Txt size={14}>{item.text}</Txt>
          </View>
        ))}
      </View>

      {archivedCards.length ? (
        <Hinted hint={DESCRIBE.home.archived}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showArchived }} onPress={() => setShowArchived((v) => !v)} style={({ pressed }) => [styles.allRead, pressed && kit.dim]}>
            <Txt size={13} weight={600} color={t.ink2}>{showArchived ? 'Hide archived' : `Archived (${archivedCards.length})`}</Txt>
          </Pressable>
        </Hinted>
      ) : null}
      {showArchived ? (
        <View style={styles.stack}>
          {archivedCards.map((item) => <NeedsYouCard key={item.key || `${item.kind}-${item.id}`} item={item} connection={connection} onDone={load} onOpen={openNeed} onMark={(i, change) => mark([i], change)} />)}
        </View>
      ) : null}

      <PcLoadCard connection={connection} />

      {/* The home views: the crew map here, Engram (the owner's notes) on its own screen. The phone has no yard. */}
      <Chips value={'crew' as string} options={[{ id: 'crew', name: 'Crew map' }, { id: 'engram', name: 'Engram' }]} onChange={(v) => { if (v === 'engram') nav.push({ name: 'engram' }); }} hints={{ crew: DESCRIBE.home.crew, engram: DESCRIBE.home.engram }} />
      <CrewTree flow={flow} fallback={view} waiting={waiting} window={flowWindow} onWindow={chooseWindow} onOpenBot={openBot} onOwner={() => scroller.current?.scrollTo({ y: Math.max(0, needsAt.current - 8), animated: true })} />

      <Label>Work in hand</Label>
      {view.piles?.length ? <Chips value={'' as string} options={view.piles.map((pile) => ({ id: pile.id as string, name: pileName(pile) }))} onChange={(pile) => nav.push({ name: 'jobs', pile: pile as JobPile })} hints={Object.fromEntries(view.piles.map((pile) => [pile.id as string, (DESCRIBE.pile as Record<string, string>)[pile.name]]).filter(([, text]) => text))} /> : null}
      {view.piles?.length ? <Words title="What the piles and dots mean" from={{ ...DESCRIBE.pile, Dots: DESCRIBE.home.dots }} words={[...view.piles.map((pile) => pile.name), ...(open.length ? ['Dots'] : [])]} /> : null}
      {open.length === 0 ? <Txt color={t.ink2} style={styles.indent}>No open work.</Txt> : null}
      <View style={styles.stack}>
        {open.map((line) => <LineRow key={line.id} line={line} colour={colours.get(line.bot) ?? ''} onOpen={openJob} />)}
      </View>

      <Label>Projects</Label>
      <Group>
        {view.projects.map((project, index) => (
          <Pressable key={project.id} accessibilityRole="button" onPress={() => nav.push({ name: 'project', id: project.id })}
            style={({ pressed }) => [styles.project, index < view.projects.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && kit.dim]}>
            <View style={kit.flex}>
              {t.plates ? <Sign size={20}>{project.name}</Sign> : <Txt size={15} weight={600}>{project.name}</Txt>}
              <Txt size={13} color={project.blocked ? t.bad : t.ink2}>{projectLine(project)}</Txt>
            </View>
            <Icon name="chevron" size={16} color={t.ink3} />
          </Pressable>
        ))}
      </Group>

      <Label>Lately</Label>
      {feed.length === 0 ? <Txt color={t.ink2} style={styles.indent}>Nothing has happened today yet.</Txt> : null}
      {feed.length ? (
        <Group>
          {feed.map((item, index) => <FeedRow key={`${item.at}-${index}`} item={item} last={index === feed.length - 1} onOpen={openJob} />)}
        </Group>
      ) : null}
      {view.feed.length > SHOWN_FEED && !allFeed ? (
        <Pressable accessibilityRole="button" onPress={() => setAllFeed(true)} style={styles.more}>
          <Txt size={14} weight={600} color={t.accentText}>Show all {view.feed.length}</Txt>
          <Icon name="chevron" size={16} color={t.accentText} />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headButtons: { alignItems: 'flex-end', gap: 8 },
  allRead: { alignSelf: 'flex-end', justifyContent: 'center', minHeight: 44, paddingHorizontal: 4 },
  waiting: { alignItems: 'center', flex: 1, gap: 14, justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  head: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  state: { letterSpacing: -0.3, lineHeight: 28 },
  firstLabel: { marginTop: 18 },
  indent: { marginLeft: 4 },
  stack: { gap: 8 },
  shrink: { flexShrink: 1 },
  trouble: { borderLeftWidth: 4, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11 },
  bot: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 64, paddingHorizontal: 12, paddingVertical: 9 },
  botHead: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  card: { borderRadius: 18, gap: 3, padding: 14 },
  lineHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  steps: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 7 },
  step: { borderRadius: 3, height: 6, width: 28 },
  stepName: { marginLeft: 6 },
  project: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 11 },
  feed: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 14, paddingVertical: 11 },
  dot: { borderRadius: 4, height: 8, marginTop: 6, width: 8 },
  feedTime: { marginTop: 1, width: 38 },
  more: { alignItems: 'center', flexDirection: 'row', gap: 4, justifyContent: 'center', minHeight: 48 },
});
