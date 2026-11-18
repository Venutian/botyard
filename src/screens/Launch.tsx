/**
 * Launch (docs/launch.md): every product on every channel, as the PC page shows it. A product opens to its
 * channels (a channel that cannot be read can be told where it stands), its readiness list and its history.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Connection, getLaunch, launchAction, LaunchBoard, LaunchCell } from '../api';
import { Nav } from '../crew';
import { Theme, useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Button, Field, Group, Label, Txt } from '../ui/kit';
import { ago, Line, Page, Tag, useLoad } from '../ui/page';

const HOW: Record<string, string> = { read: 'read', told: 'told', none: 'not known' };
const MARK: Record<string, string> = { pass: 'Done', fail: 'Missing', unknown: 'Not known', yours: 'Yours' };
const toneOf = (c: LaunchCell, t: Theme) => (c.how === 'none' ? t.ink3 : c.tone === 'ok' ? t.good : c.tone === 'bad' ? t.bad : c.tone === 'look' ? t.warn : c.tone === 'go' ? t.accentText : t.ink2);
const when = (at?: number) => (at ? ago(at) : '');

export function LaunchScreen({ connection, nav, product }: { connection: Connection; nav: Nav; product?: string }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getLaunch(connection), [connection]);
  const [board, setBoard] = useState<LaunchBoard | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = board ?? data;

  const act = async (body: Parameters<typeof launchAction>[1]) => {
    setBusy(true);
    try {
      setBoard(await launchAction(connection, body));
    } catch (err) {
      tell('That did not work', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (product) return <ProductScreen board={shown} name={product} nav={nav} busy={busy} onTell={(channel, state) => act({ action: 'tell', product, channel, state })} onRefresh={load} error={error} />;

  return (
    <Page title="Launch" note="Every product on every store and channel" onBack={nav.back} onRefresh={load} error={error} loading={!shown}>
      {shown && !shown.planFound ? <Txt color={t.ink2}>{`No launch plan yet. Write one at ${shown.planFile}: each product and its ids on each channel.`}</Txt> : null}
      {shown?.planFound ? (
        <>
          <Txt size={14} color={t.ink2}>{`Each state is read from the channel itself, told by a person, or not known; nothing unread is shown as live. Checked ${when(shown.checkedAt) || 'never'}.`}</Txt>
          <Button label="Check now" kind="quiet" icon="reset" busy={busy} disabled={busy} onPress={() => act({ action: 'check' })} />
          {shown.rows.map((r) => (
            <View key={r.name} style={[styles.card, { backgroundColor: t.card, borderColor: t.line }]}>
              <Txt size={17} weight={700} onPress={() => nav.push({ name: 'launch', product: r.name })}>{r.name}</Txt>
              <Txt size={14} color={r.next?.waits === 'you' ? t.warn : t.ink2}>{r.next ? `Next: ${r.next.text}. Waits for ${r.next.waits}.` : 'Nothing waits'}</Txt>
              {shown.channels.filter((c) => r.cells[c.id]).map((c) => {
                const cell = r.cells[c.id] as LaunchCell;
                return (
                  <View key={c.id} style={styles.channel}>
                    <Txt size={13} color={t.ink3} style={styles.channelName}>{c.name}</Txt>
                    <Tag text={cell.state} color={toneOf(cell, t)} />
                  </View>
                );
              })}
              <Button label="Open" kind="quiet" icon="chevron" onPress={() => nav.push({ name: 'launch', product: r.name })} />
            </View>
          ))}
        </>
      ) : null}
    </Page>
  );
}

function ProductScreen({ board, name, nav, busy, onTell, onRefresh, error }: {
  board: LaunchBoard | null | undefined; name: string; nav: Nav; busy: boolean; onTell: (channel: string, state: string) => void; onRefresh: () => Promise<void>; error: string;
}) {
  const { t } = useLook();
  const [said, setSaid] = useState<Record<string, string>>({});
  const r = board?.rows.find((x) => x.name === name);
  return (
    <Page title={name} note="Its channels, readiness and history" onBack={nav.back} onRefresh={onRefresh} error={error} loading={!board}>
      {board && !r ? <Txt color={t.ink2}>That product is not in the launch plan.</Txt> : null}
      {r ? (
        <>
          {r.note ? <Txt size={14} color={t.ink2}>{r.note}</Txt> : null}
          <Txt size={14} color={r.next?.waits === 'you' ? t.warn : t.ink2}>{r.next ? `Next: ${r.next.text}. Waits for ${r.next.waits}.` : 'Nothing waits'}</Txt>
          <Label>Channels</Label>
          {board?.channels.filter((c) => r.cells[c.id]).map((c) => {
            const cell = r.cells[c.id] as LaunchCell;
            return (
              <View key={c.id} style={[styles.card, { backgroundColor: t.card, borderColor: t.line }]}>
                <View style={styles.channel}>
                  <Txt size={15} weight={700} style={styles.channelName}>{c.name}</Txt>
                  <Tag text={cell.state} color={toneOf(cell, t)} />
                </View>
                <Txt size={12} color={t.ink3}>{[HOW[cell.how], when(cell.checkedAt), cell.by ? `by ${cell.by}` : ''].filter(Boolean).join(', ')}</Txt>
                {cell.detail ? <Txt size={13} color={t.ink2}>{cell.detail}</Txt> : null}
                {cell.next ? <Txt size={13} color={t.ink2}>{`Next: ${cell.next}`}</Txt> : null}
                {cell.how !== 'read' ? (
                  <>
                    <Field label="Where it stands now" value={said[c.id] ?? ''} onChangeText={(v) => setSaid((s) => ({ ...s, [c.id]: v }))} maxLength={200} placeholder="Like: In QA since Monday" />
                    <Button label="Save" kind="quiet" busy={busy} disabled={busy || !(said[c.id] ?? '').trim()} onPress={() => { onTell(c.id, (said[c.id] ?? '').trim()); setSaid((s) => ({ ...s, [c.id]: '' })); }} />
                  </>
                ) : null}
              </View>
            );
          })}
          <Label>Ready for its next release</Label>
          <Group>
            {r.readiness.map((i, index) => (
              <Line key={`${i.group}-${i.text}`} title={i.text} detail={i.detail || undefined} note={i.group}
                right={<Tag text={MARK[i.state] ?? i.state} color={i.state === 'pass' ? t.good : i.state === 'fail' ? t.bad : i.state === 'yours' ? t.warn : t.ink3} />}
                last={index === r.readiness.length - 1} />
            ))}
          </Group>
          <Label>History</Label>
          {r.history.length ? (
            <Group>
              {r.history.map((h, index) => (
                <Line key={`${h.at}-${h.channel}-${index}`} title={`${board?.channels.find((c) => c.id === h.channel)?.name ?? h.channel}: ${h.to}`}
                  note={[when(h.at), h.from ? `was ${h.from}` : '', h.how === 'told' ? 'told' : ''].filter(Boolean).join(', ')} last={index === r.history.length - 1} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>Nothing has changed since the first check.</Txt>}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6, marginBottom: 10 },
  channel: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  channelName: { minWidth: 96 },
});
