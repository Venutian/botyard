import { ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Connection, getOwnView, ownCall } from '../api';
import { Nav } from '../crew';
import { Block, Tone } from '../ownView';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Icon } from '../ui/Icon';
import { Button, Chips, Group, Label, styles as kit, Txt, useTap } from '../ui/kit';
import { Markdown } from '../ui/Markdown';
import { Line, Page, useLoad } from '../ui/page';

/**
 * A page of the owner's own, on the phone: the view its server file sends (src/ownView.ts), drawn with the
 * app's own parts. The page's code never runs here. A chip or a bar opens the view again with that choice;
 * a button calls the page's own server and reads the view again.
 */
export function OwnPageScreen({ connection, nav, page, title }: { connection: Connection; nav: Nav; page: string; title: string }) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const { data, error, load } = useLoad(() => getOwnView(connection, page, choices), [connection, page, choices]);
  const choose = (param: string, value: string) => setChoices((now) => ({ ...now, [param]: value }));
  const { t } = useLook();
  const empty = data && !data.blocks.length;
  return (
    <Page title={data?.title || title} note={data?.note} onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {empty ? <Txt color={t.ink2}>This page sent nothing to show on a phone.</Txt> : null}
      {data?.blocks.map((block, i) => <BlockView key={`${block.kind}-${i}`} block={block} choose={choose} connection={connection} page={page} reload={load} />)}
    </Page>
  );
}

function useTone() {
  const { t } = useLook();
  return (tone: Tone, fallback = t.ink) => (tone === 'good' ? t.good : tone === 'bad' ? t.bad : tone === 'warn' ? t.warn : fallback);
}

function BlockView({ block, choose, connection, page, reload }: { block: Block; choose: (param: string, value: string) => void; connection: Connection; page: string; reload: () => Promise<void> }) {
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
            <View key={tile.label} style={[styles.tile, { backgroundColor: t.card, borderRadius: t.r.card, borderColor: t.outline ? t.ink : t.line, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth }]}
              accessible accessibilityLabel={[tile.label, tile.value, tile.note].filter(Boolean).join('. ')}>
              <Txt size={12} weight={600} color={t.ink2} numberOfLines={2}>{tile.label}</Txt>
              <Txt size={tile.value.length > 11 ? 16 : 20} weight={700} color={ink(tile.tone)} numberOfLines={2}>{tile.value}</Txt>
              {tile.note ? <Txt size={12} color={t.ink3} numberOfLines={2}>{tile.note}</Txt> : null}
            </View>
          ))}
        </View>
      );
    case 'chart':
      return <Chart block={block} choose={choose} />;
    case 'bars': {
      const top = Math.max(1, ...block.items.map((b) => Math.max(b.value, b.mark ?? 0)));
      return (
        <View style={styles.gap}>
          {block.title ? <Label>{block.title}</Label> : null}
          <Group>
            {block.items.map((bar, i) => (
              <View key={`${bar.label}-${i}`} style={[styles.bar, i < block.items.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}
                accessible accessibilityLabel={[bar.label, bar.shown, bar.note].filter(Boolean).join('. ')}>
                <View style={styles.barHead}>
                  <Txt size={14} weight={600} style={kit.flex} numberOfLines={1}>{bar.label}</Txt>
                  <Txt size={14} weight={700} color={ink(bar.tone)}>{bar.shown}</Txt>
                </View>
                <View style={[styles.track, { backgroundColor: t.control }]}>
                  <View style={[styles.fill, { width: `${(bar.value / top) * 100}%`, backgroundColor: ink(bar.tone, t.accent) }]} />
                  {bar.mark !== null ? <View style={[styles.mark, { left: `${(bar.mark / top) * 100}%`, backgroundColor: t.ink }]} /> : null}
                </View>
                {bar.note ? <Txt size={12} color={t.ink3}>{bar.note}</Txt> : null}
              </View>
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
                right={row.right ? <Txt size={14} weight={700} style={styles.right}>{row.right}</Txt> : undefined} />
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
    case 'choose':
      return <Chips value={block.value} options={block.options} onChange={(id) => choose(block.param, id)} />;
    case 'actions':
      return <Actions items={block.items} connection={connection} page={page} reload={reload} />;
    case 'fold':
      return <Fold title={block.title}>{block.blocks.map((inner, i) => <BlockView key={`${inner.kind}-${i}`} block={inner} choose={choose} connection={connection} page={page} reload={reload} />)}</Fold>;
  }
}

/** Bars up from a line, one per label; the chosen one in full paint, a tap on another opens it. */
function Chart({ block, choose }: { block: Extract<Block, { kind: 'chart' }>; choose: (param: string, value: string) => void }) {
  const { t } = useLook();
  const tap = useTap();
  const top = Math.max(1, ...block.items.map((b) => b.value));
  const picked = block.items.find((b) => b.on);
  return (
    <View style={styles.gap}>
      {block.title ? <Label>{block.title}</Label> : null}
      <View style={[styles.chart, { backgroundColor: t.card, borderRadius: t.r.card }]}>
        <View style={styles.columns}>
          {block.items.map((bar, i) => {
            const body = (
              <View style={styles.column}>
                <View style={styles.columnSpace}>
                  <View style={[styles.columnFill, { height: `${Math.max(2, (bar.value / top) * 100)}%`, backgroundColor: bar.on ? t.accent : t.edge, opacity: bar.on || !picked ? 1 : 0.55 }]} />
                </View>
                <Txt size={11} weight={bar.on ? 700 : 400} color={bar.on ? t.ink : t.ink2} numberOfLines={1}>{bar.label}</Txt>
              </View>
            );
            const spoken = [bar.label, bar.shown].filter(Boolean).join(', ');
            return bar.pick ? (
              <Pressable key={`${bar.label}-${i}`} style={({ pressed }) => [styles.slot, pressed && kit.dim]} accessibilityRole="button" accessibilityLabel={spoken} accessibilityState={{ selected: bar.on }}
                onPress={() => { tap(); choose(block.param, bar.pick); }}>{body}</Pressable>
            ) : <View key={`${bar.label}-${i}`} style={styles.slot} accessible accessibilityLabel={spoken}>{body}</View>;
          })}
        </View>
        {picked?.shown ? <Txt size={13} color={t.ink2}>{picked.label}: {picked.shown}</Txt> : null}
      </View>
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
  actions: { gap: 8 },
  fold: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44 },
});
