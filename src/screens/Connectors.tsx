/**
 * Connectors on the phone: what the crew is connected to, whether each sign-in is still good, and who
 * may use it. Adding a service and signing in are done on the PC, because the service sends the owner
 * back to the computer Botyard runs on.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { checkConnector, Connection, Connector, getConnectors, setConnectorAccess } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Button, Group, Label, Row, Segmented, Toggle, Txt } from '../ui/kit';
import { ago, Line, Page, Tag, useLoad } from '../ui/page';

const LEVELS = [{ id: 'off' as const, name: 'No' }, { id: 'read' as const, name: 'May look' }, { id: 'write' as const, name: 'May change' }];

function stateTone(c: Connector, t: { good: string; bad: string; warn: string }) {
  return c.state === 'ready' ? t.good : c.state === 'signing-in' ? t.warn : t.bad;
}

export function ConnectorsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getConnectors(connection), [connection], 30_000);
  return (
    <Page title="Connectors" note="Services the crew may use, and the sign-ins the bots run on." onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {data ? (
        <>
          <Label>Connected</Label>
          {data.connectors.length ? (
            <Group>
              {data.connectors.map((c, index) => {
                const given = c.bots.filter((b) => b.level !== 'off').map((b) => b.name.split(' ')[0]);
                return (
                  <Line key={c.id} title={c.name} detail={given.length ? `${given.join(', ')} may use it` : 'No bot may use it yet'} note={`${c.reads} tools to look, ${c.changes} that change things`}
                    alert={c.trouble || undefined} right={<Tag text={c.stateWords} color={stateTone(c, t)} />} onPress={() => nav.push({ name: 'connector', id: c.id })} last={index === data.connectors.length - 1} />
                );
              })}
            </Group>
          ) : <Txt color={t.ink2}>Nothing is connected yet.</Txt>}
          <Txt size={12} color={t.ink3}>Add a service, or sign in to one again, on the PC under Connectors: the service sends you back to that computer.</Txt>
          <Label>What the bots run on</Label>
          <Group>
            {data.engines.map((e, index) => (
              <Line key={e.id} title={e.name} detail={e.words} note={e.for} alert={e.fix || undefined} right={<Tag text={e.ok ? 'Signed in' : 'Needs sign-in'} color={e.ok ? t.good : t.bad} />} last={index === data.engines.length - 1} noteLines={1} />
            ))}
          </Group>
        </>
      ) : null}
    </Page>
  );
}

export function ConnectorScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load, setData } = useLoad(() => getConnectors(connection), [connection]);
  const [busy, setBusy] = useState(false);
  const c = data?.connectors.find((x) => x.id === id);
  const put = (next: Connector) => setData(data ? { ...data, connectors: data.connectors.map((x) => (x.id === id ? next : x)) } : data);
  const save = async (change: { bots?: Record<string, string>; writes?: string[] }) => {
    try {
      put(await setConnectorAccess(connection, id, change));
    } catch (err) {
      tell('That was not saved', (err as Error).message);
      load();
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      put(await checkConnector(connection, id));
    } catch (err) {
      tell('It could not be checked', (err as Error).message);
    }
    setBusy(false);
  };
  const changes = c?.tools.filter((tool) => !tool.reads) ?? [];
  const allowed = changes.filter((tool) => tool.allowed).map((tool) => tool.name);
  return (
    <Page title={c?.name ?? 'Connector'} note={c?.about} onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {data && !c ? <Txt color={t.ink2}>That connector was removed.</Txt> : null}
      {c ? (
        <>
          <Group>
            <Row title="Sign-in" detail={c.trouble || (c.signedInAt ? `${c.how === 'key' ? 'Key added' : c.how === 'open' ? 'Added' : 'Signed in'} ${ago(c.signedInAt)}` : 'Sign in on the PC, under Connectors')} right={<Tag text={c.stateWords} color={stateTone(c, t)} />} />
            <Row title="Address" detail={c.address} last />
          </Group>
          <Button label="Check it now" kind="quiet" onPress={check} busy={busy} />
          <Label>Who may use it</Label>
          <Txt size={13} color={t.ink2}>May look gives a bot the tools that only read. May change adds the tools you switch on below, and nothing else. A change reaches a bot at its next run.</Txt>
          <Group>
            {c.bots.map((bot, index) => (
              <Row key={bot.id} title={bot.name} last={index === c.bots.length - 1}>
                <Segmented value={bot.level} options={LEVELS} onChange={(level) => save({ bots: { [bot.id]: level } })} />
              </Row>
            ))}
          </Group>
          <Label>{`Tools that change things (${allowed.length} of ${changes.length} allowed)`}</Label>
          {changes.length ? (
            <Group>
              {changes.map((tool, index) => (
                <Row key={tool.name} title={tool.name} detail={tool.about} last={index === changes.length - 1}
                  right={<Toggle label={tool.name} value={tool.allowed} onChange={(on) => save({ writes: on ? [...allowed, tool.name] : allowed.filter((name) => name !== tool.name) })} />} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>{c.tools.length ? 'It has none.' : 'Its tools are read once it is signed in.'}</Txt>}
          {c.reads ? <View><Txt size={13} color={t.ink3}>{`${c.reads} more tools only look, and need no switch.`}</Txt></View> : null}
        </>
      ) : null}
    </Page>
  );
}
