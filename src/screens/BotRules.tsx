/**
 * What a bot reads before every run, as a real editor that fills the screen: save, a mark while it
 * differs from what is saved, a question before unsaved work is left, and every earlier version one
 * tap back. Says the same as the PC's instructions page.
 */
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, getBotInstructions, restoreBotInstructions, saveBotInstructions } from '../api';
import { Crew, Nav } from '../crew';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { ask } from '../ui/ask';
import { MONO, Note, Small, useAct, useLeaveGuard } from '../ui/form';
import { Button, GlassButton, Group, plainField, Segmented, Sign, styles as kit, Txt } from '../ui/kit';
import { ago, Tag, useLoad } from '../ui/page';

const MAX = 200_000;
const size = (bytes: number) => (bytes ? (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`) : '');
const stamp = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function BotRulesScreen({ botId, botName, connection, crew, nav }: { botId: string; botName?: string; connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const { data: ins, error, load } = useLoad(() => getBotInstructions(connection, botId), [connection, botId]);
  const [draft, setDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<'text' | 'versions'>('text');
  const [saved, setSaved] = useState(false);
  const { busy, run } = useAct();

  const bot = crew.bots?.find((b) => b.id === botId);
  const who = bot ? portraitOf(bot, p.bots[botId]) : botName ? portraitOf({ id: botId, name: botName }, p.bots[botId]) : null;
  const text = draft ?? ins?.content ?? '';
  const dirty = draft !== null && draft !== ins?.content;
  useLeaveGuard('botRules', dirty, nav.back, 'These instructions have changes that are not saved.');

  const save = () => run('save', async () => {
    await saveBotInstructions(connection, botId, text, ins?.revisionId ?? null);
    await load();
    setDraft(null);
    setSaved(true);
  }, 'The instructions were not saved');

  const takeBack = (id: string, at: string) => ask(
    `Take back the version from ${stamp(at)}?`,
    `${dirty ? 'What you typed and did not save is dropped. ' : ''}The instructions as they are saved now are kept as a version, so nothing saved is lost. The bot reads the change at its next run.`,
    'Take this back',
    () => run(`restore:${id}`, async () => {
      await restoreBotInstructions(connection, botId, id, ins?.revisionId ?? null);
      await load();
      setDraft(null);
      setTab('text');
      setSaved(true);
    }, 'That version was not taken back'),
  );

  const edge = t.plates && t.dark ? '#05070a' : t.ink;
  const plate = { backgroundColor: t.card, borderColor: t.outline ? edge : 'transparent', borderRadius: t.r.card, borderWidth: t.outline ? 2 : 0 };
  const history = ins?.history ?? [];

  return (
    <KeyboardAvoidingView behavior="padding" style={kit.flex}>
      <View style={[styles.page, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.head}>
          <GlassButton icon="back" label="Back" onPress={nav.back} />
          {dirty ? <Tag text="Changed since last save" color={t.warn} /> : saved ? <Tag text="Saved" color={t.good} /> : null}
        </View>
        <View style={styles.name}>
          {who ? <View style={[styles.suit, { backgroundColor: who.colour, borderColor: edge }]} /> : null}
          <Sign size={28} numberOfLines={1} accessibilityRole="header" style={kit.flex}>{who ? `${who.name}: instructions` : 'Instructions'}</Sign>
        </View>

        {!ins ? (error ? <><Txt color={t.bad} accessibilityLiveRegion="polite">{error}</Txt><Button label="Try again" onPress={load} /></> : <ActivityIndicator color={t.accent} style={styles.wait} />) : !ins.managed ? (
          ins.content ? (
            <>
              <Note tone="warn">These instructions cannot be changed in Botyard on this engine yet. They are shown as the bot reads them.</Note>
              <ScrollView style={[kit.flex, plate]} contentContainerStyle={styles.read}>
                <Txt size={13} selectable style={MONO}>{ins.content}</Txt>
              </ScrollView>
            </>
          ) : <Txt color={t.ink2}>This bot has no instructions yet. They are written on the PC, where its engine keeps them.</Txt>
        ) : (
          <>
            <Segmented value={tab} options={[{ id: 'text', name: 'Instructions' }, { id: 'versions', name: `Versions (${history.length})` }]} onChange={setTab} />
            {tab === 'text' ? (
              <>
                <TextInput
                  value={text}
                  onChangeText={(next) => { setDraft(next); setSaved(false); }}
                  multiline
                  scrollEnabled
                  maxLength={MAX}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  textAlignVertical="top"
                  accessibilityLabel={`${who?.name ?? 'The bot'}'s instructions`}
                  placeholder="Write what this bot should know and do before every run."
                  placeholderTextColor={t.ink3}
                  style={[styles.editor, plainField, MONO, plate, { color: t.ink }]}
                />
                <View style={styles.bar}>
                  <Txt size={12} color={t.ink3} style={kit.flex}>{`${text.length.toLocaleString()} characters. A save takes effect on its next run.`}</Txt>
                  {dirty ? <Small label="Put it back as it was" disabled={Boolean(busy)} onPress={() => setDraft(null)} /> : null}
                </View>
                <Button label="Save" busy={busy === 'save'} disabled={!dirty || Boolean(busy)} onPress={save} />
              </>
            ) : (
              <ScrollView style={kit.flex} contentContainerStyle={styles.versions}>
                <Txt size={13} color={t.ink2}>Every save keeps the one before it. A save takes effect on the bot's next run.</Txt>
                {history.length ? (
                  <Group>
                    {history.map((h, index) => (
                      <View key={h.id} style={[styles.version, index < history.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
                        <View style={kit.flex}>
                          <Txt size={15} weight={600}>{stamp(h.at)}</Txt>
                          <Txt size={12} color={t.ink3}>{[h.by, size(h.bytes), ago(h.at)].filter(Boolean).join(', ')}</Txt>
                        </View>
                        {index === 0 ? <Tag text="Current" color={t.good} /> : <Small label="Take this back" disabled={Boolean(busy)} onPress={() => takeBack(h.id, h.at)} />}
                      </View>
                    ))}
                  </Group>
                ) : <Txt color={t.ink2}>No earlier versions yet. Save once and the version before it is kept here.</Txt>}
              </ScrollView>
            )}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: 10, paddingHorizontal: 16 },
  head: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  name: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  suit: { borderRadius: 3, borderWidth: 2, height: 26, width: 10 },
  wait: { marginTop: 24 },
  read: { padding: 12 },
  editor: { flex: 1, fontSize: 14, lineHeight: 20, padding: 12 },
  bar: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  versions: { gap: 10, paddingBottom: 12 },
  version: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10 },
});
