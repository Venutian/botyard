import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Flow, FlowBot, FlowEdge, FlowKind, FlowNode, FlowOwner, FlowScript, FlowStatus, FlowWindow, Manager } from '../api';
import { BotBadge } from '../mascot/BotBadge';
import { portraitOf } from '../mascot/look';
import { readable } from '../theme/color';
import { useLook } from '../theme/prefs';
import { busyWords, copySentence, copyTag } from './copies';
import { DESCRIBE } from './describe';
import { Label, Segmented, Sign, styles as kit, Txt, Words } from './kit';

const WINDOWS: { id: FlowWindow; name: string }[] = [
  { id: 'now', name: 'Now' },
  { id: '24h', name: '24 h' },
  { id: '7d', name: '7 d' },
];

const STATUS_WORDS: Record<FlowStatus, string> = { working: 'working', waiting: 'waiting', free: 'free', resting: 'resting', paused: 'paused', error: 'in trouble' };
/** The words the crew screen explains, by the word it shows. */
const LEGEND: Record<string, string> = { ...DESCRIBE.botStatus, Lines: DESCRIBE.map.arrows, Met: DESCRIBE.map.met };
const KIND_WORD: Record<FlowKind, string> = {
  order: 'order', brief: 'brief', report: 'report', check: 'check', verdict: 'verdict', ask: 'ruling asked', ruling: 'ruling',
  idea: 'idea', approval: 'approval', start: 'start', card: 'card', notice: 'notice', wait: 'waits on',
};
/** Groups in the order they are read, below the owner and the lead. */
const GROUPS: { title: string; roles: string[] }[] = [
  { title: 'Judges', roles: ['ruler', 'reviewer'] },
  { title: 'Builders', roles: ['builder'] },
  { title: 'Checkers', roles: ['checker'] },
  { title: 'Researchers', roles: ['researcher'] },
  { title: 'Crew', roles: [] },
];

const word = (kind: FlowKind, n: number) => (kind === 'wait' || n === 1 || kind === 'ask' ? KIND_WORD[kind] : `${KIND_WORD[kind]}s`);
const count = (n: number, text: string) => `${n} ${text}`;

/** The manager's plain bot list drawn as map nodes, for a studio that has no crew map yet. */
export function nodesFromManager(view: Manager): FlowNode[] {
  const lead = view.bots.find((b) => b.role === 'lead');
  return view.bots.map((b): FlowBot => ({
    id: b.id, kind: 'bot', name: b.name, title: b.title, role: (b.role as FlowBot['role']) ?? 'general', roleName: b.role ?? 'bot',
    look: { colour: b.look?.colour ?? '', build: b.look?.build ?? '', gear: b.look?.gear ?? [], hat: b.look?.hat ?? '', face: b.look?.face ?? '' },
    reportsTo: b.role === 'lead' ? null : lead?.id ?? null, under: b.role === 'lead' ? 'owner' : lead?.id ?? 'owner',
    model: b.model, engine: '', status: b.status === 'running' ? 'working' : b.status === 'error' ? 'error' : b.status === 'paused' ? 'paused' : 'free',
    why: b.why, job: b.job ? { ...b.job, project: '', projectId: b.projectId } : null,
    jobs: b.jobs?.map((j) => ({ ...j, project: '', projectId: b.projectId })), copies: b.copies, on: b.on,
    runsToday: b.doneToday, failedToday: 0, week: { tokens: 0, share: null }, met: 0, notMet: 0,
  }));
}

type Chip = { text: string; failed: boolean };

