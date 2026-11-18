import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, NeedsYou, TrayItem, TrayQuestion, dropFromTray, getSummary, getTray, getTrayQuestions, holdInTray, sendTrayNow } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Icon } from '../ui/Icon';
import { Button, Field, GlassButton, Label, Title, Txt } from '../ui/kit';

/** How the tray says what it holds. */
export function trayWords(items: TrayItem[]) {
  const answers = items.filter((i) => i.kind !== 'review').length;
  const reviews = items.length - answers;
  return [answers ? `${answers} answer${answers === 1 ? '' : 's'}` : '', reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') + ' held';
}
const itemWords = (i: TrayItem) => (i.kind === 'review' ? `${i.review?.marks.length ?? 0} marks` : i.kind === 'accept' ? 'Yes' : i.kind === 'reject' ? (i.reason ? `No: ${i.reason}` : 'No') : i.said || 'Answered');

/** The answers held to send, with one press to send them all. Shown on Home above Needs you, and on the tray screen. */
export function TrayBar({ connection, items, onChange }: { connection: Connection; items: TrayItem[]; onChange: (items: TrayItem[], sent?: string) => void }) {
  const { t } = useLook();
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  const send = async () => {
    setBusy(true);
    try {
      const out = await sendTrayNow(connection);
      onChange(out.items, out.failed ? `${out.sent} sent; ${out.failed} did not go and stay in the tray` : `${out.sent} sent, each to the job that asked`);
    } catch (err) {
      onChange(items, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.tray, { backgroundColor: t.card, borderColor: t.ink, borderLeftColor: '#ffc61a' }]}>
      <Txt size={17} weight={700}>{trayWords(items)}</Txt>
      <Txt size={12} color={t.ink2}>The bots carry on meanwhile; each answer goes to the job that asked.</Txt>
      {items.map((i) => (
        <View key={i.key} style={[styles.held, { borderTopColor: t.line }]}>
          <View style={styles.flex}>
            <Txt size={14} weight={600} numberOfLines={1}>{i.job || i.title}</Txt>
            <Txt size={12} color={t.ink2} numberOfLines={2}>{i.kind === 'review' ? 'Review' : i.title}: {itemWords(i)}</Txt>
            {i.error ? <Txt size={12} color={t.bad}>Not sent: {i.error}</Txt> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Take ${i.title} out of the tray`} hitSlop={10}
            onPress={async () => onChange((await dropFromTray(connection, i.key)).items)}>
            <Icon name="close" size={18} color={t.ink2} />
          </Pressable>
        </View>
      ))}
      <Button label={items.length === 1 ? 'Send it' : `Send all ${items.length}`} icon="send" busy={busy} onPress={send} />
    </View>
  );
}

type Asked = { need: NeedsYou; jobId: string; job: string; questions: TrayQuestion[] };

function QuestionForm({ q, onHold }: { q: TrayQuestion; onHold: (kind: 'answer' | 'accept' | 'reject', extra: { answers?: { questionId: string; optionIds: string[]; otherText?: string }[]; said?: string; reason?: string }) => Promise<void> }) {
  const { t } = useLook();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (kind: 'answer' | 'accept' | 'reject', extra = {}) => { setBusy(kind); try { await onHold(kind, extra); } finally { setBusy(''); } };
  if (q.kind === 'confirm') {
    return (
      <View style={styles.gap}>
        <Txt size={15} weight={700}>{q.title}</Txt>
        {q.prompt ? <Txt size={14} color={t.ink2}>{q.prompt}</Txt> : null}
        <Field label={q.tripId ? 'What to change, if no (goes back with the work)' : 'Why, if no (optional)'} value={reason} onChangeText={setReason} multiline maxLength={4000} />
        <View style={styles.pair}>
          <View style={styles.flex}><Button label={`${q.accept}: hold`} busy={busy === 'accept'} onPress={() => run('accept')} /></View>
          <View style={styles.flex}><Button label={`${q.reject}: hold`} kind="quiet" busy={busy === 'reject'} onPress={() => run('reject', { reason: reason.trim() })} /></View>
        </View>
      </View>
    );
  }
  const answers = q.items.map((item) => ({ questionId: item.id, optionIds: other[item.id]?.trim() && !item.multiple ? [] : picked[item.id] || [], ...(other[item.id]?.trim() ? { otherText: other[item.id].trim() } : {}) }));
  const ready = q.items.every((item, i) => !(item.required || q.items.length === 1) || answers[i].optionIds.length || answers[i].otherText);
  const said = q.items.map((item, i) => [...item.options.filter((o) => answers[i].optionIds.includes(o.id)).map((o) => o.label), answers[i].otherText].filter(Boolean).join(', ')).filter(Boolean).join('; ');
  return (
    <View style={styles.gap}>
      <Txt size={15} weight={700}>{q.title}</Txt>
      {q.items.map((item) => (
        <View key={item.id} style={styles.gap}>
          {item.prompt && item.prompt !== q.title ? <Txt size={14} weight={600}>{item.prompt}</Txt> : null}
          {item.options.map((o) => {
            const on = (picked[item.id] || []).includes(o.id);
            return (
              <Pressable key={o.id} accessibilityRole={item.multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}
                onPress={() => setPicked((p) => ({ ...p, [item.id]: item.multiple ? (on ? (p[item.id] || []).filter((x) => x !== o.id) : [...(p[item.id] || []), o.id]) : [o.id] }))}
                style={[styles.option, { borderColor: on ? t.ink : t.line, backgroundColor: on ? 'rgba(255,198,26,0.22)' : t.control }]}>
                <Txt size={15} weight={600}>{o.label}</Txt>
                {o.hint ? <Txt size={12} color={t.ink2}>{o.hint}</Txt> : null}
              </Pressable>
            );
          })}
          <Field label={item.options.length ? 'Other' : 'Your answer'} value={other[item.id] || ''} onChangeText={(v) => setOther((o) => ({ ...o, [item.id]: v }))} multiline maxLength={8000} />
        </View>
      ))}
      <Button label="Hold this answer" busy={busy === 'answer'} disabled={!ready} onPress={() => run('answer', { answers, said })} />
    </View>
  );
}

/**
 * Every question waiting in Needs you, answered on one screen: each answer is held, and one press sends
 * them all, each to the job that asked. The same tray the PC map shows.
 */
export function TrayScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [asked, setAsked] = useState<Asked[] | null>(null);
  const [items, setItems] = useState<TrayItem[]>([]);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [summary, tray] = await Promise.all([getSummary(connection), getTray(connection)]);
      setItems(tray.items);
      const needs = summary.needsYou.filter((n) => n.kind === 'question' && !n.archived && (n.id || n.botId));
      const read = await Promise.all(needs.map(async (need) => {
        const out = await getTrayQuestions(connection, need.botId ? { bot: need.botId } : { job: need.id }).catch(() => null);
        return out ? { need, ...out } : null;
      }));
      setAsked(read.filter((a): a is Asked => Boolean(a && a.questions.length)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);
  useEffect(() => { load(); }, [load]);

  const heldKeys = new Set(items.map((i) => i.key));
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28 }]}>
        <GlassButton icon="back" label="Back" onPress={nav.back} />
        <Title>Answer several</Title>
        <Txt size={14} color={t.ink2}>Answer what waits, hold each answer, and send them all at once. The bots carry on meanwhile.</Txt>
        {said ? <Txt size={15} weight={600} color={t.good} accessibilityLiveRegion="polite">{said}</Txt> : null}
        {error ? <Txt color={t.bad} accessibilityLiveRegion="polite">{error}</Txt> : null}
        <TrayBar connection={connection} items={items} onChange={(next, words) => { setItems(next); if (words) { setSaid(words); load(); } }} />
        {!asked ? <ActivityIndicator color={t.accent} accessibilityLabel="Loading" /> : null}
        {asked && !asked.length ? <Txt color={t.ink2}>No question waits for you.</Txt> : null}
        {asked?.map((a) => (
          <View key={a.jobId} style={styles.gap}>
            <Label>{a.job}</Label>
            {a.questions.map((q) => (
              <View key={q.id} style={[styles.card, { backgroundColor: t.card, borderColor: t.ink }]}>
                {heldKeys.has(`card:${a.jobId}:${q.id}`) ? <Txt size={13} weight={700} color={t.good}>Answer held. Answer again to change it.</Txt> : null}
                <QuestionForm q={q} onHold={async (kind, extra) => {
                  try {
                    const out = await holdInTray(connection, { kind, jobId: a.jobId, cardId: q.id, title: q.title, job: a.job, ...(a.need.botId ? { botId: a.need.botId } : {}), ...(q.tripId ? { tripId: q.tripId } : {}), ...extra });
                    setItems(out.items);
                  } catch (err) { setError((err as Error).message); }
                }} />
                <Pressable accessibilityRole="button" onPress={() => nav.push({ name: 'review', job: a.jobId })}>
                  <Txt size={13} color={t.accentText}>Something to point at instead? Mark exact places</Txt>
                </Pressable>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  page: { gap: 10, paddingHorizontal: 16 },
  gap: { gap: 8 },
  pair: { flexDirection: 'row', gap: 8 },
  tray: { gap: 6, padding: 12, borderWidth: 2, borderLeftWidth: 8, borderRadius: 12 },
  held: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  card: { gap: 10, padding: 12, borderWidth: 2, borderRadius: 12 },
  option: { gap: 2, minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: 2, borderRadius: 10 },
});
