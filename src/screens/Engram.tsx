import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, G, Line as SvgLine, Path, Rect } from 'react-native-svg';
import { Brain, BrainNote, Connection, getBrain, getBrainNote } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Chips, Field, Label, Txt } from '../ui/kit';
import { Line, Page, Tag, useLoad } from '../ui/page';
import { Markdown } from '../ui/Markdown';

/**
 * Engram on the phone: the owner's notes as strata (one band per area, a mark per note at the day it was
 * made), then the notes newest first, by month. A tap opens the note. Read-only; the phone door answers
 * the owner's key only, never a bot.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;
const dayOf = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const said = (iso: string) => { const d = new Date(dayOf(iso)); return `${d.getUTCDate()} ${SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const KIND: Record<BrainNote['kind'], string> = { decision: 'Decision', preference: 'Preference', fact: 'Fact', inbox: 'Inbox note', note: 'Note' };
/** The same inks as the PC view, by day and by night: at least 3:1 on the plates. */
const DAY_INKS = ['#1f5fbf', '#0b7a63', '#7a3fd1', '#b0461a', '#a3127a', '#4a7512', '#8a6000', '#b8261b', '#20698c', '#6b5838'];
const NIGHT_INKS = ['#7fb2ff', '#4fd1bd', '#c3a3ff', '#ff9f6b', '#ff7ad9', '#a8dc5a', '#ffd166', '#ff8a80', '#7fd3f0', '#d9c29a'];

function useInks(brain: Brain | null) {
  const { t } = useLook();
  return useMemo(() => {
    const inks = t.dark ? NIGHT_INKS : DAY_INKS;
    const map = new Map<string, string>();
    if (brain?.on) brain.areas.forEach((a, i) => map.set(a.id, inks[i % inks.length]));
    return (area: string) => map.get(area) ?? t.ink3;
  }, [brain, t.dark, t.ink3]);
}

