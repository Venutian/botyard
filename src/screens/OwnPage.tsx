import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Connection, getOwnView, ownCall } from '../api';
import { Nav } from '../crew';
import { Block, Open, Tone, viewPath, withOpen } from '../ownView';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Icon } from '../ui/Icon';
import { Button, Chips, Field, Group, Label, styles as kit, Txt, useTap } from '../ui/kit';
import { Markdown } from '../ui/Markdown';
import { Line, Page, useLoad } from '../ui/page';

type Choose = (param: string, value: string) => void;
type OnOpen = (opened: Open) => void;

/**
 * A page of the owner's own, on the phone: the view its server file sends (src/ownView.ts), drawn with the
 * app's own parts. The page's code never runs here. A chip or a bar opens the view again with that choice; an
 * item with `open` opens it with a few choices at once (a category, a shop), and Back steps back through them
 * before it leaves the page. A button calls the page's own server and reads the view again.
 */
export function OwnPageScreen({ connection, nav, page, title }: { connection: Connection; nav: Nav; page: string; title: string }) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const before = useRef<Record<string, string>[]>([]);
  const [depth, setDepth] = useState(0);
  const { data, error, load } = useLoad(() => getOwnView(connection, page, choices), [connection, page, choices]);
  // Every new view keeps the one before it, so Back can return to it.
  const now = useRef(choices);
  now.current = choices;
  const step = useCallback((make: (current: Record<string, string>) => Record<string, string>) => {
    const next = make(now.current);
    if (viewPath(now.current) === viewPath(next)) return;
    before.current = [...before.current, now.current].slice(-30);
    setDepth(before.current.length);
    setChoices(next);
  }, []);
  const choose: Choose = useCallback((param, value) => step((current) => ({ ...current, [param]: value })), [step]);
  const onOpen: OnOpen = useCallback((opened) => step((current) => withOpen(current, opened)), [step]);
  const back = useCallback(() => {
    const last = before.current[before.current.length - 1];
    if (!last) return false;
    before.current = before.current.slice(0, -1);
    setDepth(before.current.length);
    setChoices(last);
    return true;
  }, []);
  // The phone's own back key steps back through the views first, then leaves the page as before. The newest
  // listener is asked first, so it is added again on each step, after the app's own (which leaves the page).
  useEffect(() => {
    if (!depth) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', back);
    return () => sub.remove();
  }, [back, depth]);
  const { t } = useLook();
  const empty = data && !data.blocks.length;
  // Each view that comes back is drawn afresh (folds shut, boxes filled from it), not the one before it reused.
  const drawn = useRef(0);
  const version = useMemo(() => (drawn.current += 1), [data]);
  return (
    <Page title={data?.title || title} note={data?.note} onBack={() => { if (!back()) nav.back(); }} onRefresh={load} error={error} loading={!data} top={`${viewPath(choices)}#${depth}`}>
      {empty ? <Txt color={t.ink2}>This page sent nothing to show on a phone.</Txt> : null}
      {data?.blocks.map((block, i) => <BlockView key={`${version}-${block.kind}-${i}`} block={block} choose={choose} onOpen={onOpen} connection={connection} page={page} reload={load} />)}
    </Page>
  );
}

function useTone() {
  const { t } = useLook();
  return (tone: Tone, fallback = t.ink) => (tone === 'good' ? t.good : tone === 'bad' ? t.bad : tone === 'warn' ? t.warn : fallback);
}

/** A tap that opens a view, or nothing when the item opens none. */
function Tappable({ opened, onOpen, label, style, children }: { opened: Open | null; onOpen: OnOpen; label: string; style?: object; children: ReactNode }) {
  const tap = useTap();
  if (!opened) return <View style={style} accessible accessibilityLabel={label}>{children}</View>;
  return (
    <Pressable style={({ pressed }) => [style, pressed && kit.dim]} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens its details"
      onPress={() => { tap(); onOpen(opened); }}>{children}</Pressable>
  );
}