/** What one node sends and receives, grouped by kind and direction; busiest first. */
function linesOf(node: FlowNode, edges: FlowEdge[], names: Map<string, string>, parent: string | null) {
  const into = new Map<string, { n: number; failed: boolean; who: Set<string> }>();
  const out = new Map<string, { n: number; failed: boolean; who: Set<string> }>();
  for (const e of edges) {
    const incoming = e.to === node.id;
    if (!incoming && e.from !== node.id) continue;
    const other = names.get(incoming ? e.from : e.to) ?? 'a bot';
    const key = `${e.kind}|${incoming && e.from === parent ? 'p' : incoming ? 'c' : e.to === parent ? 'p' : 'c'}`;
    const map = incoming ? into : out;
    const at = map.get(key) ?? { n: 0, failed: false, who: new Set<string>() };
    at.n += e.count;
    at.failed = at.failed || e.lastFailed;
    at.who.add(other);
    map.set(key, at);
  }
  const chips: (Chip & { n: number })[] = [];
  const sentence = (dir: 'in' | 'out', key: string, v: { n: number; who: Set<string> }) => {
    const [kind, side] = key.split('|') as [FlowKind, string];
    const who = v.who.size === 1 ? [...v.who][0] : count(v.who.size, 'bots');
    if (kind === 'wait') return dir === 'out' ? `waits on ${who}` : `${who} waits on it`;
    return dir === 'in' ? `${count(v.n, word(kind, v.n))} from ${who}` : `${count(v.n, word(kind, v.n))} to ${who}`;
  };
  for (const [key, v] of into) chips.push({ n: v.n, failed: v.failed, text: `↓ ${sentence('in', key, v)}` });
  for (const [key, v] of out) {
    const up = key.endsWith('|p');
    chips.push({ n: v.n, failed: v.failed, text: `${up ? '↑' : '→'} ${sentence('out', key, v)}` });
  }
  chips.sort((a, b) => b.n - a.n);
  const total = (m: typeof into) => [...m].map(([key, v]) => count(v.n, word(key.split('|')[0] as FlowKind, v.n)));
  return { chips: chips.slice(0, 3), ins: total(into), outs: total(out) };
}

function Lamp({ status }: { status: FlowStatus }) {
  const { t } = useLook();
  const colour = status === 'working' ? t.good : status === 'error' ? t.bad : status === 'waiting' || status === 'paused' ? t.warn : t.ink3;
  // The word beside it carries the meaning; the lamp is only a quick glance.
  return <View style={[styles.lamp, { backgroundColor: colour }]} />;
}

function Chips({ chips }: { chips: Chip[] }) {
  const { t } = useLook();
  if (!chips.length) return null;
  return (
    <View style={styles.chips}>
      {chips.map((chip) => (
        <View key={chip.text} style={[styles.chip, { borderColor: chip.failed ? t.bad : t.line, backgroundColor: chip.failed ? 'transparent' : t.control }]}>
          <Txt size={12} color={chip.failed ? t.bad : t.ink2}>{chip.text}{chip.failed ? ' (failed)' : ''}</Txt>
        </View>
      ))}
    </View>
  );
}