/** The strata: one band per area, a mark per note, a dashed arrow from a superseded note to its successor. */
function Strata({ brain, ink, chosenArea, onArea }: { brain: Extract<Brain, { on: true }>; ink: (area: string) => string; chosenArea: string; onArea: (id: string) => void }) {
  const { t } = useLook();
  const { width: screen } = useWindowDimensions();
  const width = Math.min(screen - 32, 720);
  const band = 30;
  const height = brain.areas.length * band;
  const from = dayOf(brain.from) - 2 * DAY;
  const to = dayOf(brain.to) + 2 * DAY;
  const x = (iso: string) => 8 + ((dayOf(iso) - from) / Math.max(DAY, to - from)) * (width - 16);
  const row = new Map(brain.areas.map((a, i) => [a.id, i]));
  const newest = dayOf(brain.to) - 3 * DAY;
  const at = new Map(brain.notes.map((n) => [n.id, { x: x(n.date), y: (row.get(n.area) ?? 0) * band + band / 2 }]));
  return (
    <View accessible accessibilityLabel={`${brain.notes.length} notes in ${brain.areas.length} areas, from ${said(brain.from)} to ${said(brain.to)}`}>
      <Svg width={width} height={height}>
        {brain.areas.map((a, i) => <Rect key={a.id} x={0} y={i * band} width={width} height={band} fill={ink(a.id)} opacity={chosenArea && chosenArea !== a.id ? 0.03 : i % 2 ? 0.1 : 0.06} />)}
        {brain.notes.flatMap((n) => n.supersededBy.map((s) => { const a = at.get(n.id); const b = at.get(s); return a && b ? <SvgLine key={`${n.id}>${s}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={t.ink3} strokeWidth={1.4} strokeDasharray="4 3" /> : null; }))}
        {brain.notes.map((n) => {
          const p = at.get(n.id)!;
          const c = ink(n.area);
          const r = n.pinned ? 5.5 : 4;
          const faint = chosenArea && chosenArea !== n.area ? 0.2 : 1;
          const old = n.status === 'superseded';
          const fill = old || n.kind === 'inbox' || n.kind === 'note' ? t.card : c;
          const glow = n.kind === 'decision' && !old && dayOf(n.date) >= newest;
          return (
            <G key={n.id}>
              {glow ? <Circle cx={p.x} cy={p.y} r={r * 2.6} fill="#ffb020" opacity={0.35} /> : null}
              {n.kind === 'decision'
                ? <Path d={`M${p.x} ${p.y - r * 1.3}L${p.x + r * 1.3} ${p.y}L${p.x} ${p.y + r * 1.3}L${p.x - r * 1.3} ${p.y}Z`} fill={fill} stroke={c} strokeWidth={1.4} opacity={faint} />
                : n.kind === 'preference'
                  ? <Rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={1.2} fill={fill} stroke={c} strokeWidth={1.4} opacity={faint} />
                  : <Circle cx={p.x} cy={p.y} r={r} fill={fill} stroke={c} strokeWidth={1.4} opacity={faint} />}
            </G>
          );
        })}
      </Svg>
      <View style={styles.bandNames} pointerEvents="box-none">
        {brain.areas.map((a) => (
          <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={`${a.name}, ${a.count} notes${a.private ? ', private' : ''}. Show only this area.`} onPress={() => onArea(chosenArea === a.id ? '' : a.id)} style={[styles.bandName, { height: band }]}>
            <View style={[styles.swatch, { backgroundColor: ink(a.id) }]} />
            <Txt size={11} weight={700} color={t.ink2}>{a.name} {a.count}</Txt>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function EngramScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getBrain(connection), [connection], 60_000);
  const ink = useInks(data);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('');
  const brain = data?.on ? data : null;
  const shown = useMemo(() => {
    if (!brain) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return brain.notes.filter((n) => (!area || n.area === area) && words.every((w) => `${n.title} ${n.area} ${n.tags.join(' ')} ${n.excerpt}`.toLowerCase().includes(w))).slice().reverse();
  }, [brain, query, area]);
  const months: { name: string; notes: BrainNote[] }[] = [];
  for (const n of shown) {
    const d = new Date(dayOf(n.date));
    const name = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (months.at(-1)?.name !== name) months.push({ name, notes: [] });
    months.at(-1)!.notes.push(n);
  }
  return (
    <Page title="Engram" note={brain ? `${brain.notes.length} notes, ${said(brain.from)} to ${said(brain.to)}. Read-only: edit notes in their files.` : undefined} onBack={nav.back} onRefresh={load} error={error} loading={!data && !error}>
      {data && !data.on ? <Txt color={t.ink2}>{data.why} Set the notes folder on the PC, in the Engram view.</Txt> : null}
      {brain ? (
        <>
          <Strata brain={brain} ink={ink} chosenArea={area} onArea={setArea} />
          <Field label="Search the notes" value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" returnKeyType="search" />
          <Chips value={area} options={[{ id: '', name: 'All areas' }, ...brain.areas.map((a) => ({ id: a.id, name: `${a.name} ${a.count}` }))]} onChange={setArea} />
          {months.length === 0 ? <Txt color={t.ink2}>No note matches.</Txt> : null}
          {months.map((m) => (
            <View key={m.name}>
              <Label>{m.name}</Label>
              {m.notes.map((n, i) => (
                <Line
                  key={n.id}
                  dot={ink(n.area)}
                  title={n.title}
                  detail={n.excerpt}
                  note={`${KIND[n.kind]} in ${n.area}, ${said(n.date)}`}
                  tone={n.status === 'superseded' ? t.ink3 : undefined}
                  right={n.status === 'superseded' ? <Tag text="Replaced" color={t.ink3} /> : n.imported ? <Tag text="To review" color={t.warn} /> : n.private ? <Tag text="Private" color={t.ink3} /> : undefined}
                  onPress={() => nav.push({ name: 'engramNote', id: n.id })}
                  last={i === m.notes.length - 1}
                />
              ))}
            </View>
          ))}
        </>
      ) : null}
    </Page>
  );
}

export function EngramNoteScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const note = useLoad(() => getBrainNote(connection, id), [connection, id]);
  const all = useLoad(() => getBrain(connection), [connection]);
  const brain = all.data?.on ? all.data : null;
  const title = (x: string) => brain?.notes.find((n) => n.id === x)?.title ?? x;
  const n = note.data;
  const backs = brain ? brain.notes.filter((x) => x.links.includes(id)).map((x) => x.id) : [];
  const list = (label: string, ids: string[]) => ids.length ? (
    <View>
      <Label>{label}</Label>
      {ids.map((x, i) => <Line key={x} title={title(x)} onPress={() => nav.push({ name: 'engramNote', id: x })} last={i === ids.length - 1} />)}
    </View>
  ) : null;
  // [[links]] read as the note's title; the links are listed below as buttons.
  const text = n ? n.text.replace(/^#\s+.*\n?/, '').replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_m, x: string, label?: string) => `**${label || title(x.trim())}**`) : '';
  return (
    <Page title={n?.title ?? 'Note'} note={n ? `${KIND[n.kind]} in ${n.area}${n.private ? ', private' : ''}, ${said(n.date)}${n.status !== 'accepted' ? `, ${n.status}` : ''}${n.imported ? ', imported, to review' : ''}` : undefined} onBack={nav.back} onRefresh={note.load} error={note.error} loading={!n && !note.error}>
      {n ? (
        <>
          {list('Replaced by', n.supersededBy)}
          <View style={[styles.text, { backgroundColor: t.card, borderColor: t.line }]}><Markdown text={text} ink={t.ink} size={15} /></View>
          {list('Replaces', n.supersedes)}
          {list('Links to', n.links)}
          {list('Named by', backs)}
          <Txt size={12} color={t.ink3}>{n.path}. Edit it in the file; this view only reads.</Txt>
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  bandNames: { position: 'absolute', left: 0, top: 0 },
  bandName: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingTop: 2, paddingLeft: 4 },
  swatch: { width: 3, height: 10, borderRadius: 1.5, marginTop: 2 },
  text: { padding: 14, borderRadius: 10, borderWidth: 1 },
});
