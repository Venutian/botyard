import AsyncStorage from '@react-native-async-storage/async-storage';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, Digest, DigestCard, FeedItem, Flow, FlowWindow, getDigest, getFlow, getManager, getOwnPages, OwnPage, getTray, JobPile, Manager, markCards, ManagerBot, ManagerProject, NeedsYou, StepState, TrayItem, WorkLine } from '../api';
import { BotBadge } from '../mascot/BotBadge';
import { Portrait, portraitOf } from '../mascot/look';
import { readable } from '../theme/color';
import { Crew, isDecision, leadOf, Nav, waitingCount } from '../crew';
import { Theme, useLook } from '../theme/prefs';
import { ConnectionBadge } from '../ui/ConnectionBadge';
import { CrewTree } from '../ui/CrewTree';
import { DigestCards } from '../ui/Digest';
import { PcLoadCard } from '../ui/PcLoad';
import { Icon, IconName, isIcon } from '../ui/Icon';
import { DESCRIBE } from '../ui/describe';
import { Button, Chips, GlassButton, Group, Hinted, Label, Sign, styles as kit, Txt, Words } from '../ui/kit';
import { Tag } from '../ui/page';
import { clock } from '../ui/time';
import { NeedsYouCard } from './Studio';
import { TrayBar } from './Tray';

const REFRESH_MS = 15_000;
/** The last answer, kept on the phone so the screen is full the moment the app opens. */
const STORE_KEY = 'manager:last';
const SHOWN_FEED = 8;
/** Waiting work shown before "Show all": what is being worked on is never cut. */
const SHOWN_WAITING = 3;
const SHOWN_PROJECTS = 6;
/** Open work with nothing done for this many hours is folded away as not moving. */
const STALL_HOURS = 3;

/** The top line, short: who is working and what needs a look, without the list of jobs ("7 bots are working: Fred on ...  and more."). */
export const headline = (state: string) => state.replace(/:[^.]*(?:\.\.\.|…)?[^.]*\./, '.').replace(/\s+/g, ' ').trim();

/** The jobs pile a problem line opens, when it names one. */
const troublePile = (text: string): JobPile | undefined => (/blocked/i.test(text) ? 'blocked' : /in progress/i.test(text) ? 'inhand' : undefined);

/** A view of the owner's own (Engram, a page), as a small button with its icon. */
function ViewButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { t } = useLook();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.viewButton, { backgroundColor: t.card, borderColor: t.line, borderRadius: t.r.button }, pressed && kit.dim]}>
      <Icon name={icon} size={18} color={t.accentText} />
      <Txt size={14} weight={600}>{label}</Txt>
    </Pressable>
  );
}
const STEP_NAMES = ['Build', 'Check', 'Final check', 'Merge', 'Push'];
const STEP_SHORT = ['Build', 'Check', 'Final', 'Merge', 'Push'];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Everything but the time it was made, so an answer that says nothing new redraws nothing. */
const sameAs = (a: Manager | null, b: Manager) => Boolean(a) && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

function stepColor(state: StepState, t: Theme) {
  if (state === 'done') return t.good;
  if (state === 'now') return t.accent;
  if (state === 'failed') return t.bad;
  // Waiting is grey, a shade above not started: orange is kept for the step a run is on.
  if (state === 'queued') return t.ink3;
  return t.edge;
}

/** The five steps a piece of work goes through, each a short bar with its name under it: done, now, waiting or failed. */
const Steps = memo(function Steps({ steps }: { steps: StepState[] }) {
  const { t } = useLook();
  const label = steps.map((s, i) => `${STEP_NAMES[i]}: ${s}`).join(', ');
  return (
    <View accessible accessibilityLabel={label} style={styles.steps}>
      {steps.map((state, index) => {
        const active = state === 'now' || state === 'failed' || state === 'queued';
        return (
          <View key={index} style={styles.stepBox}>
            <View style={[styles.step, { backgroundColor: stepColor(state, t), opacity: state === 'skipped' ? 0.35 : 1 }]} />
            <Txt size={10} weight={active ? 700 : 400} color={active ? t.ink : t.ink3} numberOfLines={1}>{STEP_SHORT[index]}</Txt>
          </View>
        );
      })}
    </View>
  );
});