const BotNode = memo(function BotNode({ bot, depth, parentName, chips, ins, outs, onOpen }: {
  bot: FlowBot; depth: number; parentName: string | null; chips: Chip[]; ins: string[]; outs: string[]; onOpen: (id: string) => void;
}) {
  const { p, t } = useLook();
  const who = portraitOf({ ...bot, status: bot.status === 'working' ? 'running' : bot.status === 'error' ? 'error' : bot.status === 'paused' ? 'paused' : bot.status === 'waiting' ? 'waiting' : 'idle' }, p.bots[bot.id]);
  const status = STATUS_WORDS[bot.status] ?? bot.status;
  const many = busyWords(bot.jobs);
  const tag = copyTag(bot);
  const job = many ? `${many}: ${bot.jobs!.map((j) => j.ref).join(', ')}` : bot.job ? `${bot.job.title}  ${bot.job.ref}` : bot.why;
  const stats = [
    bot.runsToday ? count(bot.runsToday, bot.runsToday === 1 ? 'run today' : 'runs today') : '',
    bot.week.share !== null && bot.week.share !== undefined ? `${Math.round(bot.week.share * 100)}% of the Claude week` : '',
    bot.met || bot.notMet ? `${bot.met} met, ${bot.notMet} not met` : '',
  ].filter(Boolean).join(', ');
  const label = [
    `${who.name}, ${bot.roleName.toLowerCase()}, ${status}${many ? `, ${many}` : bot.job ? ` on ${bot.job.title}, ${bot.job.ref}` : bot.why ? `, ${bot.why}` : ''}.`,
    copySentence(bot),
    parentName ? `Reports to ${parentName}.` : '',
    ins.length || outs.length ? `${ins.length ? `${ins.join(', ')} in` : ''}${ins.length && outs.length ? ', ' : ''}${outs.length ? `${outs.join(', ')} out` : ''}.` : '',
    stats ? `${stats}.` : '',
  ].filter(Boolean).join(' ');
  const tone = bot.status === 'error' ? t.bad : t.ink2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen(bot.id)}
      style={({ pressed }) => [styles.node, { backgroundColor: t.card, borderColor: t.line, borderLeftColor: readable(who.colour, [t.card], 3, t.ink), marginLeft: depth * 12 }, pressed && kit.dim]}
    >
      <BotBadge who={who} size={40} tag={false} />
      <View style={kit.flex}>
        <View style={styles.nodeHead}>
          {t.plates ? <Sign size={19} numberOfLines={1} style={styles.shrink}>{who.name}</Sign> : <Txt size={15} weight={600} numberOfLines={1} style={styles.shrink}>{who.name}</Txt>}
          <Txt size={12} color={t.ink2} numberOfLines={1}>{bot.roleName}</Txt>
          {tag ? <View style={[styles.copyTag, { borderColor: t.line }]}><Txt size={11} weight={700} color={t.ink2}>{tag}</Txt></View> : null}
        </View>
        <View style={styles.statusLine}>
          <Lamp status={bot.status} />
          <Txt size={12} weight={700} color={tone}>{status[0].toUpperCase() + status.slice(1)}</Txt>
          <Txt size={12} color={t.ink3} numberOfLines={1} style={styles.shrink}>{bot.model}</Txt>
        </View>
        {many ? (
          <Txt size={13} color={t.ink} numberOfLines={2}>{many}<Txt size={13} weight={700} color={t.ink2}>{'  '}{bot.jobs!.map((j) => j.ref).join(', ')}</Txt></Txt>
        ) : job ? (
          <Txt size={13} color={bot.job ? t.ink : t.ink2} numberOfLines={2}>
            {bot.job ? bot.job.title : bot.why}
            {bot.job ? <Txt size={13} weight={700} color={t.ink2}>{'  '}{bot.job.ref}</Txt> : null}
          </Txt>
        ) : null}
        {stats ? <Txt size={12} color={t.ink2}>{stats}</Txt> : null}
        <Chips chips={chips} />
      </View>
    </Pressable>
  );
});

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useLook();
  return (
    <View style={styles.group}>
      <Txt accessibilityRole="header" size={12} weight={700} color={t.ink2} style={styles.groupTitle}>{title.toUpperCase()}</Txt>
      {children}
    </View>
  );
}

/**
 * The crew as a vertical tree: the owner, the lead, then the crew by role, each bot with its status,
 * its job and the lines to and from it. The order of the views is the reading order.
 */
