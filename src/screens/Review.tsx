import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, DraftMark, ReviewSources, getReviewSources, holdInTray, proofSource, sendReview } from '../api';
import { Nav } from '../crew';
import { boxOf, linesOf, quoteOf, reviewOf, whereOf } from '../marks';
import { alpha } from '../theme/color';
import { useLook } from '../theme/prefs';
import { Icon } from '../ui/Icon';
import { DESCRIBE } from '../ui/describe';
import { Button, Chips, Field, GlassButton, Label, plainField, Title, Txt } from '../ui/kit';

type Box = { x: number; y: number; w: number; h: number };
type Pending = { kind: 'text'; quote: string; line: number; lineEnd: number } | { kind: 'picture'; box: Box };

/** A picture to mark: a tap is a point, a drag is a box. Marks already made show as numbered spots. */
function PictureMarker({ connection, attachmentId, marks, pending, onMark }: {
  connection: Connection; attachmentId: string; marks: DraftMark[]; pending: Box | null; onMark: (box: Box) => void;
}) {
  const { t } = useLook();
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [drag, setDrag] = useState<Box | null>(null);
  const start = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let live = true;
    proofSource(connection, attachmentId).then((s) => {
      if (!live || !s) return;
      setSource(s);
      const told = (w: number, h: number) => { if (live && w && h) setRatio(w / h); };
      if ('headers' in s && s.headers) Image.getSizeWithHeaders(s.uri, s.headers, told, () => undefined);
      else Image.getSize(s.uri, told, () => undefined);
    });
    return () => { live = false; };
  }, [connection, attachmentId]);

  const spot = (box: Box, label: string, key: string, dashed = false) => {
    const point = !(box.w || box.h);
    return point ? (
      <View key={key} pointerEvents="none" style={[styles.point, { left: box.x * size.width - 10, top: box.y * size.height - 10, backgroundColor: dashed ? t.card : '#ffc61a', borderColor: t.ink }]}>
        {label ? <Txt size={11} weight={700} color="#15181d">{label}</Txt> : null}
      </View>
    ) : (
      <View key={key} pointerEvents="none" style={[styles.box, { left: box.x * size.width, top: box.y * size.height, width: box.w * size.width, height: box.h * size.height, borderColor: '#ffc61a', borderStyle: dashed ? 'dashed' : 'solid', backgroundColor: alpha('#ffc61a', 0.16) }]}>
        {label ? <View style={[styles.boxTag, { borderColor: t.ink }]}><Txt size={11} weight={700} color="#15181d">{label}</Txt></View> : null}
      </View>
    );
  };

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="The picture. Tap a point or drag a box to mark it."
      onLayout={(e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => { start.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }; setDrag(null); }}
      onResponderMove={(e) => setDrag(boxOf(start.current, { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }, size))}
      onResponderRelease={(e) => { setDrag(null); onMark(boxOf(start.current, { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }, size)); }}
      style={[styles.stage, { aspectRatio: ratio, borderColor: t.ink, backgroundColor: t.control }]}
    >
      {source ? <Image source={source} style={StyleSheet.absoluteFill} resizeMode="contain" /> : <ActivityIndicator color={t.accent} style={styles.center} />}
      {marks.map((m) => (m.kind === 'picture' ? spot(m.box, String(m.n), `m${m.n}`) : null))}
      {pending ? spot(pending, '', 'pending', true) : null}
      {drag ? spot(drag, '', 'drag', true) : null}
    </View>
  );
}

/**
 * Review a bot's work on the phone: pick the piece (its last message first), select words or tap and
 * drag on a picture, say what to change, and send every mark as one message.
 */
