import { useEffect, useState } from 'react';
import { Image, ImageSourcePropType, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Connection, Proof, proofSource } from '../api';
import { useLook } from '../theme/prefs';
import { Txt } from './kit';

function useProof(connection: Connection, id: string) {
  const [source, setSource] = useState<ImageSourcePropType | null>(null);
  useEffect(() => {
    let current = true;
    proofSource(connection, id).then((found) => current && setSource(found)).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, id]);
  return source;
}

function Shot({ connection, proof, onOpen }: { connection: Connection; proof: Proof; onOpen: (source: ImageSourcePropType, name: string) => void }) {
  const { t } = useLook();
  const source = useProof(connection, proof.id);
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${proof.name}`} disabled={!source} onPress={() => source && onOpen(source, proof.name)} style={[styles.shot, { backgroundColor: t.card, borderColor: t.outline ? t.ink : 'transparent', borderWidth: t.outline ? 2 : 0 }]}>
      {source ? <Image source={source} style={styles.fill} resizeMode="cover" /> : null}
    </Pressable>
  );
}

/** Screenshots on a job. Tapping one fills the screen, and tapping again closes it. */
export function ProofRow({ connection, proof }: { connection: Connection; proof: Proof[] }) {
  const [open, setOpen] = useState<{ source: ImageSourcePropType; name: string } | null>(null);
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {proof.map((item) => <Shot key={item.id} connection={connection} proof={item} onOpen={(source, name) => setOpen({ source, name })} />)}
      </ScrollView>
      <Modal visible={Boolean(open)} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setOpen(null)} style={styles.viewer}>
          {open ? <Image source={open.source} style={styles.fill} resizeMode="contain" /> : null}
          <View style={styles.caption}><Txt size={13} color="#ffffff">{open?.name}</Txt></View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { height: '100%', width: '100%' },
  row: { gap: 8 },
  shot: { borderRadius: 14, height: 120, overflow: 'hidden', width: 214 },
  viewer: { backgroundColor: 'rgba(0,0,0,0.94)', flex: 1, padding: 12 },
  caption: { alignItems: 'center', bottom: 30, left: 0, position: 'absolute', right: 0 },
});
