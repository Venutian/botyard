import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, SentReview, getReviews, proofSource } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { GlassButton, Title, Txt } from '../ui/kit';

const VERDICT: Record<string, string> = { back: 'Sent back', context: 'Sent back to run again', approve: 'Approved', note: 'Noted' };

function Cut({ connection, id }: { connection: Connection; id: string }) {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  useEffect(() => { proofSource(connection, id).then(setSource); }, [connection, id]);
  return source ? <Image source={source} style={styles.cut} resizeMode="contain" accessibilityLabel="A marked place, cut out" /> : null;
}

/** The kept record, read-only: every piece approved or sent back on a job or in a project, with its marks. */
export function ReviewsScreen({ job, project, title, connection, nav }: { job?: string; project?: string; title?: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [reviews, setReviews] = useState<(SentReview & { cuts?: string[] })[] | null>(null);
  const [open, setOpen] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { getReviews(connection, { job, project }).then((r) => setReviews(r.reviews)).catch((err: Error) => setError(err.message)); }, [connection, job, project]);
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Reviews kept</Title>
      <Txt size={14} color={t.ink2}>{title ? `${title}. ` : ''}Every piece approved or sent back, with its marks, as the bot was sent it.</Txt>
      {!reviews ? (error ? <Txt color={t.bad}>{error}</Txt> : <ActivityIndicator color={t.accent} accessibilityLabel="Loading" />) : null}
      {reviews && !reviews.length ? <Txt color={t.ink2}>Nothing kept yet.</Txt> : null}
      {reviews?.map((r) => {
        const shown = open === r.id;
        const n = r.marks?.length || 0;
        return (
          <View key={r.id} style={[styles.card, { backgroundColor: t.card, borderColor: t.ink }]}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: shown }} onPress={() => setOpen(shown ? '' : r.id)} style={styles.head}>
              <View style={[styles.tag, { borderColor: t.ink, backgroundColor: r.verdict === 'approve' ? '#35d07f' : '#ffc61a' }]}>
                <Txt size={11} weight={700} color="#15181d">{`${VERDICT[r.verdict] || r.verdict}${r.gate ? ' at a gate' : ''}`.toUpperCase()}</Txt>
              </View>
              <View style={styles.flex}>
                <Txt size={15} weight={600} numberOfLines={1}>{[r.jobRef, r.piece?.title].filter(Boolean).join(' · ')}</Txt>
                <Txt size={12} color={t.ink2}>{n} mark{n === 1 ? '' : 's'} · {new Date(r.createdAt).toLocaleString()}</Txt>
              </View>
            </Pressable>
            {shown ? (
              <View style={styles.body}>
                {r.cuts?.length ? <View style={styles.cuts}>{r.cuts.map((id) => <Cut key={id} connection={connection} id={id} />)}</View> : null}
                <Text selectable style={[styles.text, { color: t.ink }]}>{r.text}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { gap: 10, paddingHorizontal: 16 },
  card: { borderWidth: 2, borderRadius: 12, overflow: 'hidden' },
  head: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, padding: 12 },
  tag: { borderWidth: 2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  body: { gap: 8, paddingBottom: 12, paddingHorizontal: 12 },
  cuts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cut: { width: 150, height: 100, borderRadius: 6 },
  text: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
});
