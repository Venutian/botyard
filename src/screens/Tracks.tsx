/** Tracks: the requests moving along them (what waits for you first, with what each cost), and each saved track drawn. Read-only drawings; a trip opens to act on it. */
import { View, StyleSheet } from 'react-native';
import { Connection, getTracks } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { Group, Label, Txt } from '../ui/kit';
import { ago, Line, Page, Tag, useLoad } from '../ui/page';
import { TrackDrawing } from '../ui/track';

export function TracksScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getTracks(connection), [connection]);
  const requests = data ? [...data.requests].sort((a, b) => Number(b.waitsForOwner) - Number(a.waitsForOwner)) : [];
  const waiting = requests.filter((r) => r.waitsForOwner).length;
  const tone = (r: (typeof requests)[number]) => (r.waitsForOwner ? t.warn : r.tripStatus === 'stuck' ? t.bad : r.status === 'done' ? t.good : t.ink3);
  return (
    <Page title="Tracks" note={waiting ? `${waiting} wait${waiting === 1 ? 's' : ''} for you` : 'How each request moves, step by step'} onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {data ? (
        <>
          <Txt size={14} color={t.ink2}>A request moves along its track; a failed check goes back with its findings; it is finished only when its change is in main.</Txt>
          <Label>Requests</Label>
          {requests.length ? (
            <Group>
              {requests.map((r, index) => (
                <Line key={r.id} title={`${r.job} ${r.title}`} detail={r.tripStatus === 'stuck' ? r.reason : r.status === 'working' ? r.at : undefined} tone={r.tripStatus === 'stuck' ? t.bad : undefined}
                  note={[r.track, r.cost, ago(r.updatedAt)].filter(Boolean).join(', ')}
                  right={<Tag text={r.waitsForOwner ? 'Waits for you' : r.state} color={tone(r)} />}
                  onPress={r.tripId ? () => nav.push({ name: 'trip', id: r.tripId }) : undefined} last={index === requests.length - 1} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>No request has moved along a track yet.</Txt>}
          <Label>Tracks</Label>
          <Txt size={13} color={t.ink3}>Read-only for now: a track is saved through the engine.</Txt>
          {data.tracks.map((track) => (
            <View key={track.id} style={[styles.card, { backgroundColor: t.card, borderColor: t.line }]}>
              <Txt size={16} weight={700}>{track.title}</Txt>
              <Txt size={13} color={t.ink3}>{`${track.key} · version ${track.version}${track.builtIn ? ' · built in' : ''} · ${track.delivers === 'nothing' ? 'delivers no change' : 'finished when in main'}`}</Txt>
              {track.description ? <Txt size={14} color={t.ink2}>{track.description}</Txt> : null}
              <TrackDrawing steps={track.steps} lines={track.lines} title={track.title} />
            </View>
          ))}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6, marginBottom: 10 },
});