/** What is happening on a line of work, in one word: a run is going, it waits for a bot, it failed, or nobody has touched it. */
function lineState(line: WorkLine, stalled: boolean, t: Theme): { word: string; color: string; fill: boolean } {
  if (line.steps.includes('failed')) return { word: 'Stopped', color: t.bad, fill: true };
  if (stalled) return { word: 'Not moving', color: t.warn, fill: false };
  if (line.steps.includes('now')) return { word: 'Working', color: t.good, fill: true };
  if (line.steps.includes('queued')) return { word: line.late ? 'Waiting long' : 'Waiting', color: line.late ? t.warn : t.ink3, fill: false };
  return { word: 'Open', color: t.ink3, fill: false };
}

/**
 * A line of work: the bot on it with its face, name and colour, what is happening in a word, the job, and the five
 * steps by name. One nobody is on says so.
 */
const LineRow = memo(function LineRow({ line, who, stalled, onOpen }: { line: WorkLine; who: Portrait | null; stalled?: boolean; onOpen: (id: string) => void }) {
  const { t } = useLook();
  const state = lineState(line, Boolean(stalled), t);
  const colour = who?.colour ? readable(who.colour, [t.card], 3, t.ink) : t.line;
  const tone = state.word === 'Stopped' ? t.bad : line.late || stalled ? t.warn : t.ink2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${line.bot || 'No bot'}, ${state.word}. ${line.ref} ${line.title}. ${line.note}`}
      onPress={() => onOpen(line.id)}
      style={({ pressed }) => [styles.card, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0, borderLeftWidth: 5, borderLeftColor: colour, borderRadius: t.r.card }, pressed && kit.dim]}
    >
      <View style={styles.lineHead}>
        {who ? <BotBadge who={who} size={26} tag={false} state={state.word === 'Working' ? 'working' : undefined} /> : <View style={[styles.noBot, { borderColor: t.line }]} />}
        <Txt size={13} weight={700} color={who ? colour : t.ink3} numberOfLines={1} style={styles.shrink}>{line.bot || 'No bot on it'}</Txt>
        <View style={kit.flex} />
        <View style={[styles.stateChip, state.fill ? { backgroundColor: state.color } : { borderColor: state.color, borderWidth: 1 }]}>
          <Txt size={11} weight={700} color={state.fill ? t.app : state.color}>{state.word}</Txt>
        </View>
      </View>
      <Txt size={15} weight={600} numberOfLines={2}>{line.title}</Txt>
      <Txt size={12} color={t.ink3} numberOfLines={1}>{line.ref} · {line.project}</Txt>
      {line.note ? <Txt size={13} color={tone} numberOfLines={2}>{line.note}{line.fixes ? `, ${plural(line.fixes, 'fix', 'fixes')} so far` : ''}</Txt> : null}
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
export function HomeScreen({ connection, crew, nav, onTalk, leadName, leadUnread }: { connection: Connection; crew: Crew; nav: Nav; /** Opens the lead's chat. */ onTalk: () => void; leadName?: string; /** The lead said something not yet read. */ leadUnread?: boolean }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<Manager | null>(null);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [traySaid, setTraySaid] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [allFeed, setAllFeed] = useState(false);
  const [allWork, setAllWork] = useState(false);
  const [showStalled, setShowStalled] = useState(false);
  const [showCrew, setShowCrew] = useState(false);
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
      // The decision digest; an older door has none and nothing is shown.
      getDigest(connection).then(setDigest).catch(() => undefined);
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

  // The owner's own pages that have a phone view, beside Engram. An older door, or none, is simply none.
  const [ownPages, setOwnPages] = useState<OwnPage[]>([]);
  useEffect(() => {
    let live = true;
    getOwnPages(connection).then((r) => { if (live) setOwnPages((r?.pages ?? []).filter((p) => p.phone)); }).catch(() => { if (live) setOwnPages([]); });
    return () => { live = false; };
  }, [connection]);

  // A digest card opens where it is answered: the lead's chat, or the job it was asked on.
  const openDigest = useCallback((card: DigestCard) => {
    if (card.chat && card.botId === leadId) nav.push({ name: 'chat', botId: card.botId });
    else nav.push({ name: 'job', id: card.jobId });
  }, [nav, leadId]);

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
  // Work nobody has touched for hours is not work going on: it is shown apart, folded, so what moves is on top.
  const isStalled = (line: WorkLine) => ['build', 'check', 'fix', 'ruling'].includes(line.stage) && view.at - line.at >= STALL_HOURS * 3_600_000;
  const moving = open.filter((line) => !isStalled(line));
  const stalled = open.filter(isStalled);
  // Each bot's colour by its name, the one its robot wears: a line is coloured by the bot on it.
  const faces = new Map(view.bots.map((b) => [b.name, portraitOf(b, p.bots[b.id])]));
  // A run is going on these; the rest of what moves waits for a bot. Working first, so the top of the list is what is happening.
  const isWorking = (line: WorkLine) => line.steps.includes('now') && !line.steps.includes('failed');
  const working = moving.filter(isWorking);
  const stoppedLines = moving.filter((line) => line.steps.includes('failed'));
  const waitingLines = moving.filter((line) => !isWorking(line) && !line.steps.includes('failed'));
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
          {t.plates ? <Sign size={28} accessibilityRole="header">{headline(view.state)}</Sign> : <Txt size={22} weight={700} accessibilityRole="header" style={styles.state}>{headline(view.state)}</Txt>}
          <Txt size={12} color={t.ink3}>As of {clock(new Date(view.at).toISOString())}</Txt>
          <ConnectionBadge connection={connection} />
        </View>
        <View style={styles.headButtons}>
          <GlassButton icon="chat" label={leadName ? `Talk to ${leadName}` : 'Talk to the crew'} dot={leadUnread} onPress={onTalk} />
          <GlassButton icon="plus" label="New job" hint={DESCRIBE.icon.newJob} onPress={() => nav.push({ name: 'new' })} />
        </View>
      </View>
      {error ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">Showing the last update. {error}</Txt> : null}

      {/* The owner's other views, one tap from the top: Engram (the notes) and the owner's own pages on screens of their own. */}
      <View style={styles.views}>
        <ViewButton icon="sparkle" label="Engram" onPress={() => nav.push({ name: 'engram' })} />
        {ownPages.map((page) => <ViewButton key={page.name} icon={isIcon(page.icon) ? page.icon : 'book'} label={page.title} onPress={() => nav.push({ name: 'own', page: page.name, title: page.title })} />)}
      </View>

      {/* The decisions first: five at most, the ones only the owner may answer on top (ui/Digest.tsx). */}
      <DigestCards digest={digest} connection={connection} onOpen={openDigest} onChange={(next) => { setDigest(next); load(); }} />

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

      {view.trouble.length ? <Label>{`Problems (${view.trouble.length})`}</Label> : null}
      {view.trouble.length ? (
        <Group>
          {view.trouble.map((item, index) => {
            const pile = troublePile(item.text);
            const row = (
              <View style={[styles.trouble, index < view.trouble.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                <View style={[styles.troubleDot, { backgroundColor: item.level === 'bad' ? t.bad : item.level === 'warn' ? t.warn : t.ink3 }]} />
                <Txt size={14} style={kit.flex} numberOfLines={2}>{item.text}</Txt>
                {pile ? <Icon name="chevron" size={16} color={t.ink3} /> : null}
              </View>
            );
            return pile ? <Pressable key={item.text} accessibilityRole="button" onPress={() => nav.push({ name: 'jobs', pile })} style={({ pressed }) => pressed && kit.dim}>{row}</Pressable> : <View key={item.text}>{row}</View>;
          })}
        </Group>
      ) : null}

      {others.length ? <Label>Also going on</Label> : null}
      <View style={styles.stack}>
        {others.map((item) => <NeedsYouCard key={item.key || `${item.kind}-${item.id}`} item={item} connection={connection} onDone={load} onOpen={openNeed} onMark={(i, change) => mark([i], change)} />)}
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

      <Label>Work in hand</Label>
      {/* The piles in one row that scrolls sideways: each opens its jobs. */}
      {view.piles?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.piles} style={styles.pileRow}>
          {view.piles.map((pile) => (
            <Pressable key={pile.id} accessibilityRole="button" accessibilityLabel={`${pile.name}: ${pile.count}`} onPress={() => nav.push({ name: 'jobs', pile: pile.id })}
              style={({ pressed }) => [styles.pile, { backgroundColor: t.card, borderColor: pile.id === 'blocked' && pile.count ? t.bad : t.line, borderRadius: t.r.chip }, pressed && kit.dim]}>
              <Txt size={18} weight={700} color={pile.id === 'blocked' && pile.count ? t.bad : t.ink}>{pile.count}</Txt>
              <Txt size={12} color={t.ink2} numberOfLines={1}>{pile.name}</Txt>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {open.length === 0 ? <Txt color={t.ink2} style={styles.indent}>No open work.</Txt> : null}
      {working.length ? <Txt size={12} weight={700} color={t.good} style={styles.groupName}>{`WORKING NOW · ${working.length}`}</Txt> : null}
      <View style={styles.stack}>
        {working.map((line) => <LineRow key={line.id} line={line} who={faces.get(line.bot) ?? null} onOpen={openJob} />)}
      </View>
      {stoppedLines.length ? <Txt size={12} weight={700} color={t.bad} style={styles.groupName}>{`STOPPED · ${stoppedLines.length}`}</Txt> : null}
      <View style={styles.stack}>
        {stoppedLines.map((line) => <LineRow key={line.id} line={line} who={faces.get(line.bot) ?? null} onOpen={openJob} />)}
      </View>
      {waitingLines.length ? <Txt size={12} weight={700} color={t.ink3} style={styles.groupName}>{`WAITING FOR A BOT · ${waitingLines.length}`}</Txt> : null}
      <View style={styles.stack}>
        {(allWork ? waitingLines : waitingLines.slice(0, SHOWN_WAITING)).map((line) => <LineRow key={line.id} line={line} who={faces.get(line.bot) ?? null} onOpen={openJob} />)}
      </View>
      {waitingLines.length > SHOWN_WAITING && !allWork ? (
        <Pressable accessibilityRole="button" onPress={() => setAllWork(true)} style={styles.more}>
          <Txt size={14} weight={600} color={t.accentText}>Show all {waitingLines.length} waiting</Txt>
          <Icon name="chevron" size={16} color={t.accentText} />
        </Pressable>
      ) : null}
      {stalled.length ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showStalled }} onPress={() => setShowStalled((v) => !v)} style={({ pressed }) => [styles.fold, { borderColor: t.line }, pressed && kit.dim]}>
          <View style={[styles.troubleDot, { backgroundColor: t.warn }]} />
          <Txt size={14} weight={600} style={kit.flex}>{`${stalled.length} not moving: nothing done for ${STALL_HOURS} hours or more`}</Txt>
          <Icon name={showStalled ? 'up' : 'down'} size={16} color={t.ink2} />
        </Pressable>
      ) : null}
      {showStalled ? <View style={styles.stack}>{stalled.map((line) => <LineRow key={line.id} line={line} who={faces.get(line.bot) ?? null} stalled onOpen={openJob} />)}</View> : null}
      {view.piles?.length ? <Words title="What the piles and dots mean" from={{ ...DESCRIBE.pile, Dots: DESCRIBE.home.dots }} words={[...view.piles.map((pile) => pile.name), ...(open.length ? ['Dots'] : [])]} /> : null}

      {/* The crew: the pace, and who works on what. The tree is long, so it waits to be opened. */}
      <Label>Crew</Label>
      <PcLoadCard connection={connection} />
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showCrew }} onPress={() => setShowCrew((v) => !v)} style={({ pressed }) => [styles.fold, { borderColor: t.line }, pressed && kit.dim]}>
        <Icon name="people" size={18} color={t.accentText} />
        <Txt size={14} weight={600} color={t.accentText} style={kit.flex}>{showCrew ? 'Hide the crew map' : 'Show the crew map: who works on what'}</Txt>
        <Icon name={showCrew ? 'up' : 'down'} size={16} color={t.accentText} />
      </Pressable>
      {showCrew ? <CrewTree flow={flow} fallback={view} waiting={waiting} window={flowWindow} onWindow={chooseWindow} onOpenBot={openBot} onOwner={() => scroller.current?.scrollTo({ y: Math.max(0, needsAt.current - 8), animated: true })} /> : null}

      <Label>Projects</Label>
      <Group>
        {view.projects.slice(0, SHOWN_PROJECTS).map((project, index, list) => (
          <Pressable key={project.id} accessibilityRole="button" onPress={() => nav.push({ name: 'project', id: project.id })}
            style={({ pressed }) => [styles.project, index < list.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }, pressed && kit.dim]}>
            <View style={kit.flex}>
              {t.plates ? <Sign size={20}>{project.name}</Sign> : <Txt size={15} weight={600}>{project.name}</Txt>}
              <Txt size={13} color={project.blocked ? t.bad : t.ink2}>{projectLine(project)}</Txt>
            </View>
            <Icon name="chevron" size={16} color={t.ink3} />
          </Pressable>
        ))}
      </Group>

      {view.projects.length > SHOWN_PROJECTS ? (
        <Pressable accessibilityRole="button" onPress={() => nav.push({ name: 'projects' })} style={styles.more}>
          <Txt size={14} weight={600} color={t.accentText}>All {view.projects.length} projects</Txt>
          <Icon name="chevron" size={16} color={t.accentText} />
        </Pressable>
      ) : null}

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
  headButtons: { flexDirection: 'row', gap: 8 },
  allRead: { alignSelf: 'flex-end', justifyContent: 'center', minHeight: 44, paddingHorizontal: 4 },
  waiting: { alignItems: 'center', flex: 1, gap: 14, justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  head: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  state: { letterSpacing: -0.3, lineHeight: 28 },
  firstLabel: { marginTop: 18 },
  indent: { marginLeft: 4 },
  stack: { gap: 8 },
  shrink: { flexShrink: 1 },
  trouble: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  troubleDot: { borderRadius: 4, height: 8, width: 8 },
  bot: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 64, paddingHorizontal: 12, paddingVertical: 9 },
  botHead: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  card: { borderRadius: 18, gap: 3, padding: 14 },
  lineHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  steps: { flexDirection: 'row', gap: 4, marginTop: 8 },
  stepBox: { alignItems: 'center', flex: 1, gap: 3 },
  step: { alignSelf: 'stretch', borderRadius: 3, height: 5 },
  noBot: { borderRadius: 13, borderStyle: 'dashed', borderWidth: 1, height: 26, width: 26 },
  stateChip: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  groupName: { letterSpacing: 0.5, marginBottom: 6, marginLeft: 6, marginTop: 10 },
  project: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 11 },
  feed: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 14, paddingVertical: 11 },
  dot: { borderRadius: 4, height: 8, marginTop: 6, width: 8 },
  feedTime: { marginTop: 1, width: 38 },
  more: { alignItems: 'center', flexDirection: 'row', gap: 4, justifyContent: 'center', minHeight: 48 },
  fold: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 48 },
  pileRow: { marginHorizontal: -18 },
  piles: { gap: 8, paddingHorizontal: 18 },
  pile: { borderWidth: StyleSheet.hairlineWidth, gap: 1, minHeight: 56, minWidth: 84, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  views: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  viewButton: { alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 14 },
});
