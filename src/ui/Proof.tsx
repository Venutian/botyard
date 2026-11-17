import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageSourcePropType, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ChatPicture, Connection, Proof, proofSource } from '../api';
import { useLook } from '../theme/prefs';
import { Icon } from './Icon';
import { Txt } from './kit';

function useProof(connection: Connection, id: string) {
  const [source, setSource] = useState<ImageSourcePropType | null>(null);
  useEffect(() => {
    if (!id) return;
    let current = true;
    proofSource(connection, id).then((found) => current && setSource(found)).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, id]);
  return source;
}

/** A picture's source once it has loaded, and whether it will not come, for a tile that says so. */
function useProofState(connection: Connection, id: string) {
  const [source, setSource] = useState<ImageSourcePropType | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    proofSource(connection, id).then((found) => {
      if (!current) return;
      if (found) setSource(found);
      else setFailed(true);
    }).catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [connection, id]);
  return { source, failed, setFailed };
}

function Shot({ connection, proof, onOpen }: { connection: Connection; proof: Proof; onOpen: (source: ImageSourcePropType, name: string) => void }) {
  const { t } = useLook();
  const { source, failed, setFailed } = useProofState(connection, proof.id);
  const spoken = failed ? `${proof.name}, did not load` : source ? `Open ${proof.name}` : `${proof.name}, loading`;
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={spoken} accessibilityState={{ disabled: !source || failed, busy: !source && !failed }} disabled={!source || failed} onPress={() => source && onOpen(source, proof.name)}
      style={[styles.shot, { backgroundColor: t.card, borderColor: t.line, borderWidth: StyleSheet.hairlineWidth }]}>
      {source && !failed ? <Image source={source} style={styles.fill} resizeMode="cover" onError={() => setFailed(true)} /> : (
        // While it loads, and when it will not, the tile says so instead of standing empty.
        <View style={styles.empty}>
          {failed ? <Icon name="image" size={22} color={t.ink3} /> : <ActivityIndicator color={t.ink3} />}
          <Txt size={12} color={t.ink2} numberOfLines={2} style={styles.emptyText}>{failed ? 'Did not load' : proof.name}</Txt>
        </View>
      )}
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
      <Viewer open={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** The full-size view: tap anywhere to close; Back closes it too. */
function Viewer({ open, onClose }: { open: { source: ImageSourcePropType; name: string } | null; onClose: () => void }) {
  return (
    <Modal visible={Boolean(open)} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close the picture" onPress={onClose} style={styles.viewer}>
        {open ? <Image source={open.source} style={styles.fill} resizeMode="contain" accessibilityLabel={open.name} /> : null}
        <View style={styles.caption}><Txt size={13} color="#ffffff">{open?.name}</Txt></View>
      </Pressable>
    </Modal>
  );
}

function ChatShot({ connection, picture, big, onOpen }: { connection: Connection; picture: ChatPicture; big: boolean; onOpen: (source: ImageSourcePropType, name: string) => void }) {
  const { t } = useLook();
  const remote = useProof(connection, picture.uri ? '' : picture.id);
  const source = picture.uri ? { uri: picture.uri } : remote;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${picture.name} full size`}
      disabled={!source}
      onPress={() => source && onOpen(source, picture.name)}
      style={[big ? styles.chatBig : styles.chatSmall, { backgroundColor: t.card, borderColor: t.outline ? t.ink : t.line, borderWidth: t.outline ? 2 : 1 }]}
    >
      {source ? <Image source={source} style={styles.fill} resizeMode="cover" /> : null}
    </Pressable>
  );
}

/** A chat message's pictures, small and on the speaker's side; one tap shows a picture full size. */
export function ChatPictures({ connection, pictures, mine }: { connection: Connection; pictures: ChatPicture[]; mine: boolean }) {
  const [open, setOpen] = useState<{ source: ImageSourcePropType; name: string } | null>(null);
  if (!pictures.length) return null;
  return (
    <>
      <View style={[styles.chatRow, mine ? styles.chatMine : styles.chatBot]}>
        {pictures.map((picture) => <ChatShot key={picture.id} connection={connection} picture={picture} big={pictures.length === 1} onOpen={(source, name) => setOpen({ source, name })} />)}
      </View>
      <Viewer open={open} onClose={() => setOpen(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  chatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, maxWidth: '86%' },
  chatMine: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
  chatBot: { alignSelf: 'flex-start', marginLeft: 36 },
  chatSmall: { borderRadius: 12, height: 96, overflow: 'hidden', width: 128 },
  chatBig: { borderRadius: 14, height: 160, overflow: 'hidden', width: 220 },
  fill: { height: '100%', width: '100%' },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 12 },
  emptyText: { textAlign: 'center' },
  row: { gap: 8 },
  shot: { borderRadius: 14, height: 120, overflow: 'hidden', width: 214 },
  viewer: { backgroundColor: 'rgba(0,0,0,0.94)', flex: 1, padding: 12 },
  caption: { alignItems: 'center', bottom: 30, left: 0, position: 'absolute', right: 0 },
});
