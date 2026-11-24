import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, DayReport, decide, getSummary, Guard, NeedsYou, Plans, setGuard, Summary } from '../api';
import { Nav, Route } from '../crew';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { ConnectionBadge } from '../ui/ConnectionBadge';
import { Icon } from '../ui/Icon';
import { DESCRIBE } from '../ui/describe';
import { Button, Chips, Field, GlassButton, Group, Hazard, Hinted, Label, Row, styles as kit, Title, Toggle, Txt, useTap } from '../ui/kit';
import { IconName } from '../ui/Icon';
import { alpha } from '../theme/color';

const REFRESH_MS = 20_000;
const LIMITS = [1, 2, 5, 10, 20, 50].map((m) => ({ id: String(m * 1_000_000), name: `${m}M` }));
const shares = (list: number[]) => list.map((p) => ({ id: String(p / 100), name: `${p}%` }));
const CREW_STOPS = shares([70, 80, 85, 90, 95]);
const LEAD_STOPS = shares([90, 95, 97, 100]);
const percent = (share: number) => `${Math.round(share * 100)}%`;

const shortCount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));

/** What the bots used. Tokens, because subscription runs bill nothing and a dollar figure would always read zero. */
/** The subscriptions' own weekly shares, as Claude and Codex report them; the engine's token totals count resumed sessions twice. */
function UsageCard({ plans, guard, connection, onChange }: { plans?: Plans; guard?: Guard; connection: Connection; onChange: () => void }) {
  const { t } = useLook();
  const [limits, setLimits] = useState({ enabled: Boolean(guard?.enabled), limit: guard?.limit || 5_000_000, weekCeiling: guard?.weekCeiling ?? 0.9, leadCeiling: guard?.leadCeiling ?? 0.97 });
  const change = async (next: typeof limits) => {
    setLimits(next);
    try {
      // The PC may correct a number (the lead never stops before the crew): show what it kept.
      const kept = await setGuard(connection, next);
      setLimits({ enabled: kept.enabled, limit: kept.limit || next.limit, weekCeiling: kept.weekCeiling ?? next.weekCeiling, leadCeiling: kept.leadCeiling ?? next.leadCeiling });
      onChange();
    } catch (err) {
      tell('That did not work', (err as Error).message);
    }
  };
  const rows = [
    plans?.claude && { id: 'claude', name: 'Claude', share: plans.claude.week, note: `this week, resets ${when(plans.claude.resets)}` },
    plans?.codex && { id: 'codex', name: 'Codex', share: plans.codex.week, note: `this week, resets ${when(plans.codex.resets)}` },
    plans?.codex?.fiveHours != null && { id: 'codex5', name: 'Codex 5 h', share: plans.codex.fiveHours, note: `resets ${when(plans.codex.fiveHoursResets)}` },
  ].filter(Boolean) as { id: string; name: string; share: number; note: string }[];
  return (
    <Group>
      <View style={styles.usage}>
        {rows.map((row) => (
          <View key={row.id}>
            <View style={styles.usageRow}>
              <Txt size={14} weight={600} style={styles.usageName}>{row.name}</Txt>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.meter, { backgroundColor: t.control, borderColor: t.edge, borderWidth: StyleSheet.hairlineWidth }]}>
                <View style={{ backgroundColor: row.share >= 0.9 ? t.bad : row.share >= 0.8 ? t.warn : t.accent, height: '100%', width: `${Math.min(100, row.share * 100)}%` }} />
              </View>
              <Txt size={14} color={t.ink2} style={styles.usageCount}>{Math.round(row.share * 100)}%</Txt>
            </View>
            <Txt size={12} color={t.ink3}>{row.note}</Txt>
          </View>
        ))}
        {plans?.backup ? <Txt size={13} color={t.ink2}>Codex is out: the Codex bots think in Antigravity until about {when(plans.backup.until)}.</Txt> : null}
        <Txt size={12} color={t.ink3}>
          {rows.length ? `The share each subscription reports. The Claude bots stop at ${percent(limits.weekCeiling)} of the week, so the rest is yours. ` : 'Usage is not readable right now. '}
          {guard ? `Claude bots this week: ${shortCount(guard.used)} tokens.` : ''}
        </Txt>
      </View>
      <Row title="The crew stops at" detail={`${percent(limits.weekCeiling)} of Claude's week, until it resets`}>
        <Chips value={String(limits.weekCeiling)} options={CREW_STOPS} onChange={(share) => change({ ...limits, weekCeiling: Number(share) })} />
      </Row>
      <Row title="The lead stops at" detail={`${percent(limits.leadCeiling)}, so rulings go on after the crew pauses`}>
        <Chips value={String(limits.leadCeiling)} options={LEAD_STOPS} onChange={(share) => change({ ...limits, leadCeiling: Number(share) })} />
      </Row>
      <Row title="Token guard" detail={limits.enabled ? `Pauses the Claude bots at ${shortCount(limits.limit)} in 7 days` : 'Off'} last right={<Toggle label="Token guard" value={limits.enabled} onChange={(enabled) => change({ ...limits, enabled })} />}>
        {limits.enabled ? <Chips value={String(limits.limit)} options={LIMITS} onChange={(limit) => change({ ...limits, limit: Number(limit) })} /> : null}
      </Row>
    </Group>
  );
}

