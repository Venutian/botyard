import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, currentRoute, Devices, getDevices, retireSharedKey, revokeDevice } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { Button, GlassButton, Group, Label, Row, Title, Txt } from '../ui/kit';
import { shortWhen } from '../ui/time';

const VIA = {
  home: 'Reaching the PC on home Wi-Fi',
  away: 'Reaching the PC through WireGuard',
  edge: 'Reaching the PC through Cloudflare',
};

/** Every device has its own key, so a lost phone can be cut off without touching the others. */
export function DevicesScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<Devices | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await getDevices(connection));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => {
    load();
  }, [load]);

  const [via, setVia] = useState<'home' | 'away' | 'edge' | null>(null);
  useEffect(() => {
    // The studio may well be out of reach on this screen, so a failure is not an error here.
    if (Platform.OS !== 'web' && state) currentRoute(connection).then(setVia, () => setVia(null));
  }, [connection, state]);

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (err) {
      tell('That did not work', (err as Error).message);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
      <GlassButton icon="back" label="Back" onPress={nav.back} />
      <Title>Devices</Title>
      <Txt color={t.ink2}>What can reach your studio. Pair another one by running npm run pair on the PC.</Txt>
      {error ? <Txt color={t.bad}>{error}</Txt> : null}
      {!state && !error ? <ActivityIndicator color={t.accent} /> : null}
      {state ? (
        <>
          <Label>Paired</Label>
          {state.devices.length ? (
            <Group>
              {state.devices.map((device, index) => {
                const mine = device.id === state.current;
                return (
                  <Row
                    key={device.id}
                    title={device.name}
                    detail={mine ? 'This device' : device.lastSeen ? `Last seen ${shortWhen(device.lastSeen)}` : 'Not used yet'}
                    last={index === state.devices.length - 1}
                    right={mine ? null : <Button label="Cut off" kind="danger" onPress={() => ask(`Cut off ${device.name}?`, 'It stops working at once. You can pair it again from the PC.', 'Cut off', () => run(() => revokeDevice(connection, device.id)))} />}
                  />
                );
              })}
            </Group>
          ) : <Txt color={t.ink2}>No device has its own key yet.</Txt>}
          <Label>Away from home</Label>
          {state.away || connection.edge ? (
            <Group>
              {connection.edge ? <Row title="Cloudflare" detail={`On, at ${connection.edge.host.replace(/^https:\/\//, '')}`} last={!state.away && !via} /> : null}
              {state.away ? <Row title="WireGuard tunnel" detail={state.away.up ? `On, the PC is ${state.away.address}` : 'Off on the PC'} last={!via} /> : null}
              {via ? <Row title="This phone" detail={VIA[via]} last /> : null}
            </Group>
          ) : (
            <Txt color={t.ink2}>Not set up, so the app works on home Wi-Fi only. Away access is set up on the PC.</Txt>
          )}
          {state.away?.changed ? (
            <View style={[styles.warning, { borderColor: t.warn, borderWidth: t.hair }]}>
              <Txt size={15} weight={600}>Your home internet address changed</Txt>
              <Txt size={14} color={t.ink2}>Away access needs it. The note on the PC says what to change in the WireGuard app.</Txt>
            </View>
          ) : null}
          {state.sharedActive ? (
            <>
              <Label>Old shared key</Label>
              <View style={[styles.warning, { borderColor: t.warn, borderWidth: t.hair }]}>
                <Txt size={15} weight={600}>The old key still works</Txt>
                <Txt size={14} color={t.ink2}>Anyone who saw it could still get in. Turn it off once this phone and the PC window both appear above.</Txt>
                <Button
                  label="Turn off the old key"
                  kind="danger"
                  disabled={!state.current}
                  onPress={() => ask('Turn off the old key?', 'Any device not listed above stops working until you pair it again.', 'Turn off', () => run(() => retireSharedKey(connection)))}
                />
              </View>
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { gap: 10, paddingHorizontal: 16 },
  warning: { borderRadius: 18, gap: 8, padding: 14 },
});
