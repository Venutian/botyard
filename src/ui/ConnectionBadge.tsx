import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Connection, currentRoute, Way, wayLabel } from '../api';
import { useLook } from '../theme/prefs';
import { Txt } from './kit';

const POLL_MS = 15_000;

/** Says plainly which way the app is reaching the studio, or why it cannot. */
export function ConnectionBadge({ connection }: { connection: Connection }) {
  const { t } = useLook();
  const [way, setWay] = useState<Way | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let live = true;
    // Each poll knocks again, so the badge says the truth as soon as the link goes rather than a
    // minute later.
    const ask = () => currentRoute(connection, { fresh: true }).then(
      (name) => {
        if (!live) return;
        setWay(name);
        setReason('');
      },
      (err) => {
        if (!live) return;
        setWay(null);
        setReason((err as Error).message || 'Cannot reach the studio');
      },
    );
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connection]);

  // Without a way to say which one it is, the badge stays hidden rather than guessing.
  if (!way && !reason) return null;
  const text = way ? `Connected over ${wayLabel(way)}` : reason;
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: way ? t.good : t.bad }]} />
      <Txt size={13} color={way ? t.ink3 : t.bad}>{text}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  dot: { borderRadius: 4, height: 8, width: 8 },
});