export function ReviewScreen({ job, bot, connection, nav }: { job?: string; bot?: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [src, setSrc] = useState<ReviewSources | null>(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState('');
  const [marks, setMarks] = useState<DraftMark[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [pending, setPending] = useState<Pending | null>(null);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [gateTo, setGateTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState('');
  const next = useRef(1);

  useEffect(() => {
    getReviewSources(connection, { job, bot }).then((all) => {
      // The change in chapters and live pages are read on the PC page first.
      const s = { ...all, pieces: all.pieces.filter((p) => p.kind !== 'change' && p.kind !== 'page') };
      setSrc(s);
      setCurrent(s.pieces[0]?.id || '');
      setGateTo(s.gate?.before.at(-1)?.id || '');
    }).catch((err: Error) => setError(err.message));
  }, [connection, job, bot]);

  const piece = useMemo(() => src?.pieces.find((p) => p.id === current) || null, [src, current]);
  const text = piece?.text || '';
  const picked = quoteOf(text, selection.start, selection.end);

  const markWords = () => {
    if (!picked) return;
    setPending({ kind: 'text', quote: picked, ...linesOf(text, selection.start, selection.end) });
    setComment('');
  };
  const add = () => {
    if (!pending || !comment.trim() || !piece) return;
    const n = next.current++;
    setMarks((all) => [...all, pending.kind === 'text'
      ? { n, kind: 'text', pieceId: piece.id, quote: pending.quote, line: pending.line, lineEnd: pending.lineEnd, comment: comment.trim() }
      : { n, kind: 'picture', pieceId: piece.id, box: pending.box, comment: comment.trim() }]);
    setPending(null);
    setComment('');
    setSelection({ start: 0, end: 0 });
  };
  const send = async (verdict: 'back' | 'approve') => {
    if (!src) return;
    setBusy(true);
    setError('');
    try {
      const review = await sendReview(connection, reviewOf(src, marks, note, verdict, current, gateTo));
      setMarks([]);
      setNote('');
      setSent(verdict === 'approve' ? 'Approved and kept.' : `Sent: ${review.marks.length} mark${review.marks.length === 1 ? '' : 's'} in one message.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const counts = new Map<string, number>();
  for (const m of marks) counts.set(m.pieceId, (counts.get(m.pieceId) || 0) + 1);

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28 }]}>
        <GlassButton icon="back" label="Back" onPress={nav.back} />
        <Title>Review</Title>
        {!src ? (error ? <Txt color={t.bad} accessibilityLiveRegion="polite">{error}</Txt> : <ActivityIndicator color={t.accent} accessibilityLabel="Loading" />) : (
          <>
            <Txt size={14} color={t.ink2}>
              {[src.ref, src.chat ? `Chat with ${src.bot}` : src.title].filter(Boolean).join(' ')}
              {src.gate ? `. Waiting at "${src.gate.title}": your marks are the answer.` : src.bot ? `. Marks go to ${src.bot} as one message.` : ''}
            </Txt>
            {sent ? <Txt size={15} weight={600} color={t.good} accessibilityLiveRegion="polite">{sent}</Txt> : null}
            {src.pieces.length ? (
              <Chips
                value={current}
                options={src.pieces.map((p) => ({ id: p.id, name: `${p.title.length > 34 ? `${p.title.slice(0, 33)}…` : p.title}${counts.get(p.id) ? ` · ${counts.get(p.id)}` : ''}` }))}
                onChange={(id) => { setCurrent(id); setPending(null); setSelection({ start: 0, end: 0 }); }}
              />
            ) : <Txt color={t.ink2}>Nothing to review on this job yet.</Txt>}

            {piece?.kind === 'picture' ? (
              <>
                <Txt size={13} color={t.ink2}>Tap a point or drag a box on the picture, then say what to change there.</Txt>
                <PictureMarker connection={connection} attachmentId={piece.ref} marks={marks.filter((m) => m.pieceId === piece.id)}
                  pending={pending?.kind === 'picture' ? pending.box : null}
                  onMark={(box) => { setPending({ kind: 'picture', box }); setComment(''); }} />
              </>
            ) : piece ? (
              <>
                <Txt size={13} color={t.ink2}>Hold on a word, drag the handles over what to mark, then press Mark these words.</Txt>
                <View style={[styles.reader, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth }]}>
                  <TextInput
                    value={text}
                    onChangeText={() => undefined}
                    multiline
                    scrollEnabled={false}
                    showSoftInputOnFocus={false}
                    caretHidden
                    contextMenuHidden
                    selectionColor={alpha('#ffc61a', 0.6)}
                    onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                    accessibilityLabel={`${piece.title}. Select words to mark them.`}
                    style={[styles.text, plainField, { color: t.ink }]}
                  />
                </View>
                {marks.filter((m) => m.pieceId === piece.id && m.kind === 'text').length ? (
                  <Txt size={12} color={t.ink3}>Marked here: {marks.filter((m) => m.pieceId === piece.id).map((m) => `${m.n} (${whereOf(m)})`).join(', ')}</Txt>
                ) : null}
                <Button label={picked ? `Mark these words: “${picked.length > 30 ? `${picked.slice(0, 29)}…` : picked}”` : 'Select words to mark them'} kind="quiet" icon="pin" disabled={!picked} onPress={markWords} />
              </>
            ) : null}

            {pending ? (
              <View style={[styles.ask, { backgroundColor: t.raised, borderColor: t.ink }]}>
                <Txt size={14} weight={700}>Mark {next.current}: {pending.kind === 'text' ? (pending.lineEnd !== pending.line ? `lines ${pending.line}–${pending.lineEnd}` : `line ${pending.line}`) : pending.box.w || pending.box.h ? 'a box on the picture' : 'a point on the picture'}</Txt>
                {pending.kind === 'text' ? <View style={[styles.quote, { borderLeftColor: '#ffc61a', backgroundColor: t.control }]}><Txt size={13}>{pending.quote.length > 200 ? `${pending.quote.slice(0, 199)}…` : pending.quote}</Txt></View> : null}
                <Field label="What should change here?" value={comment} onChangeText={setComment} multiline autoFocus maxLength={2000} placeholder="Say what is wrong and what you want instead" />
                <View style={styles.pair}>
                  <View style={styles.flex}><Button label="Cancel" kind="quiet" onPress={() => setPending(null)} /></View>
                  <View style={styles.flex}><Button label="Add mark" onPress={add} disabled={!comment.trim()} /></View>
                </View>
              </View>
            ) : null}

            <Label>Your marks · {marks.length}</Label>
            {marks.length ? marks.map((m) => (
              <View key={m.n} style={[styles.mark, { backgroundColor: t.card, borderColor: t.ink, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth }]}>
                <View style={styles.markHead}>
                  <View style={[styles.num, { borderColor: t.ink }]}><Txt size={12} weight={700} color="#15181d">{m.n}</Txt></View>
                  <Txt size={13} color={t.ink2} style={styles.flex} numberOfLines={1}>{whereOf(m)} · {src.pieces.find((p) => p.id === m.pieceId)?.title}</Txt>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove mark ${m.n}`} accessibilityHint={DESCRIBE.icon.removeMark} hitSlop={10} onPress={() => setMarks((all) => all.filter((x) => x.n !== m.n))}>
                    <Icon name="close" size={18} color={t.ink2} />
                  </Pressable>
                </View>
                {m.kind === 'text' ? <Txt size={13} color={t.ink2} numberOfLines={3}>“{m.quote}”</Txt> : null}
                <Txt size={15}>{m.comment}</Txt>
              </View>
            )) : <Txt size={13} color={t.ink2}>No marks yet.</Txt>}
            <Field label="Anything else" value={note} onChangeText={setNote} multiline maxLength={4000} placeholder="A word about the whole piece (optional)" />
            {src.gate && src.gate.before.length > 1 ? (
              <>
                <Label>Send the work back to</Label>
                <Chips value={gateTo} options={src.gate.before.map((s) => ({ id: s.id, name: s.title }))} onChange={setGateTo} />
              </>
            ) : null}
            {error ? <Txt color={t.bad} accessibilityLiveRegion="polite">{error}</Txt> : null}
            <Button label={src.gate ? 'Send back with marks' : `Send to ${src.bot || 'the bot'}`} icon="send" hint={src.gate ? DESCRIBE.act['Send back with marks'] : DESCRIBE.act['Send marks to the bot']} busy={busy} disabled={!marks.length && !note.trim()} onPress={() => send('back')} />
            <Button label={src.gate ? 'Approve' : 'Approve and keep'} kind="quiet" icon="check" hint={src.gate ? DESCRIBE.act.Approve : DESCRIBE.act['Approve and keep']} busy={busy} onPress={() => send('approve')} />
            {src.gate ? null : (
              <Button label="Hold in the tray, send with my other answers" kind="quiet" icon="save" hint={DESCRIBE.act['Hold in the tray']} busy={busy} disabled={!marks.length && !note.trim()} onPress={async () => {
                setBusy(true);
                try {
                  await holdInTray(connection, { kind: 'review', jobId: src.jobId, title: 'Your review', job: `${src.ref} ${src.title}`.trim(), review: reviewOf(src, marks, note, 'back', current) });
                  setMarks([]);
                  setNote('');
                  setSent('Held in the tray in Needs you.');
                } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
              }} />
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  page: { gap: 10, paddingHorizontal: 16 },
  center: { flex: 1 },
  reader: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  text: { fontSize: 16, lineHeight: 24, padding: 0, textAlignVertical: 'top' },
  stage: { width: '100%', borderRadius: 10, borderWidth: 2, overflow: 'hidden' },
  point: { position: 'absolute', width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  box: { position: 'absolute', borderWidth: 3, borderRadius: 3 },
  boxTag: { position: 'absolute', left: -10, top: -10, minWidth: 20, height: 20, paddingHorizontal: 4, borderRadius: 10, borderWidth: 2, backgroundColor: '#ffc61a', alignItems: 'center', justifyContent: 'center' },
  ask: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 2 },
  quote: { borderLeftWidth: 4, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  pair: { flexDirection: 'row', gap: 8 },
  mark: { gap: 4, padding: 10, borderRadius: 12 },
  markHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  num: { minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 11, borderWidth: 2, backgroundColor: '#ffc61a', alignItems: 'center', justifyContent: 'center' },
});