/** A reset time in epoch seconds, as a weekday and time. */
function when(stamp: number | null | undefined) {
  if (!stamp) return 'soon';
  return new Date(stamp * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function ReportCard({ report, onOpen }: { report: DayReport; onOpen: (id: string) => void }) {
  const { t } = useLook();
  return (
    <Group>
      <View style={styles.report}>
        <Txt size={15} weight={600}>{report.finishedCount ? `${report.finishedCount} job${report.finishedCount === 1 ? '' : 's'} finished` : 'Nothing finished yet'}</Txt>
        {report.finished.slice(0, 4).map((job) => (
          <Pressable key={job.id} accessibilityRole="button" onPress={() => onOpen(job.id)} style={({ pressed }) => [styles.reportLine, pressed && kit.dim]}>
            <Txt size={14} color={t.ink2} numberOfLines={1}>{job.title}</Txt>
          </Pressable>
        ))}
      </View>
    </Group>
  );
}

/** A small text button for sorting a card: archive, restore. */
export function SortButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useLook();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.sortButton, pressed && kit.dim]}>
      <Txt size={13} weight={600} color={t.ink2}>{label}</Txt>
    </Pressable>
  );
}

export function NeedsYouCard({ item, connection, onDone, onOpen, onMark }: { item: NeedsYou; connection: Connection; onDone: () => void; onOpen: (item: NeedsYou) => void; onMark?: (item: NeedsYou, change: { read?: boolean; archived?: boolean }) => void }) {
  const { p, t } = useLook();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const act = (decision: 'approve' | 'reject') => {
    ask(decision === 'approve' ? 'Approve this?' : 'Reject this?', item.title, decision === 'approve' ? 'Approve' : 'Reject', async () => {
      setBusy(true);
      try {
        await decide(connection, item.id, decision, note.trim() || undefined);
        onDone();
      } catch (err) {
        tell('That did not work', (err as Error).message);
      } finally {
        setBusy(false);
      }
    });
  };
  const tag = { approval: 'Approval', question: 'Question for you', blocked: 'Blocked', review: 'Ready to review', failed: 'Failed' }[item.kind];
  const tone = item.kind === 'failed' || item.kind === 'blocked' ? t.bad : item.kind === 'question' ? t.accentText : t.warn;
  return (
    <Pressable
      accessibilityRole={item.kind === 'approval' || !item.id ? undefined : 'button'}
      accessibilityLabel={item.kind === 'approval' || !item.id ? undefined : [item.read ? '' : 'New', tag, item.title, item.detail].filter(Boolean).join('. ')}
      disabled={item.kind === 'approval' || !item.id}
      onPress={() => onOpen(item)}
      style={[
        styles.card,
        { backgroundColor: item.read ? 'transparent' : t.card, borderColor: t.outline ? t.ink : tone, borderLeftWidth: 4, borderWidth: t.outline ? 2 : 0, boxShadow: item.read ? undefined : t.shadow },
        // A plate: small corners, and hazard stripes along the top while it is new.
        t.plates && { borderRadius: t.r.card, borderWidth: item.read ? StyleSheet.hairlineWidth : 0, borderLeftWidth: item.read ? StyleSheet.hairlineWidth : 0, overflow: 'hidden', borderColor: t.line },
        t.plates && !item.read && styles.striped,
      ]}
    >
      {t.plates && !item.read ? <Hazard /> : null}
      <Txt size={12} weight={700} color={tone}>{item.read || t.plates ? '' : '● '}{tag}</Txt>
      {p.explain && tag && (DESCRIBE.status as Record<string, string>)[tag] ? <Txt size={13} color={t.ink2}>{(DESCRIBE.status as Record<string, string>)[tag]}</Txt> : null}
      <Txt size={16} weight={item.read ? 400 : 600} color={item.read ? t.ink2 : undefined}>{item.title}</Txt>
      {item.detail ? <Txt size={14} color={t.ink2}>{item.detail}</Txt> : null}
      {item.kind === 'approval' ? <Field value={note} onChangeText={setNote} placeholder="Add a note (optional)" accessibilityLabel="A note with your answer, optional" maxLength={2000} style={{ backgroundColor: t.control }} /> : null}
      {item.kind === 'approval' ? (
        <View style={styles.actions}>
          <View style={kit.flex}><Button label="Approve" hint={DESCRIBE.act.Approve} onPress={() => act('approve')} busy={busy} /></View>
          <View style={kit.flex}><Button label="Reject" kind="danger" hint={DESCRIBE.act.Reject} onPress={() => act('reject')} busy={busy} /></View>
        </View>
      ) : null}
      {onMark && item.key ? (
        <View style={styles.sort}>
          {item.archived ? (
            <Hinted hint={DESCRIBE.act.Restore}><SortButton label="Restore" onPress={() => onMark(item, { archived: false })} /></Hinted>
          ) : (
            <Hinted hint={DESCRIBE.act.Archive}><SortButton label="Archive" onPress={() => onMark(item, { archived: true })} /></Hinted>
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Every section of the studio the PC map has. The four used most are big tiles that say how things stand;
 * the rest are small tiles, three to a row. `detail` is what a screen reader says.
 */
type Section = { title: string; short: string; detail: string; icon: IconName; route: Route };
const MAIN: Section[] = [
  { title: 'Jobs', short: 'In hand, waiting, done', detail: 'Any job: in hand, waiting, backlog, blocked, done today or cancelled, by project or bot, or searched', icon: 'jobs', route: { name: 'jobs' } },
  { title: 'Projects', short: 'Ranking and goals', detail: 'Your ranking, the shelf, each project in full; add one', icon: 'folder', route: { name: 'projects' } },
  { title: 'Bots', short: 'Who works on what', detail: 'Who is working, resting or stuck and why; add a bot or change one', icon: 'bot', route: { name: 'bots' } },
  { title: 'Runs', short: 'Every run, and why one failed', detail: 'Every run and why one failed; who did what', icon: 'activity', route: { name: 'runs' } },
];
const MORE: Section[] = [
  { title: 'Models', short: '', detail: 'Who runs on what, free models, and the week by bot', icon: 'chip', route: { name: 'models' } },
  { title: 'Tracks', short: '', detail: 'How each request moves step by step, what waits for you, and what it cost', icon: 'route', route: { name: 'tracks' } },
  { title: 'Launch', short: '', detail: 'Every product on every store and channel: where it stands, and what it waits on', icon: 'rocket', route: { name: 'launch' } },
  { title: 'Routines', short: '', detail: 'Work that starts by itself, and the scripts that keep the crew moving', icon: 'repeat', route: { name: 'routines' } },
  { title: 'Improve', short: '', detail: 'What the audits found worth improving, its status, and the job that carries it', icon: 'sparkle', route: { name: 'improvements' } },
  { title: 'Library', short: '', detail: 'Pictures, documents and files the crew made', icon: 'book', route: { name: 'library' } },
  { title: 'Connectors', short: '', detail: 'Services the crew may use, who may use each, and the sign-ins', icon: 'plug', route: { name: 'connectors' } },
  { title: 'Company', short: '', detail: 'Members and open invites', icon: 'people', route: { name: 'company' } },
  { title: 'Setup', short: '', detail: 'What the studio needs to run: free models, your AI sign-ins, keys', icon: 'sliders', route: { name: 'setup' } },
];

/** How a big tile's section stands now, from the studio's summary; nothing when there is nothing to say. */
function tileStatus(title: string, s: Summary) {
  if (title === 'Jobs') return `${s.running.length} running, ${s.queued.length} queued${s.stalled ? `, ${s.stalled} stuck` : ''}`;
  if (title === 'Bots') {
    const working = s.bots.filter((b) => b.status === 'running').length;
    return `${working} of ${s.bots.length} working`;
  }
  if (title === 'Projects') return `${s.projects.length} ${s.projects.length === 1 ? 'project' : 'projects'}`;
  if (title === 'Runs' && s.report) return `${s.report.finishedCount} finished in 24 h`;
  return undefined;
}

/** A section as a tile: its icon on a tinted square, its name, and on a big tile how it stands now. */
function Tile({ section, big, status, onPress }: { section: Section; big?: boolean; status?: string; onPress: () => void }) {
  const { p, t } = useLook();
  const tap = useTap();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={section.title}
      accessibilityHint={[status, section.detail].filter(Boolean).join('. ')}
      onPress={() => { tap(); onPress(); }}
      style={({ pressed }) => [
        big ? styles.bigTile : styles.smallTile,
        { backgroundColor: t.card, borderColor: t.line, borderRadius: t.r.card, boxShadow: t.shadow },
        pressed && styles.tilePressed,
      ]}
    >
      <View style={[big ? styles.bigIcon : styles.smallIcon, { backgroundColor: alpha(t.accent, t.dark ? 0.16 : 0.2) }]}>
        <Icon name={section.icon} size={big ? 22 : 20} color={t.accentText} />
      </View>
      {big ? (
        <View style={styles.bigText}>
          <Txt size={17} weight={700} numberOfLines={1}>{section.title}</Txt>
          <Txt size={13} color={status ? t.ink : t.ink2} weight={status ? 600 : 400} numberOfLines={2}>{status || section.short}</Txt>
        </View>
      ) : (
        <Txt size={13} weight={600} numberOfLines={1} style={styles.smallName}>{section.title}</Txt>
      )}
      {big && p.explain ? <Txt size={12} color={t.ink3}>{section.detail}</Txt> : null}
    </Pressable>
  );
}

export function StudioScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getSummary(connection);
      setSummary(next);
      // The door keeps the last answer it had when the engine is down, and says so.
      setError(next.error || '');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };
  const open = (id: string) => nav.push({ name: 'job', id });

  return (
    <ScrollView
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <View style={styles.pad}>
        <View style={styles.head}>
          <View style={kit.flex}>
            <Title>{summary?.company || 'Studio'}</Title>
            <ConnectionBadge connection={connection} />
          </View>
          <GlassButton icon="plus" label="New job" hint={DESCRIBE.icon.newJob} onPress={() => nav.push({ name: 'new' })} />
        </View>
        {error ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">{summary ? 'Showing the last update. ' : ''}{error}</Txt> : null}
        {!summary && !error ? <ActivityIndicator color={t.accent} style={styles.firstLabel} accessibilityLabel="Loading" /> : null}

        <View style={[styles.grid, styles.firstLabel]}>
          {MAIN.map((section) => (
            <Tile key={section.title} section={section} big onPress={() => nav.push(section.route)}
              status={summary ? tileStatus(section.title, summary) : undefined} />
          ))}
        </View>
        <Label>More</Label>
        <View style={styles.grid}>
          {MORE.map((section) => <Tile key={section.title} section={section} onPress={() => nav.push(section.route)} />)}
        </View>

        {summary?.report ? (
          <>
            <Label>Last 24 hours</Label>
            <ReportCard report={summary.report} onOpen={open} />
          </>
        ) : null}
        {summary?.usage?.length ? (
          <>
            <Label>Bot usage</Label>
            <UsageCard plans={summary.plans} guard={summary.guard} connection={connection} onChange={load} />
          </>
        ) : null}
        {summary?.sessions.length ? <Label>Other live sessions</Label> : null}
        <View style={styles.stack}>
          {summary?.sessions.map((session, index) => (
            <View key={`${session.title}-${index}`} style={[styles.card, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : 0, borderRadius: t.r.card, boxShadow: t.shadow }]}>
              <Txt size={15} weight={600} numberOfLines={2}>{session.title}</Txt>
              <Txt size={13} color={t.ink2}>{[session.project, session.harness].filter(Boolean).join(', ')}</Txt>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: 'center', flex: 1, gap: 14, justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  pad: { paddingHorizontal: 18 },
  head: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  firstLabel: { marginTop: 18 },
  usage: { gap: 12, padding: 14 },
  report: { gap: 0, padding: 14 },
  usageRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  usageName: { width: 56 },
  usageCount: { textAlign: 'right', width: 52 },
  meter: { borderRadius: 6, flex: 1, height: 12, overflow: 'hidden' },
  indent: { marginLeft: 4 },
  stack: { gap: 8 },
  card: { borderRadius: 18, gap: 4, padding: 14 },
  striped: { paddingTop: 21 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  sort: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginBottom: -8, marginTop: 0 },
  sortButton: { justifyContent: 'center', minHeight: 44, minWidth: 44, paddingHorizontal: 8 },
  reportLine: { justifyContent: 'center', minHeight: 44 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bigTile: { borderWidth: StyleSheet.hairlineWidth, flexBasis: '46%', flexGrow: 1, gap: 14, minHeight: 132, padding: 14 },
  smallTile: { alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, flexBasis: '30%', flexGrow: 1, gap: 10, justifyContent: 'center', minHeight: 96, paddingHorizontal: 6, paddingVertical: 14 },
  tilePressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  bigIcon: { alignItems: 'center', borderRadius: 12, height: 42, justifyContent: 'center', width: 42 },
  smallIcon: { alignItems: 'center', borderRadius: 12, height: 40, justifyContent: 'center', width: 40 },
  bigText: { gap: 2 },
  smallName: { textAlign: 'center' },
});
