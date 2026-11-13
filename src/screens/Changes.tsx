import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChangeFile, Changes, Connection, getChanges } from '../api';
import { Nav } from '../crew';
import { alpha } from '../theme/color';
import { useLook } from '../theme/prefs';
import { Icon } from '../ui/Icon';
import { GlassButton, Group, Label, Title, Txt } from '../ui/kit';

const SHOWN_LINES = 500;

function Patch({ patch }: { patch: string }) {
  const { t } = useLook();
  const lines = patch.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, SHOWN_LINES);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.patch}>
        {shown.map((line, index) => {
          const added = line.startsWith('+');
          const removed = line.startsWith('-');
          const marker = line.startsWith('@@');
          return (
            <Text
              key={index}
              selectable
              style={[
                styles.code,
                { color: marker ? t.accentText : t.ink },
                added && { backgroundColor: alpha(t.good.slice(0, 7), 0.16) },
                removed && { backgroundColor: alpha(t.bad.slice(0, 7), 0.16) },
              ]}
            >
              {line || ' '}
            </Text>
          );
        })}
        {lines.length > SHOWN_LINES ? <Txt size={12} color={t.ink3}>{lines.length - SHOWN_LINES} more lines not shown.</Txt> : null}
      </View>
    </ScrollView>
  );
}

function FileRow({ file, last }: { file: ChangeFile; last: boolean }) {
  const { t } = useLook();
  const [open, setOpen] = useState(false);
  const name = file.path.split('/').pop();
  const folder = file.path.slice(0, -(name?.length ?? 0));
  return (
    <View style={!last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} disabled={file.binary} onPress={() => setOpen(!open)} style={styles.file}>
        <View style={styles.flex}>
          <Txt size={15} weight={600} numberOfLines={1}>{name}</Txt>
          {folder ? <Txt size={12} color={t.ink3} numberOfLines={1}>{folder}</Txt> : null}
        </View>
        {file.binary ? <Txt size={13} color={t.ink3}>Binary file</Txt> : (
          <Txt size={13}>
            <Txt size={13} color={t.good}>+{file.added}</Txt> <Txt size={13} color={t.bad}>-{file.removed}</Txt>
          </Txt>
        )}
        {file.binary ? null : <Icon name={open ? 'close' : 'chevron'} size={16} color={t.ink3} />}
      </Pressable>
      {open ? <Patch patch={file.patch} /> : null}
    </View>
  );
}

/** Read what a bot changed before anyone merges it. */
export function ChangesScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getChanges(connection, id).then(setChanges).catch((err: Error) => setError(err.message));
  }, [connection, id]);

  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Code changes</Title>
      {!changes ? (error ? <Txt color={t.bad}>{error}</Txt> : <ActivityIndicator color={t.accent} />) : (
        <>
          <Txt size={14} color={t.ink2} selectable>{changes.branch}, compared with {changes.base}</Txt>
          {changes.commits.length ? <Label>Commits</Label> : null}
          {changes.commits.length ? (
            <Group>
              {changes.commits.map((commit) => (
                <View key={commit.sha} style={styles.commit}>
                  <Text selectable style={[styles.code, { color: t.ink3 }]}>{commit.sha}</Text>
                  <Txt size={14} style={styles.flex}>{commit.subject}</Txt>
                </View>
              ))}
            </Group>
          ) : null}
          <Label>Files</Label>
          {changes.files.length ? (
            <Group>{changes.files.map((file, index) => <FileRow key={file.path} file={file} last={index === changes.files.length - 1} />)}</Group>
          ) : <Txt color={t.ink2}>This branch changed nothing.</Txt>}
          {changes.cut ? <Txt size={13} color={t.warn}>Some of this was too long for the phone. Open the branch on the PC to read it all.</Txt> : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { gap: 10, paddingHorizontal: 16 },
  commit: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  file: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 9 },
  patch: { paddingBottom: 10, paddingHorizontal: 10 },
  code: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
});
