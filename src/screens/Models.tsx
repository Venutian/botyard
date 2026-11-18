import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, FreeModel, getModels, getSpend, ModelBot, Models, SpendLine, SpendView, Switch } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { DESCRIBE } from '../ui/describe';
import { Button, GlassButton, Group, Label, Row, Segmented, styles as kit, Title, Txt, Words } from '../ui/kit';
import { tokens } from '../ui/page';

const REFRESH_MS = 30_000;
const STATUS_WORDS: Record<string, string> = { running: 'Working', idle: 'Ready', paused: 'Resting', error: 'In trouble' };
const TIER_WORDS = { strong: 'Strong', light: 'Light' };

/** A time in epoch seconds: the clock today, the weekday and clock this week, else the date too. 24 h, like the door's own sentence. */
function at(stamp: number | null | undefined, now: number) {
  if (!stamp) return 'soon';
  const date = new Date(stamp * 1000);
  const today = new Date(now * 1000).toDateString() === date.toDateString();
  const farther = Math.abs(stamp - now) > 6 * 86_400;
  return date.toLocaleString(undefined, { ...(today ? {} : farther ? { day: 'numeric', month: 'short' } : { weekday: 'short' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** How long until a time: "3 d 11 h", "45 min", or "any moment". */
function until(stamp: number | null | undefined, now: number) {
  if (!stamp) return 'soon';
  const minutes = Math.round((stamp - now) / 60);
  if (minutes < 1) return 'any moment';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** How long ago: "just now", "10 min ago", "2 h ago", "3 d ago". */
function ago(stamp: number, now: number) {
  const minutes = Math.round((now - stamp) / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The one line to read first: what is stuck, and why. */
function HealthCard({ health, now }: { health: Models['health']; now: number }) {
  const { t } = useLook();
  const tone = health.tone === 'bad' ? t.bad : health.tone === 'warn' ? t.warn : t.good;
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.outline ? t.ink : tone, borderLeftWidth: 5, borderWidth: t.outline ? 2 : 0, borderRadius: t.r.card, boxShadow: t.shadow }]}>
      <Txt size={12} weight={700} color={tone}>{health.tone === 'bad' ? 'Stuck' : health.tone === 'warn' ? 'Watch' : 'All good'}</Txt>
      <Txt size={16} weight={600}>{health.text}</Txt>
      <Txt size={12} color={t.ink3}>Checked {ago(health.at, now)}</Txt>
    </View>
  );
}

function BotRow({ bot, last, onOpen }: { bot: ModelBot; last: boolean; onOpen: () => void }) {
  const { t } = useLook();
  const busy = bot.status === 'running';
  const trouble = bot.status === 'error';
  return (
    <Row
      title={bot.name}
      detail={bot.free ? bot.label : `${bot.label} on ${bot.where}`}
      last={last}
      onPress={onOpen}
      right={<Txt size={13} weight={600} color={busy ? t.accentText : trouble ? t.bad : t.ink3}>{STATUS_WORDS[bot.status] ?? bot.status}</Txt>}
    />
  );
}

function Meter({ name, share, note }: { name: string; share: number; note: string }) {
  const { t } = useLook();
  return (
    <View style={styles.meterBlock}>
      <View style={styles.meterRow}>
        <Txt size={14} weight={600} style={styles.meterName}>{name}</Txt>
        <View style={[styles.meter, { backgroundColor: t.control }]}>
          <View style={{ backgroundColor: share >= 0.9 ? t.bad : share >= 0.8 ? t.warn : t.accent, height: '100%', width: `${Math.min(100, share * 100)}%` }} />
        </View>
        <Txt size={14} color={t.ink2} style={styles.meterCount}>{Math.round(share * 100)}%</Txt>
      </View>
      <Txt size={12} color={t.ink3}>{note}</Txt>
    </View>
  );
}

function Subscriptions({ subs, now }: { subs: Models['subscriptions']; now: number }) {
  const { t } = useLook();
  const resets = (stamp: number | null) => (stamp ? `resets in ${until(stamp, now)}, ${at(stamp, now)}` : 'reset time not known');
  const meters = [
    subs.claude && { id: 'claude', name: 'Claude', share: subs.claude.week, note: `this week, ${resets(subs.claude.resets)}` },
    subs.codex && { id: 'codex', name: 'Codex', share: subs.codex.week, note: `this week, ${resets(subs.codex.resets)}` },
    // An empty five-hour window with no reset time is Codex saying nothing: leave it out.
    subs.codex?.fiveHours != null && (subs.codex.fiveHours > 0 || subs.codex.fiveHoursResets) && { id: 'codex5', name: 'Codex 5 h', share: subs.codex.fiveHours, note: resets(subs.codex.fiveHoursResets) },
  ].filter(Boolean) as { id: string; name: string; share: number; note: string }[];
  const thinking = subs.thinking;
  const usedUp = subs.antigravityUsedUp;
  const lines = [
    thinking.on === 'gemini'
      ? `Codex is out${thinking.since ? ` since ${at(thinking.since, now)}` : ''}: the thinking bots run in Antigravity${thinking.back ? ` until about ${at(thinking.back, now)}` : ''}.`
      : 'The thinking bots run on Codex.',
    usedUp.length
      ? `Antigravity: ${usedUp.length === 1 ? `${usedUp[0].label} is` : `${usedUp.length} models are`} used up, back in ${until(Math.min(...usedUp.map((m) => m.until)), now)}${usedUp.length > 1 ? ' at the earliest' : ''}.`
      : null,
    thinking.onClaude.length ? `On the Claude subscription meanwhile: ${thinking.onClaude.join(', ')}.` : null,
  ].filter(Boolean) as string[];
  return (
    <Group>
      <View style={styles.inner}>
        {meters.length ? meters.map((m) => <Meter key={m.id} name={m.name} share={m.share} note={m.note} />) : <Txt size={14} color={t.ink2}>The subscriptions are not readable right now.</Txt>}
        {lines.map((line) => <Txt key={line} size={14} color={t.ink2}>{line}</Txt>)}
      </View>
    </Group>
  );
}

function FreeRow({ model, now, last }: { model: FreeModel; now: number; last: boolean }) {
  const { t } = useLook();
  const tone = model.state === 'answering' ? t.good : model.state === 'aside' ? t.warn : t.ink3;
  const tier = `${TIER_WORDS[model.tier]}${model.demoted ? ' after failed checks' : ''}${model.found ? ', found by the scout' : ''}`;
  const state = model.state === 'answering' && model.checkedAt
    ? `Answered ${ago(model.checkedAt, now)}`
    : model.state === 'aside'
      ? `Set aside: ${model.why || 'did not answer'}. Back ${until(model.until, now) === 'any moment' ? 'any moment' : `in ${until(model.until, now)}, at ${at(model.until, now)}`}`
      : 'Not checked yet';
  const record = model.pass != null || model.fail != null ? `The checker's tests: ${model.pass ?? 0} passed, ${model.fail ?? 0} failed` : null;
  return (
    <View style={[kit.row, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.freeHead}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <View style={kit.flex}>
          <View style={styles.nameRow}>
            <Txt size={15} weight={600}>{model.label}</Txt>
            {model.claude ? <ClaudeChipTag claude={model.claude} /> : null}
          </View>
          <Txt size={13} color={model.state === 'aside' ? t.warn : t.ink2}>{state}</Txt>
          <Txt size={13} color={t.ink3}>{[tier, record].filter(Boolean).join('. ')}</Txt>
        </View>
      </View>
    </View>
  );
}

function SwitchRow({ line, now, last }: { line: Switch; now: number; last: boolean }) {
  const { t } = useLook();
  return (
    <View style={[kit.row, styles.switchRow, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Txt size={13} color={t.ink3} style={styles.when}>{line.at ? at(line.at, now) : ''}</Txt>
      <Txt size={14} style={kit.flex}>{line.text}</Txt>
    </View>
  );
}

type SpendBy = 'bots' | 'projects' | 'models';

/** One spend line as a bar against the biggest, with its number: the week at a glance. */
function SpendBar({ line, top, note, warn }: { line: SpendLine; top: number; note?: string; warn?: boolean }) {
  const { t } = useLook();
  return (
    <View style={styles.meterBlock}>
      <View style={styles.meterRow}>
        <Txt size={14} weight={600} numberOfLines={1} style={styles.spendName}>{line.name}</Txt>
        <View style={[styles.meter, { backgroundColor: t.control }]}>
          <View style={{ backgroundColor: warn ? t.bad : t.accent, height: '100%', width: `${top ? Math.max(2, (line.tokens / top) * 100) : 0}%` }} />
        </View>
        <Txt size={13} color={t.ink2} style={styles.meterCount}>{tokens(line.tokens)}</Txt>
      </View>
      {note ? <Txt size={12} color={warn ? t.bad : t.ink3}>{note}</Txt> : null}
    </View>
  );
}

/** The week's tokens by bot, project or model. Subscriptions bill nothing, so tokens are the measure. */
function SpendCard({ spend }: { spend: SpendView }) {
  const { t } = useLook();
  const [by, setBy] = useState<SpendBy>('bots');
  const rows: (SpendLine & { note?: string; warn?: boolean })[] = by === 'bots'
    ? spend.bots.map((b) => ({ ...b, note: [b.today ? `${tokens(b.today)} today` : '', b.waste ? `${tokens(b.waste)} on runs that bought nothing` : ''].filter(Boolean).join(', '), warn: b.tokens > 0 && b.waste / b.tokens > 0.3 }))
    : by === 'projects' ? spend.projects : spend.models;
  const top = Math.max(0, ...rows.map((r) => r.tokens));
  const total = rows.reduce((sum, r) => sum + r.tokens, 0);
  return (
    <Group>
      <View style={styles.inner}>
        <Segmented<SpendBy> value={by} options={[{ id: 'bots', name: 'Bots' }, { id: 'projects', name: 'Projects' }, { id: 'models', name: 'Models' }]} onChange={setBy} />
        <Txt size={13} color={t.ink2}>{`${DESCRIBE.spend[by]}. ${DESCRIBE.spend.bar}.`}</Txt>
        {rows.length ? rows.slice(0, 12).map((row) => <SpendBar key={row.name} line={row} top={top} note={row.note || undefined} warn={row.warn} />) : <Txt size={14} color={t.ink2}>Nothing used this week.</Txt>}
        <Txt size={12} color={t.ink3}>{`${tokens(total)} tokens in 7 days${spend.priced ? '' : ', all on subscriptions'}.`}{spend.pace ? ` Claude's week is at ${Math.round(spend.pace.week * 100)} %, using ${(spend.pace.perHourNow * 100).toFixed(1)} % an hour of ${(spend.pace.perHourAllowed * 100).toFixed(1)} % allowed.` : ''}</Txt>
      </View>
    </Group>
  );
}

/** Which model every bot runs on, which free models answer, how much of each subscription is left, and the last switches. */
export function ModelsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [models, setModels] = useState<Models | null>(null);
  const [spend, setSpend] = useState<SpendView | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    try {
      setModels(await getModels(connection));
      setError('');
      getSpend(connection).then(setSpend).catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
    }
    setNow(Math.floor(Date.now() / 1000));
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

  const answering = models?.free.filter((m) => m.state === 'answering').length ?? 0;
  const strong = models?.free.filter((m) => m.state === 'answering' && m.tier === 'strong').length ?? 0;

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />}
    >
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Models and spend</Title>
      <Txt color={t.ink2}>Who runs on what right now, and what the week used. Refreshes every half minute, or pull down.</Txt>
      {error ? <Txt size={14} color={t.bad}>{models ? 'Showing the last update. ' : ''}{error}</Txt> : null}
      {!models && !error ? <ActivityIndicator color={t.accent} style={styles.spinner} /> : null}
      {!models && error ? <Button label="Try again" onPress={load} /> : null}
      {models ? (
        <>
          <HealthCard health={models.health} now={now} />

          <Label>Who runs on what</Label>
          <Words from={{ Working: DESCRIBE.botStatus.Working, Ready: DESCRIBE.status.Ready, Resting: DESCRIBE.botStatus.Resting, 'In trouble': DESCRIBE.botStatus['In trouble'] }} words={models.bots.map((b) => STATUS_WORDS[b.status] ?? b.status)} />
          <Group>
            {models.bots.map((bot, index) => <BotRow key={bot.id} bot={bot} last={index === models.bots.length - 1} onOpen={() => nav.push({ name: 'bot', botId: bot.id })} />)}
          </Group>

          {spend ? (
            <>
              <Label>This week</Label>
              <SpendCard spend={spend} />
            </>
          ) : null}

          <Label>Subscriptions</Label>
          <Subscriptions subs={models.subscriptions} now={now} />

          <Label>Free models</Label>
          {models.freeListError ? <Txt size={14} color={t.bad} style={styles.note}>{models.freeListError}</Txt> : null}
          {models.free.length ? (
            <>
              <Txt size={14} color={t.ink2} style={styles.note}>{answering} of {models.free.length} answer, {strong} strong. Set-aside models are tried again when their hour is up.</Txt>
              <Group>
                {models.free.map((model, index) => <FreeRow key={model.label} model={model} now={now} last={index === models.free.length - 1} />)}
              </Group>
            </>
          ) : null}

          <Label>Recent switches</Label>
          <Group>
            {models.switches.length ? models.switches.map((line, index) => <SwitchRow key={`${line.at}-${index}`} line={line} now={now} last={index === models.switches.length - 1} />) : <View style={styles.inner}><Txt size={14} color={t.ink2}>No switches recorded.</Txt></View>}
          </Group>

          <Label>The scout's last finds</Label>
          <Group>
            {models.scout.length ? models.scout.map((line, index) => <SwitchRow key={`${line.at}-${index}`} line={line} now={now} last={index === models.scout.length - 1} />) : <View style={styles.inner}><Txt size={14} color={t.ink2}>The scout has not reported yet.</Txt></View>}
          </Group>

          <Label>Known limits</Label>
          <Group>
            {models.limits.map((limit, index) => <Row key={limit.provider} title={limit.provider} detail={limit.note} last={index === models.limits.length - 1} />)}
          </Group>
        </>
      ) : null}
    </ScrollView>
  );
}

const CHIP_FILL: Record<string, string> = { below: '#5d6676', haiku: '#1f62d6', sonnet: '#7a3fd1', opus: '#c99400' };

/** A free model's chip against Claude: bold, its tier's colour, the meaning read out and shown on a long press. */
function ClaudeChipTag({ claude }: { claude: NonNullable<FreeModel['claude']> }) {
  const { t } = useLook();
  const fill = CHIP_FILL[claude.tier];
  const name = claude.chip.replace(/^[+-]/, '');
  const meaning = claude.chip === 'unrated' ? 'Not rated yet: fewer than three of its jobs have been checked' : claude.chip.startsWith('-') ? `Weaker than Claude ${name}` : `About as good as Claude ${name}${claude.chip.startsWith('+') ? ', a bit better' : ''}`;
  return (
    <View accessible accessibilityLabel={meaning} style={[styles.chip, fill ? { backgroundColor: fill } : { borderWidth: 1.5, borderColor: t.ink3 }]}>
      <Txt size={12} weight={700} color={fill ? (claude.tier === 'opus' ? '#1d1304' : '#ffffff') : t.ink3}>{claude.chip}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 5 },
  page: { gap: 8, paddingHorizontal: 18 },
  spinner: { marginTop: 24 },
  card: { borderRadius: 18, gap: 4, marginTop: 14, padding: 14 },
  inner: { gap: 12, padding: 14 },
  note: { marginBottom: 8, marginLeft: 4 },
  meterBlock: { gap: 2 },
  meterRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  meterName: { width: 72 },
  spendName: { width: 104 },
  meterCount: { textAlign: 'right', width: 48 },
  meter: { borderRadius: 6, flex: 1, height: 12, overflow: 'hidden' },
  freeHead: { flexDirection: 'row', gap: 10 },
  dot: { borderRadius: 5, height: 10, marginTop: 6, width: 10 },
  switchRow: { flexDirection: 'row', gap: 10 },
  when: { minWidth: 72 },
});
