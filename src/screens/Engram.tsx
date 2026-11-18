import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { RADIUS, SHAPE, brainDust, fieldLayout } from '../brainLayout';
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

/** Light inks on the dark field, one per area: the same as the PC's Engram. */
const FIELD_INKS = ['#6ea8ff', '#46f0cc', '#b98cff', '#ff9a5c', '#ff6fcf', '#9be564', '#ffd166', '#ff7a7a', '#6fd8ff', '#e7c99a'];
const VOID = '#020309';

/**
 * The brain seen from the side, still: the same neurons, lobes and fibres as the PC's Engram (brainLayout.ts),
 * drawn once in SVG. A neuron glows in its area's colour, the newest decisions are white-hot, a superseded note
 * is ash with a dashed fibre to what replaced it. Tap a neuron to read it, a lobe's name to show only that area.
 */
function BrainField({ brain, chosenArea, onArea, onNote }: { brain: Extract<Brain, { on: true }>; chosenArea: string; onArea: (id: string) => void; onNote: (id: string) => void }) {
  const { width: screen } = useWindowDimensions();
  const width = Math.min(screen - 32, 720);
  const height = Math.round(width * 0.78);
  const { at, centres } = useMemo(() => fieldLayout(brain), [brain]);
  const dust = useMemo(() => brainDust(1500), []);
  const scale = (width * 0.92) / (2 * RADIUS * SHAPE.z);
  const px = (p: { y: number; z: number }) => ({ x: width / 2 - p.z * scale, y: height / 2 + 10 - p.y * scale * 1.05 });
  const slot = new Map(brain.areas.map((a, i) => [a.id, i % FIELD_INKS.length]));
  const inkOf = (area: string) => FIELD_INKS[slot.get(area) ?? 0];
  const newest = dayOf(brain.to) - 3 * DAY;
  const dim = (area: string) => Boolean(chosenArea) && chosenArea !== area;
  const byId = new Map(brain.notes.map((n) => [n.id, n]));
  const fibres: { d: string; ink: string; ash: boolean; faint: boolean; key: string }[] = [];
  for (const n of brain.notes) {
    const a = at.get(n.id);
    if (!a) continue;
    for (const [t, ash] of [...n.links.map((x) => [x, false] as const), ...n.supersededBy.map((x) => [x, true] as const)]) {
      const b = at.get(t);
      if (!b) continue;
      const pa = px(a);
      const pb = px(b);
      const c = px({ y: (a.y + b.y) / 2 * 0.5, z: (a.z + b.z) / 2 * 0.5 });
      fibres.push({ key: `${n.id}>${t}${ash ? '!' : ''}`, d: `M${pa.x.toFixed(1)} ${pa.y.toFixed(1)}Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`, ink: ash ? '#8a94a6' : inkOf(n.area), ash, faint: dim(n.area) && dim(byId.get(t)?.area ?? '') });
    }
  }
  return (
    <View style={[styles.field, { width, height }]} accessible accessibilityLabel={`${brain.notes.length} notes in ${brain.areas.length} areas, drawn as a brain. The list below has every note.`}>
      <Svg width={width} height={height}>
        <Defs>
          {FIELD_INKS.map((ink, i) => (
            <RadialGradient key={ink} id={`g${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
              <Stop offset="0.22" stopColor={ink} stopOpacity="0.9" />
              <Stop offset="1" stopColor={ink} stopOpacity="0" />
            </RadialGradient>
          ))}
          <RadialGradient id="hot" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="1" />
            <Stop offset="0.35" stopColor="#fff1c9" stopOpacity="0.85" />
            <Stop offset="1" stopColor="#ffd166" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} rx={12} fill={VOID} />
        {Array.from({ length: dust.length / 3 }, (_, i) => {
          const p = px({ y: dust[i * 3 + 1], z: dust[i * 3 + 2] });
          return <Circle key={i} cx={p.x} cy={p.y} r={0.75} fill={dust[i * 3 + 2] > 0 ? '#4f8dff' : '#9a6bff'} opacity={0.45} />;
        })}
        {fibres.map((f) => <Path key={f.key} d={f.d} stroke={f.ink} strokeWidth={f.ash ? 1 : 1.1} strokeDasharray={f.ash ? '4 3' : undefined} fill="none" opacity={f.faint ? 0.08 : f.ash ? 0.55 : 0.5} />)}
        {brain.notes.map((n) => {
          const p = px(at.get(n.id)!);
          const old = n.status === 'superseded';
          const fresh = n.kind === 'decision' && !old && dayOf(n.date) >= newest;
          const r = (n.kind === 'decision' ? 9 : n.kind === 'preference' ? 7 : 5.5) + (n.pinned ? 2.5 : 0) + (fresh ? 3 : 0);
          const fill = old ? '#5d6676' : fresh ? 'url(#hot)' : `url(#g${slot.get(n.area) ?? 0})`;
          return (
            <G key={n.id} opacity={dim(n.area) ? 0.15 : old ? 0.6 : 1} onPress={() => onNote(n.id)}>
              <Circle cx={p.x} cy={p.y} r={old ? r * 0.45 : r * 1.6} fill={fill} />
              {n.imported ? <Circle cx={p.x} cy={p.y} r={r * 0.9} stroke={inkOf(n.area)} strokeWidth={0.8} strokeDasharray="1.5 2" fill="none" /> : null}
            </G>
          );
        })}
      </Svg>
      {brain.areas.map((a) => {
        const c = centres.get(a.id);
        if (!c) return null;
        const p = px({ y: c.y + 46, z: c.z });
        return (
          <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={`${a.name}, ${a.count} notes${a.private ? ', private' : ''}. Show only this area.`} onPress={() => onArea(chosenArea === a.id ? '' : a.id)}
            style={[styles.lobe, { left: p.x, top: p.y, borderColor: inkOf(a.id), opacity: dim(a.id) ? 0.35 : 1, transform: [{ translateX: -40 }, { translateY: -10 }] }]}>
            <Txt size={11} weight={700} color={inkOf(a.id)} numberOfLines={1}>{a.name} {a.count}</Txt>
          </Pressable>
        );
      })}
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
          <BrainField brain={brain} chosenArea={area} onArea={setArea} onNote={(id) => nav.push({ name: 'engramNote', id })} />
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
  field: { alignSelf: 'center', borderRadius: 12, overflow: 'hidden', backgroundColor: VOID },
  lobe: { position: 'absolute', width: 80, alignItems: 'center', paddingVertical: 2, borderWidth: 1, borderRadius: 999, backgroundColor: 'rgba(2,3,9,0.72)' },
  text: { padding: 14, borderRadius: 10, borderWidth: 1 },
});