export function CrewTree({ flow, fallback, waiting, window, onWindow, onOpenBot, onOwner }: {
  flow: Flow | null; fallback: Manager; waiting: number; window: FlowWindow; onWindow: (w: FlowWindow) => void;
  onOpenBot: (id: string) => void; onOwner: () => void;
}) {
  const { t } = useLook();
  const nodes = useMemo<FlowNode[]>(() => flow?.nodes ?? nodesFromManager(fallback), [flow, fallback]);
  const edges = flow?.edges ?? [];
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const bots = nodes.filter((n): n is FlowBot => n.kind === 'bot');
  const scripts = nodes.filter((n): n is FlowScript => n.kind === 'script');
  const owner: FlowOwner = (nodes.find((n): n is FlowOwner => n.kind === 'owner') ?? { id: 'owner', kind: 'owner', name: 'You', role: 'owner', roleName: 'Owner', needs: 0 });
  const depthOf = (bot: FlowBot) => {
    let d = 0;
    let at: string = bot.under;
    while (at !== 'owner' && d < 4) {
      const up = bots.find((b) => b.id === at);
      if (!up) break;
      d += 1;
      at = up.under;
    }
    return Math.min(d, 2);
  };
  const row = (bot: FlowBot) => {
    const parent = bot.reportsTo ?? (bot.under !== 'owner' ? bot.under : null);
    const { chips, ins, outs } = linesOf(bot, edges, names, parent);
    return <BotNode key={bot.id} bot={bot} depth={bot.role === 'lead' ? 0 : depthOf(bot)} parentName={parent ? names.get(parent) ?? null : null} chips={chips} ins={ins} outs={outs} onOpen={onOpenBot} />;
  };
  const lead = bots.filter((b) => b.role === 'lead');
  const known = GROUPS.flatMap((g) => g.roles).concat('lead');
  const ownerLines = linesOf(owner, edges, names, null);
  const ownerLabel = `You, owner. ${waiting} ${waiting === 1 ? 'decision waits' : 'decisions wait'} for you.${ownerLines.chips.length ? ` ${ownerLines.chips.map((c) => c.text.replace(/[↓↑→]/, '')).join(', ')}.` : ''}`;

  return (
    <View>
      <View style={styles.switchRow}>
        <Label style={styles.switchLabel}>Crew</Label>
        <View style={styles.switch}><Segmented value={window} options={WINDOWS} onChange={onWindow} /></View>
      </View>
      <Txt size={13} color={t.ink2}>{DESCRIBE.map[window]}</Txt>
      <Words title="How to read the crew" from={LEGEND} words={[...bots.map((b) => (STATUS_WORDS[b.status] ?? b.status).replace(/^./, (c) => c.toUpperCase())), 'Lines', ...(bots.some((b) => b.met || b.notMet) ? ['Met'] : [])]} />
      <Pressable accessibilityRole="button" accessibilityLabel={ownerLabel} onPress={onOwner} style={({ pressed }) => [styles.node, styles.owner, { backgroundColor: t.card, borderColor: waiting ? t.warn : t.line }, pressed && kit.dim]}>
        <View style={[styles.ownerMark, { backgroundColor: t.control }]}><Txt size={15} weight={700}>You</Txt></View>
        <View style={kit.flex}>
          <Txt size={15} weight={600}>You, owner</Txt>
          <Txt size={13} weight={700} color={waiting ? t.warn : t.ink2}>{waiting} {waiting === 1 ? 'decision waits' : 'decisions wait'} for you</Txt>
          <Chips chips={ownerLines.chips} />
        </View>
      </Pressable>
      {lead.length ? <Group title="Lead">{lead.map(row)}</Group> : null}
      {GROUPS.map((g) => {
        const list = bots.filter((b) => b.role !== 'lead' && (g.roles.length ? g.roles.includes(b.role) : !known.includes(b.role)));
        return list.length ? <Group key={g.title} title={g.title}>{list.map(row)}</Group> : null;
      })}
      {scripts.length ? (
        <Group title="Scripts">
          {scripts.map((s) => {
            const { chips } = linesOf(s, edges, names, null);
            return (
              <View key={s.id} accessible accessibilityLabel={`${s.name}, script, ${count(s.notices, s.notices === 1 ? 'notice' : 'notices')}.`} style={[styles.node, { backgroundColor: t.card, borderColor: t.line }]}>
                <View style={kit.flex}>
                  <Txt size={14} weight={600} numberOfLines={1}>{s.name}</Txt>
                  <Txt size={12} color={t.ink2}>Script, {count(s.notices, s.notices === 1 ? 'notice' : 'notices')}</Txt>
                  <Chips chips={chips} />
                </View>
              </View>
            );
          })}
        </Group>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  switchLabel: { flexShrink: 1 },
  switch: { width: 190 },
  group: { gap: 8, marginTop: 14 },
  groupTitle: { letterSpacing: 0.6, marginLeft: 4 },
  node: { alignItems: 'flex-start', borderLeftWidth: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 64, padding: 10 },
  owner: { borderLeftWidth: 6 },
  ownerMark: { alignItems: 'center', borderRadius: 20, height: 40, justifyContent: 'center', width: 40 },
  nodeHead: { alignItems: 'baseline', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  statusLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  lamp: { borderRadius: 5, height: 10, width: 10 },
  shrink: { flexShrink: 1 },
  copyTag: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
});
