/**
 * Setup on the phone: one row per thing the studio needs, free models first, saying the same as the
 * PC. A key can be pasted from here; a sign-in opens on the computer Botyard runs on, so the phone
 * shows the line to run there instead of a button.
 */
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { checkSetup, Connection, FIRST_STEP_NAMES, forgetSetupKey, getFirstRun, getSetup, restoreProject, saveSetupKey, Setup, SetupRow } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { MONO, Note, Small, useAct } from '../ui/form';
import { Button, Field, Group, Label, styles as kit, Txt } from '../ui/kit';
import { ago, Line, Page, Tag, useLoad } from '../ui/page';

const GROUPS: [SetupRow['kind'], string, string][] = [
  ['free', 'Free models', 'Work with no account and cost nothing. Enough to run a whole crew; a key raises the daily limits.'],
  ['ai', 'Your own AI subscriptions', 'Each is signed in through its own tool, on its own page. Botyard never sees a password.'],
  ['needs', 'What Botyard itself needs', ''],
];

function OneRow({ row, connection, onData, last }: { row: SetupRow; connection: Connection; onData: (next: Setup) => void; last: boolean }) {
  const { t } = useLook();
  const { busy, run } = useAct();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const a = row.action;
  // A thing that is optional and missing is not an alarm: only what Botyard cannot work without is red.
  const tone = row.state === 'ok' ? t.good : row.state === 'signed-out' ? t.warn : row.state === 'missing' && row.needed ? t.bad : t.ink3;

  const save = () => {
    // The key leaves the screen before the request starts, and is never put back.
    const secret = key;
    setKey('');
    run('key', async () => {
      const answer = await saveSetupKey(connection, row.id, secret);
      setOpen(false);
      onData(answer.state ?? (await getSetup(connection)));
    }, 'The key was not saved');
  };
  const forget = () => ask(`Forget the key for ${row.name}?`, 'The key is deleted from the computer Botyard runs on. Bots that need it stop working until you paste one again.', 'Forget the key', () => {
    run('forget', async () => {
      const answer = await forgetSetupKey(connection, row.id);
      onData(answer.state ?? (await getSetup(connection)));
    }, 'The key was not forgotten');
  });

  return (
    <View style={[styles.row, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.rowHead}>
        <Txt size={15} weight={600} style={kit.flex}>{row.name}</Txt>
        <Tag text={row.stateWords} color={tone} />
      </View>
      {row.what ? <Txt size={13} color={t.ink2}>{row.what}</Txt> : null}
      {row.detail ? <Txt size={12} color={t.ink3}>{row.detail}</Txt> : null}
      {a?.kind === 'start' && a.command ? (
        <View style={styles.byHand}>
          <Txt size={12} color={t.ink2}>On the computer Botyard runs on, run</Txt>
          <View style={[styles.command, { backgroundColor: t.control, borderRadius: t.r.chip }]}>
            <Txt size={13} selectable style={MONO}>{a.command}</Txt>
          </View>
        </View>
      ) : null}
      {a?.kind === 'key' || a?.kind === 'link' || row.forget ? (
        <View style={styles.acts}>
          {a?.kind === 'key' ? <Small label={open ? 'Close' : a.label} disabled={Boolean(busy)} onPress={() => { setOpen(!open); setKey(''); }} /> : null}
          {a?.kind === 'link' && a.url ? <Small label={a.label} onPress={() => Linking.openURL(a.url!).catch(() => tell('That page did not open', a.url!))} /> : null}
          {row.forget ? <Small label="Forget the key" danger disabled={Boolean(busy)} onPress={forget} /> : null}
        </View>
      ) : null}
      {a?.kind === 'key' && open ? (
        <View style={styles.keyForm}>
          <Field label="The key" value={key} onChangeText={setKey} secureTextEntry maxLength={4000} autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off" textContentType="none" importantForAutofill="no" placeholder="Paste it here" />
          <Button label="Save the key" busy={busy === 'key'} disabled={key.trim().length < 8 || Boolean(busy)} onPress={save} />
          <Txt size={12} color={t.ink3}>It is sent once, kept in a file only you can read on the computer Botyard runs on, and never shown again.</Txt>
          {a.keysPage ? (
            <Pressable accessibilityRole="link" onPress={() => Linking.openURL(a.keysPage!).catch(() => undefined)} style={({ pressed }) => pressed && kit.dim}>
              <Txt size={13} weight={600} color={t.accentText}>Where keys are made</Txt>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The rows in their three groups. Also the first run's "Sign in an AI" step. */
export function SetupRows({ data, connection, onData }: { data: Setup; connection: Connection; onData: (next: Setup) => void }) {
  const { t } = useLook();
  if (!data.available) return <Txt color={t.ink2}>{data.summary || 'Setup cannot be read from here right now. Open it on the PC.'}</Txt>;
  return (
    <>
      {GROUPS.map(([kind, title, about]) => {
        const rows = data.rows.filter((r) => r.kind === kind);
        if (!rows.length) return null;
        return (
          <View key={kind} style={styles.group}>
            <Label>{title}</Label>
            {about ? <Txt size={13} color={t.ink2}>{about}</Txt> : null}
            <Group>
              {rows.map((row, index) => <OneRow key={row.id} row={row} connection={connection} onData={onData} last={index === rows.length - 1} />)}
            </Group>
          </View>
        );
      })}
    </>
  );
}

export function SetupScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load, setData } = useLoad(() => getSetup(connection), [connection]);
  const first = useLoad(() => getFirstRun(connection).catch(() => null), [connection]);
  const { busy, run } = useAct();
  const left = first.data?.left ?? [];
  const archived = first.data?.archived ?? [];

  const check = () => run('check', async () => setData(await checkSetup(connection)), 'It could not be checked');
  const bringBack = (id: string) => run(`restore:${id}`, async () => {
    await restoreProject(connection, id);
    await first.load();
  }, 'The project was not brought back');

  return (
    <Page title="Setup" note="What the studio needs to run, and how each thing stands." onBack={nav.back} onRefresh={async () => { await Promise.all([load(), first.load()]); }} error={error} loading={!data}>
      {data ? (
        <>
          {data.available ? <Note tone={data.ready ? 'good' : 'warn'}>{data.summary}</Note> : null}
          {left.length ? (
            <View style={styles.group}>
              <Label>Still to do from the first run</Label>
              <Group>
                {left.map((step, index) => (
                  <View key={step} style={[styles.todo, index < left.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                    <Txt size={15} weight={600} style={kit.flex}>{FIRST_STEP_NAMES[step] ?? step}</Txt>
                    <Small label="Do it now" onPress={() => nav.push({ name: 'firstRun', step })} />
                  </View>
                ))}
              </Group>
            </View>
          ) : null}

          <SetupRows data={data} connection={connection} onData={setData} />
          {data.available ? (
            <View style={styles.check}>
              <Button label="Check everything again" kind="quiet" busy={busy === 'check'} disabled={Boolean(busy)} onPress={check} />
              {data.checkedAt ? <Txt size={12} color={t.ink3} style={{ textAlign: "center" }}>{`Checked ${ago(data.checkedAt)}`}</Txt> : null}
            </View>
          ) : null}

          <Label>The rest of setting up</Label>
          <Group>
            <Line title="Connectors" detail="Services the crew may reach outside the computer, like GitHub or a shop, and who may use each." onPress={() => nav.push({ name: 'connectors' })} />
            <Line title="The crew" detail="Add a bot, change which AI runs one, edit its instructions." onPress={() => nav.push({ name: 'bots' })} />
            <Line title="Helpers" detail="The small scripts that keep the crew moving, and when each runs. They are under Routines." onPress={() => nav.push({ name: 'routines' })} last />
          </Group>

          <Label>Archived projects</Label>
          {archived.length ? (
            <Group>
              {archived.map((project, index) => (
                <View key={project.id} style={[styles.todo, index < archived.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                  <View style={kit.flex}>
                    <Txt size={15} weight={600}>{project.name}</Txt>
                    <Txt size={12} color={t.ink3}>Off the map and out of every list. Its jobs and folder are as you left them.</Txt>
                  </View>
                  <Small label="Bring it back" disabled={Boolean(busy)} onPress={() => bringBack(project.id)} />
                </View>
              ))}
            </Group>
          ) : <Txt color={t.ink2}>None. A project you archive from its own page waits here until you bring it back.</Txt>}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  row: { gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  rowHead: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  byHand: { gap: 4, marginTop: 2 },
  command: { paddingHorizontal: 10, paddingVertical: 8 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  keyForm: { gap: 10, marginTop: 6 },
  todo: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10 },
  check: { gap: 6, marginTop: 14 },
});
