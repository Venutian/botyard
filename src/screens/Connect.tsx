import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, getSummary } from '../api';
import { BotBadge } from '../mascot/BotBadge';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { Button, Field, Title, Txt } from '../ui/kit';

const HOST = portraitOf({ name: 'Lead', role: 'lead' });

export function ConnectScreen({ onConnect }: { onConnect: (connection: Connection) => void }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const test = async () => {
    setBusy(true);
    setError('');
    try {
      const connection = { host: host.trim(), token: token.trim() };
      await getSummary(connection);
      onConnect(connection);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.hero}>
          <BotBadge who={HOST} size={132} state="waiting" />
        </View>
        <Title>Botyard</Title>
        <Txt color={t.ink2}>Scan the pairing code from your PC, or enter the details here.</Txt>
        <Field label="PC address" value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} placeholder="192.168.0.2:5288" />
        <Field label="Token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Pairing token" />
        {error ? <Txt color={t.bad} accessibilityLiveRegion="polite">{error}</Txt> : null}
        <Button label="Connect" onPress={test} busy={busy} disabled={!host.trim() || !token.trim()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { gap: 14, paddingHorizontal: 22 },
  hero: { alignItems: 'center', marginBottom: 12 },
});
