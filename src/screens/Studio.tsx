import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, DayReport, decide, getSummary, Guard, NeedsYou, Plans, setGuard, Summary } from '../api';
import { Nav, Route } from '../crew';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { ConnectionBadge } from '../ui/ConnectionBadge';
import { Icon } from '../ui/Icon';
import { Button, Chips, Field, GlassButton, Group, Hazard, Label, Row, styles as kit, Title, Toggle, Txt } from '../ui/kit';

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
              <View style={[styles.meter, { backgroundColor: t.control }]}>
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
      <View style={styles.usage}>
        <Txt size={15} weight={600}>{report.finishedCount ? `${report.finishedCount} job${report.finishedCount === 1 ? '' : 's'} finished` : 'Nothing finished yet'}</Txt>
        {report.finished.slice(0, 4).map((job) => (
          <Pressable key={job.id} accessibilityRole="button" onPress={() => onOpen(job.id)} style={({ pressed }) => pressed && kit.dim}>
            <Txt size={14} color={t.ink2} numberOfLines={1}>{job.title}</Txt>
          </Pressable>
        ))}
      </View>
    </Group>
  );
}

/** A small text button for sorting a card: read, unread, archive, restore. */
export function SortButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useLook();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.sortButton, { borderColor: t.ink3 }, t.plates && { borderRadius: t.r.chip, borderWidth: 2 }, pressed && kit.dim]}>
      <Txt size={13} weight={600} color={t.ink2}>{label}</Txt>
    </Pressable>
  );
}

export function NeedsYouCard({ item, connection, onDone, onOpen, onMark }: { item: NeedsYou; connection: Connection; onDone: () => void; onOpen: (item: NeedsYou) => void; onMark?: (item: NeedsYou, change: { read?: boolean; archived?: boolean }) => void }) {
  const { t } = useLook();
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
      disabled={item.kind === 'approval' || !item.id}
      onPress={() => onOpen(item)}
      style={[
        styles.card,
        { backgroundColor: item.read ? 'transparent' : t.card, borderColor: t.outline ? t.ink : tone, borderLeftWidth: 4, borderWidth: t.outline ? 2 : 0, boxShadow: item.read ? undefined : t.shadow },
        // A plate: small corners, and hazard stripes along the top while it is new.
        t.plates && { borderRadius: t.r.card, borderLeftWidth: 2, overflow: 'hidden', borderColor: item.read ? t.line : t.dark ? '#05070a' : t.ink },
        t.plates && !item.read && styles.striped,
      ]}
    >
      {t.plates && !item.read ? <Hazard /> : null}
      <Txt size={12} weight={700} color={tone}>{item.read || t.plates ? '' : '● '}{tag}</Txt>
      <Txt size={16} weight={item.read ? 400 : 600} color={item.read ? t.ink2 : undefined}>{item.title}</Txt>
      {item.detail ? <Txt size={14} color={t.ink2}>{item.detail}</Txt> : null}
      {item.kind === 'approval' ? <Field value={note} onChangeText={setNote} placeholder="Add a note (optional)" maxLength={2000} style={{ backgroundColor: t.control, minHeight: 42 }} /> : null}
      {item.kind === 'approval' ? (
        <View style={styles.actions}>
          <View style={kit.flex}><Button label="Approve" onPress={() => act('approve')} busy={busy} /></View>
          <View style={kit.flex}><Button label="Reject" kind="danger" onPress={() => act('reject')} busy={busy} /></View>
        </View>
      ) : null}
      {onMark && item.key ? (
        <View style={styles.sort}>
          {item.archived ? (
            <SortButton label="Restore" onPress={() => onMark(item, { archived: false })} />
          ) : (
            <>
              <SortButton label={item.read ? 'Unread' : 'Read'} onPress={() => onMark(item, { read: !item.read })} />
              <SortButton label="Archive" onPress={() => onMark(item, { archived: true })} />
            </>
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Every section of the studio the PC map has, one line each: what it answers. */
const SECTIONS: { title: string; detail: string; route: Route }[] = [
  { title: 'Jobs', detail: 'Any job: active, backlog or done, by project or bot, or searched', route: { name: 'jobs' } },
  { title: 'Projects', detail: 'Your ranking, the shelf, each project in full; add one', route: { name: 'projects' } },
  { title: 'Bots', detail: 'Who is working, resting or stuck and why; add a bot or change one', route: { name: 'bots' } },
  { title: 'Runs and activity', detail: 'Every run and why one failed; who did what', route: { name: 'runs' } },
  { title: 'Models and spend', detail: 'Who runs on what, free models, and the week by bot', route: { name: 'models' } },
  { title: 'Routines and helpers', detail: 'Work that starts by itself, and the scripts that keep the crew moving', route: { name: 'routines' } },
  { title: 'Library', detail: 'Pictures, documents and files the crew made', route: { name: 'library' } },
  { title: 'Connectors', detail: 'Services the crew may use, who may use each, and the sign-ins', route: { name: 'connectors' } },
  { title: 'Company', detail: 'Members and open invites', route: { name: 'company' } },
  { title: 'Setup', detail: 'What the studio needs to run: free models, your AI sign-ins, keys', route: { name: 'setup' } },
];

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
            {summary ? <Txt color={t.ink2}>{summary.running.length} running, {summary.queued.length} queued</Txt> : null}
            <ConnectionBadge connection={connection} />
          </View>
          <GlassButton icon="plus" label="New job" onPress={() => nav.push({ name: 'new' })} />
        </View>
        {error ? <Txt size={14} color={t.bad}>{summary ? 'Showing the last update. ' : ''}{error}</Txt> : null}
        {!summary && !error ? <ActivityIndicator color={t.accent} style={styles.firstLabel} /> : null}

        <Label style={styles.firstLabel}>Sections</Label>
        <Group>
          {SECTIONS.map((section, index) => (
            <Row key={section.title} title={section.title} detail={section.detail} last={index === SECTIONS.length - 1} onPress={() => nav.push(section.route)} right={<Icon name="chevron" size={18} color={t.ink3} />} />
          ))}
        </Group>

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
  usageRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  usageName: { width: 56 },
  usageCount: { textAlign: 'right', width: 52 },
  meter: { borderRadius: 6, flex: 1, height: 12, overflow: 'hidden' },
  indent: { marginLeft: 4 },
  stack: { gap: 8 },
  card: { borderRadius: 18, gap: 4, padding: 14 },
  striped: { paddingTop: 21 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  sort: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 },
  sortButton: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 5 },
});