/** Colours for shares, apart from one another on a light and a dark plate. */
const SHARES = ['#4f7fe8', '#e0913a', '#3fae84', '#c75a9c', '#8a6be0', '#d4b33c', '#3aa7c4', '#d0604f', '#7c9a3c', '#8c8f96'];

function BlockView({ block, choose, onOpen, connection, page, reload }: { block: Block; choose: Choose; onOpen: OnOpen; connection: Connection; page: string; reload: () => Promise<void> }) {
  const { t } = useLook();
  const ink = useTone();
  switch (block.kind) {
    case 'heading':
      return <Label>{block.text}</Label>;
    case 'text':
      return (
        <View style={[styles.text, block.tone && { borderLeftColor: ink(block.tone), borderLeftWidth: 4, paddingLeft: 12 }]}>
          <Markdown text={block.text} ink={t.ink} size={15} />
        </View>
      );
    case 'tiles':
      return (
        <View style={styles.tiles}>
          {block.items.map((tile) => (
            <Tappable key={tile.label} opened={tile.open} onOpen={onOpen} label={[tile.label, tile.value, tile.note].filter(Boolean).join('. ')}
              style={[styles.tile, { backgroundColor: t.card, borderRadius: t.r.card, borderColor: t.outline ? t.ink : t.line, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth }]}>
              <View style={styles.tileHead}>
                <Txt size={12} weight={600} color={t.ink2} numberOfLines={2} style={kit.flex}>{tile.label}</Txt>
                {tile.open ? <Icon name="chevron" size={12} color={t.ink3} /> : null}
              </View>
              <Txt size={tile.value.length > 11 ? 16 : 20} weight={700} color={ink(tile.tone)} numberOfLines={2}>{tile.value}</Txt>
              {tile.note ? <Txt size={12} color={t.ink3} numberOfLines={2}>{tile.note}</Txt> : null}
            </Tappable>
          ))}
        </View>
      );
    case 'chart':
      return <Chart block={block} choose={choose} onOpen={onOpen} />;
    case 'bars': {
      const top = Math.max(1, ...block.items.map((b) => Math.max(b.value, b.mark ?? 0)));
      return (
        <View style={styles.gap}>
          {block.title ? <Label>{block.title}</Label> : null}
          <Group>
            {block.items.map((bar, i) => (
              <Tappable key={`${bar.label}-${i}`} opened={bar.open} onOpen={onOpen} label={[bar.label, bar.shown, bar.note].filter(Boolean).join('. ')}
                style={[styles.bar, i < block.items.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                <View style={styles.barHead}>
                  <Txt size={14} weight={600} style={kit.flex} numberOfLines={1}>{bar.label}</Txt>
                  <Txt size={14} weight={700} color={ink(bar.tone)}>{bar.shown}</Txt>
                  {bar.open ? <Icon name="chevron" size={14} color={t.ink3} /> : null}
                </View>
                <View style={[styles.track, { backgroundColor: t.control }]}>
                  <View style={[styles.fill, { width: `${(bar.value / top) * 100}%`, backgroundColor: ink(bar.tone, t.accent) }]} />
                  {bar.mark !== null ? <View style={[styles.mark, { left: `${(bar.mark / top) * 100}%`, backgroundColor: t.ink }]} /> : null}
                </View>
                {bar.note ? <Txt size={12} color={t.ink3}>{bar.note}</Txt> : null}
              </Tappable>
            ))}
          </Group>
        </View>
      );
    }
    case 'rows':
      return (
        <View style={styles.gap}>
          {block.title ? <Label>{block.title}</Label> : null}
          <Group>
            {block.items.map((row, i) => (
              <Line key={`${row.title}-${i}`} title={row.title} detail={row.detail} note={row.note} tone={row.tone ? ink(row.tone) : undefined} last={i === block.items.length - 1}
                onPress={row.open ? () => onOpen(row.open as Open) : undefined}
                right={row.right ? <Txt size={14} weight={700} color={row.tone ? ink(row.tone) : t.ink} style={styles.right}>{row.right}</Txt> : undefined} />
            ))}
          </Group>
        </View>
      );
    case 'list':
      return (
        <View style={styles.gap}>
          {block.title ? <Label>{block.title}</Label> : null}
          <View style={[styles.listBox, { backgroundColor: t.card, borderRadius: t.r.card }]}>
            {block.items.map((item, i) => (
              <View key={i} style={styles.listItem}>
                <Txt size={15} color={t.ink3}>{'•'}</Txt>
                <Txt size={15} style={kit.flex}>{item}</Txt>
              </View>
            ))}
          </View>
        </View>
      );
    case 'split':
      return <Split block={block} onOpen={onOpen} />;
    case 'table':
      return <Table block={block} onOpen={onOpen} />;
    case 'choose':
      return <Chips value={block.value} options={block.options} onChange={(id) => choose(block.param, id)} />;
    case 'search':
      return <Search block={block} choose={choose} />;
    case 'actions':
      return <Actions items={block.items} connection={connection} page={page} reload={reload} />;
    case 'fold':
      return <Fold title={block.title}>{block.blocks.map((inner, i) => <BlockView key={`${inner.kind}-${i}`} block={inner} choose={choose} onOpen={onOpen} connection={connection} page={page} reload={reload} />)}</Fold>;
  }
}

/** Bars up from a line, one per label; the chosen one in full paint, a tap on another opens it. `mark` is a line across. */
function Chart({ block, choose, onOpen }: { block: Extract<Block, { kind: 'chart' }>; choose: Choose; onOpen: OnOpen }) {
  const { t } = useLook();
  const ink = useTone();
  const tap = useTap();
  const top = Math.max(1, block.mark ?? 0, ...block.items.map((b) => b.value));
  const picked = block.items.find((b) => b.on);
  return (
    <View style={styles.gap}>
      {block.title ? <Label>{block.title}</Label> : null}
      <View style={[styles.chart, { backgroundColor: t.card, borderRadius: t.r.card }]}>
        <View style={styles.columns}>
          {block.mark !== null ? (
            <View pointerEvents="none" style={styles.markLayer}>
              <View style={[styles.markLine, { bottom: `${(block.mark / top) * 100}%`, borderColor: t.ink2 }]} />
            </View>
          ) : null}
          {block.items.map((bar, i) => {
            const paint = bar.tone ? ink(bar.tone) : bar.on ? t.accent : t.edge;
            const body = (
              <View style={styles.column}>
                <View style={styles.columnSpace}>
                  <View style={[styles.columnFill, { height: `${Math.max(2, (bar.value / top) * 100)}%`, backgroundColor: paint, opacity: bar.on || !picked ? 1 : 0.55 }]} />
                </View>
                <Txt size={11} weight={bar.on ? 700 : 400} color={bar.on ? t.ink : t.ink2} numberOfLines={1}>{bar.label}</Txt>
              </View>
            );
            const spoken = [bar.label, bar.shown].filter(Boolean).join(', ');
            const press = bar.open ? () => onOpen(bar.open as Open) : bar.pick ? () => choose(block.param, bar.pick) : null;
            return press ? (
              <Pressable key={`${bar.label}-${i}`} style={({ pressed }) => [styles.slot, pressed && kit.dim]} accessibilityRole="button" accessibilityLabel={spoken} accessibilityState={{ selected: bar.on }}
                onPress={() => { tap(); press(); }}>{body}</Pressable>
            ) : <View key={`${bar.label}-${i}`} style={styles.slot} accessible accessibilityLabel={spoken}>{body}</View>;
          })}
        </View>
        {picked?.shown ? <Txt size={13} color={t.ink2}>{picked.label}: {picked.shown}</Txt> : null}
      </View>
    </View>
  );
}

/** One bar cut into shares, then a line per share with its colour, sum and per cent. */
function Split({ block, onOpen }: { block: Extract<Block, { kind: 'split' }>; onOpen: OnOpen }) {
  const { t } = useLook();
  const total = block.items.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <View style={styles.gap}>
      {block.title ? <Label>{block.title}</Label> : null}
      <View style={[styles.chart, { backgroundColor: t.card, borderRadius: t.r.card }]}>
        <View style={[styles.splitBar, { backgroundColor: t.control }]} accessible accessibilityLabel={block.items.map((x) => `${x.label} ${Math.round((x.value / total) * 100)}%`).join(', ')}>
          {block.items.map((x, i) => <View key={`${x.label}-${i}`} style={{ flex: x.value, backgroundColor: SHARES[i % SHARES.length] }} />)}
        </View>
        {block.items.map((x, i) => (
          <Tappable key={`${x.label}-${i}`} opened={x.open} onOpen={onOpen} label={[x.label, x.shown, `${Math.round((x.value / total) * 100)} per cent`].filter(Boolean).join('. ')} style={styles.share}>
            <View style={[styles.swatch, { backgroundColor: SHARES[i % SHARES.length] }]} />
            <Txt size={14} style={kit.flex} numberOfLines={1}>{x.label}</Txt>
            <Txt size={13} color={t.ink2}>{Math.round((x.value / total) * 100)}%</Txt>
            {x.shown ? <Txt size={14} weight={700} style={styles.shareSum}>{x.shown}</Txt> : null}
            {x.open ? <Icon name="chevron" size={14} color={t.ink3} /> : null}
          </Tappable>
        ))}
      </View>
    </View>
  );
}

/** A grid: the label column stays, the others scroll sideways. A row with `open` is a tap. */
function Table({ block, onOpen }: { block: Extract<Block, { kind: 'table' }>; onOpen: OnOpen }) {
  const { t } = useLook();
  const ink = useTone();
  const tap = useTap();
  const rule = { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth };
  return (
    <View style={styles.gap}>
      {block.title ? <Label>{block.title}</Label> : null}
      <View style={[styles.table, { backgroundColor: t.card, borderRadius: t.r.card }]}>
        <View style={styles.tableLabels}>
          <View style={[styles.cell, styles.labelCell, rule]}><Txt size={12} weight={600} color={t.ink3}> </Txt></View>
          {block.rows.map((row, i) => {
            const body = (
              <View style={[styles.cell, styles.labelCell, i < block.rows.length - 1 && rule, styles.labelRow]}>
                <Txt size={13} weight={600} color={row.tone ? ink(row.tone) : t.ink} numberOfLines={1} style={kit.flex}>{row.label}</Txt>
                {row.open ? <Icon name="chevron" size={12} color={t.ink3} /> : null}
              </View>
            );
            return row.open ? (
              <Pressable key={`${row.label}-${i}`} accessibilityRole="button" accessibilityLabel={`${row.label}. ${block.columns.map((c, k) => `${c} ${row.cells[k]}`).join(', ')}`}
                onPress={() => { tap(); onOpen(row.open as Open); }} style={({ pressed }) => pressed && kit.dim}>{body}</Pressable>
            ) : <View key={`${row.label}-${i}`} accessible accessibilityLabel={`${row.label}. ${block.columns.map((c, k) => `${c} ${row.cells[k]}`).join(', ')}`}>{body}</View>;
          })}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={kit.flex}>
          <View>
            <View style={[styles.tableRow, rule]}>
              {block.columns.map((c, k) => <View key={`${c}-${k}`} style={styles.cell}><Txt size={12} weight={600} color={t.ink3} numberOfLines={1}>{c}</Txt></View>)}
            </View>
            {block.rows.map((row, i) => (
              <View key={`${row.label}-${i}`} style={[styles.tableRow, i < block.rows.length - 1 && rule]} importantForAccessibility="no-hide-descendants">
                {row.cells.map((cell, k) => <View key={k} style={styles.cell}><Txt size={13} weight={row.tones[k] ? 700 : 400} color={row.tones[k] ? ink(row.tones[k]) : t.ink} numberOfLines={1}>{cell || '–'}</Txt></View>)}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

/** A search box: the words open the view again; the cross takes them away. */
function Search({ block, choose }: { block: Extract<Block, { kind: 'search' }>; choose: Choose }) {
  const { t } = useLook();
  const [words, setWords] = useState(block.value);
  // The view comes back after the search with the words it used: the box shows them.
  useEffect(() => setWords(block.value), [block.value]);
  return (
    <View style={styles.search}>
      <Field value={words} onChangeText={setWords} placeholder={block.placeholder || 'Search'} returnKeyType="search" autoCorrect={false} autoCapitalize="none"
        onSubmitEditing={() => choose(block.param, words.trim())} style={kit.flex} accessibilityLabel={block.placeholder || 'Search'} />
      {block.value || words ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => { setWords(''); choose(block.param, ''); }}
          style={({ pressed }) => [styles.clear, { backgroundColor: t.control, borderRadius: t.r.card }, pressed && kit.dim]}>
          <Txt size={14} weight={600} color={t.ink2}>Clear</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

function Actions({ items, connection, page, reload }: { items: Extract<Block, { kind: 'actions' }>['items']; connection: Connection; page: string; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState('');
  const run = async (item: (typeof items)[number]) => {
    setBusy(item.label);
    try {
      await ownCall(connection, `/own/${page}/api${item.call}`, 'POST', item.body);
      await reload();
      if (item.done) tell(item.label, item.done);
    } catch (err) {
      tell(`${item.label} did not work`, (err as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <View style={styles.actions}>
      {items.map((item) => <Button key={item.label} label={item.label} kind={item.kind} busy={busy === item.label} disabled={Boolean(busy) && busy !== item.label} onPress={() => run(item)} />)}
    </View>
  );
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useLook();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.gap}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={({ pressed }) => [styles.fold, { borderColor: t.line }, pressed && kit.dim]}>
        <Txt size={14} weight={600} color={t.accentText} style={kit.flex}>{title}</Txt>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron" size={16} color={t.accentText} /></View>
      </Pressable>
      {open ? <View style={styles.gap}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 8 },
  text: { paddingVertical: 2 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexBasis: '40%', flexGrow: 1, gap: 2, minWidth: 140, paddingHorizontal: 12, paddingVertical: 10 },
  tileHead: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  bar: { gap: 6, paddingHorizontal: 14, paddingVertical: 11 },
  barHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  track: { borderRadius: 4, height: 8, overflow: 'visible' },
  fill: { borderRadius: 4, height: 8 },
  mark: { height: 14, marginLeft: -1, position: 'absolute', top: -3, width: 2 },
  right: { marginLeft: 8 },
  listBox: { gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  listItem: { flexDirection: 'row', gap: 8 },
  chart: { gap: 8, padding: 12 },
  columns: { alignItems: 'stretch', flexDirection: 'row', gap: 4, height: 140 },
  column: { alignItems: 'center', flex: 1, gap: 4 },
  slot: { flex: 1 },
  columnSpace: { flex: 1, justifyContent: 'flex-end', width: '70%' },
  columnFill: { borderTopLeftRadius: 4, borderTopRightRadius: 4, width: '100%' },
  // The label under a column is about 19 px, so the line across sits in the space above it.
  markLayer: { bottom: 19, left: 0, position: 'absolute', right: 0, top: 0, zIndex: 1 },
  markLine: { borderStyle: 'dashed', borderWidth: 1, height: 0, left: 0, opacity: 0.7, position: 'absolute', right: 0 },
  splitBar: { borderRadius: 6, flexDirection: 'row', gap: 2, height: 16, overflow: 'hidden' },
  share: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 36 },
  swatch: { borderRadius: 3, height: 12, width: 12 },
  shareSum: { minWidth: 72, textAlign: 'right' },
  table: { flexDirection: 'row', overflow: 'hidden' },
  tableLabels: { width: 118 },
  // The same height as a label cell, its rule inside it, so the two columns never drift apart row by row.
  tableRow: { flexDirection: 'row', height: 40 },
  cell: { height: 40, justifyContent: 'center', paddingHorizontal: 8, width: 84 },
  labelCell: { paddingLeft: 12, width: 118 },
  labelRow: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  search: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  clear: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 14 },
  actions: { gap: 8 },
  fold: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44 },
});
