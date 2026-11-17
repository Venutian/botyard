import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Bot, botAction, Connection, getBot } from '../api';
import { Crew, leadOf, Nav } from '../crew';
import { BotBadge } from '../mascot/BotBadge';
import { BotState, portraitOf, STATE_WORDS, SUIT_COLOURS } from '../mascot/look';
import { useLook, WallpaperId, WALLPAPERS } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Button, Chips, ColorPicker, Field, GlassButton, Group, Label, Row, Segmented, Toggle, Txt, useTap } from '../ui/kit';
import { WALLPAPER_NAMES } from '../ui/Wallpaper';
import { CAN_TALK } from '../voice';
import { ago, Line, tokens, useLoad } from '../ui/page';
import { engineLine, RunLine, stateTone, wasteWords } from './Crew';

const STAGE = 230;
const SHOWN = 46;
/** The states a badge can show, in the order work moves through them. */
const STATES: BotState[] = ['free', 'working', 'waiting', 'blocked', 'off'];

/** A bot's page: what it is doing and why, its last runs and errors, pausing it; and below, how it is shown on this phone. */
export function BotScreen({ botId, connection, crew, nav }: { botId: string; connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t, updateBot, resetBot } = useLook();
  const insets = useSafeAreaInsets();
  const tap = useTap();
  // The engine takes a moment to report a change, so the switch shows the owner's choice until it catches up.
  const [wanted, setWanted] = useState<boolean | null>(null);
  const page = useLoad(() => getBot(connection, botId), [connection, botId], 20_000);
  const info = page.data;
  const listed = crew.bots?.find((b) => b.id === botId);
  const bot: Bot | null = listed ?? (info ? { id: info.id, name: info.name, title: info.title, status: info.status, model: info.model, spentCents: 0, role: info.role, look: info.look } : null);
  const look = p.bots[botId] ?? {};
  if (!bot) return null;
  // The phone chats with the lead; in a studio with no lead, with any bot.
  const lead = leadOf(crew.bots);
  const chats = lead ? lead.id === botId : true;
  const who = portraitOf({ ...bot, role: bot.role ?? info?.role, look: bot.look ?? info?.look }, look);
  const set = (next: typeof look) => {
    tap();
    updateBot(botId, next);
  };

  const paused = wanted ?? (info?.status ?? bot.status) === 'paused';
  const setPaused = async (next: boolean) => {
    setWanted(next);
    try {
      await botAction(connection, botId, next ? 'pause' : 'resume');
      setTimeout(() => {
        crew.reload();
        page.load().finally(() => setWanted(null));
      }, 1800);
    } catch (err) {
      setWanted(null);
      tell('That did not work', (err as Error).message);
    }
  };

  const choosePhoto = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.85 });
    if (picked.canceled) return;
    const uri = picked.assets[0].uri;
    if (Platform.OS === 'web') {
      updateBot(botId, { photo: uri });
      return;
    }
    try {
      // The picker's copy lives in a cache that Android may clear, so keep our own.
      const kept = `${FileSystem.documentDirectory}bot-${botId}-${Date.now()}.jpg`;
      await FileSystem.copyAsync({ from: uri, to: kept });
      updateBot(botId, { photo: kept });
    } catch (err) {
      tell('The photo was not saved', (err as Error).message);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <View style={[styles.stage, { height: STAGE + insets.top }]}>
        <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="glow" cx="50%" cy="60%" r="62%">
              <Stop offset="0" stopColor={who.colour} stopOpacity={0.5} />
              <Stop offset="1" stopColor={who.colour} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#glow)" />
        </Svg>
        <View style={[styles.stageBar, { top: insets.top + 8 }]}>
          <GlassButton icon="back" label="Back" onPress={nav.back} />
        </View>
        <View style={{ marginTop: insets.top + 34 }}>
          <BotBadge who={who} size={130} />
        </View>
        <Txt size={24} weight={700} accessibilityRole="header" style={styles.stageName}>{who.name}</Txt>
        <Txt size={14} color={t.ink2} numberOfLines={1}>{bot.title}</Txt>
      </View>

      <View style={styles.page}>
        {chats ? <Button label={`Chat with ${who.name}`} onPress={() => nav.replace({ name: 'chat', botId })} /> : null}

        <Label>Now</Label>
        {page.error && !info ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">{page.error}</Txt> : null}
        <Group>
          {info ? (
            <>
              <Row title={info.state} detail={info.restingWhy || (info.job ? `On ${info.job.ref} ${info.job.title}` : info.status === 'error' ? 'Its last run stopped on an error' : undefined)}
                right={<Txt size={12} weight={700} color={stateTone(info.status, t)}>{info.resting ? 'Resting' : ''}</Txt>}
                onPress={info.job ? () => nav.push({ name: 'job', id: info.job!.id }) : undefined} />
              <Row title={`Thinks on ${engineLine(info).what}`} detail={engineLine(info).why || undefined} />
              <Row title={`${tokens(info.today.tokens)} tokens today, ${tokens(info.week.tokens)} this week`} detail={`${info.week.runs} runs this week${info.reportsTo ? `. Reports to ${info.reportsTo}` : ''}`} />
              {info.waste?.flagged ? <Row title={wasteWords(info.waste.share)} detail={info.waste.causes.map((c) => `${c.text} (${c.count})`).join(', ')} /> : null}
            </>
          ) : null}
          <Row title="Pause this bot" detail="Stops it taking any new work" last right={<Toggle label="Pause this bot" value={paused} onChange={setPaused} />} />
        </Group>
        <View style={styles.shape}>
          <Group>
            <Line title="Change its settings" detail="Who it is, which AI runs it, its limits, what it may not do, its variables" onPress={() => nav.push({ name: 'botEdit', botId })} />
            <Line title="Edit its instructions" detail="What it reads before every run, and every earlier version" onPress={() => nav.push({ name: 'botRules', botId, botName: bot.name })} last />
          </Group>
        </View>

        {info?.runs.length ? (
          <>
            <Label>{`Last runs, ${info.runs.filter((r) => r.failed).length} failed`}</Label>
            <Group>
              {info.runs.slice(0, 8).map((run, index, all) => <RunLine key={run.id} run={run} last={index === all.length - 1} onOpen={() => nav.push({ name: 'run', id: run.id })} />)}
            </Group>
            {info.runs.length > 8 ? <Line title="All of its runs" onPress={() => nav.push({ name: 'runs', bot: botId })} last /> : null}
          </>
        ) : null}
        {info?.revisions.length ? (
          <>
            <Label>Settings changes</Label>
            <Group>
              {info.revisions.map((rev, index) => <Line key={rev.id} title={rev.what} detail={rev.detail || undefined} note={`${rev.by}, ${ago(rev.at)}`} last={index === info.revisions.length - 1} />)}
            </Group>
          </>
        ) : null}

        <Label>Its picture</Label>
        <Group>
          <View style={styles.states}>
            {STATES.map((state) => (
              <View key={state} style={styles.state}>
                <BotBadge who={{ ...who, photo: undefined }} size={SHOWN} state={state} />
                <Txt size={12} weight={who.state === state ? 700 : 600} color={who.state === state ? t.ink : t.ink2}>{STATE_WORDS[state]}</Txt>
              </View>
            ))}
          </View>
          <Row title="Hat, build and gear" detail="Come from the bot's role and its settings, the same as on the map" last={false} onPress={() => nav.push({ name: 'botEdit', botId })} />
          <Row title="Colour on this phone" last>
            <ColorPicker value={look.colour ?? null} palette={SUIT_COLOURS} inherit="Its own" onChange={(colour) => set({ colour: colour ?? undefined })} />
          </Row>
        </Group>

        <Label>Name and photo</Label>
        <View style={styles.stack}>
          <Field value={look.nickname ?? ''} onChangeText={(nickname) => updateBot(botId, { nickname })} placeholder={bot.name} accessibilityLabel={`Name on this phone, now ${look.nickname || bot.name}`} maxLength={30} />
          <Group>
            <Row title="Photo" detail={look.photo ? 'Shown in place of the drawing' : 'Use any image from your phone'} last={!look.photo} right={
              <Button label={look.photo ? 'Change' : 'Choose'} kind="quiet" icon="image" onPress={choosePhoto} />
            } />
            {look.photo ? (
              <Row title="Fit" last>
                <Segmented<'plate' | 'round'>
                  value={look.frame ?? 'plate'}
                  options={[{ id: 'plate', name: 'Plate' }, { id: 'round', name: 'Round' }]}
                  onChange={(frame) => set({ frame })}
                />
                <Button label="Remove photo" kind="danger" onPress={() => updateBot(botId, { photo: undefined })} />
              </Row>
            ) : null}
          </Group>
        </View>

        {chats ? <>
        <Label>This chat</Label>
        <Group>
          <Row title="Wallpaper" detail="Only in this chat" last={!CAN_TALK}>
            <Chips<WallpaperId | 'same'>
              value={look.wallpaper ?? 'same'}
              options={[{ id: 'same', name: 'Same as app' }, ...WALLPAPERS.map((id) => ({ id, name: WALLPAPER_NAMES[id] }))]}
              onChange={(wallpaper) => updateBot(botId, { wallpaper: wallpaper === 'same' ? undefined : wallpaper })}
            />
          </Row>
          {CAN_TALK ? <Row title="Read replies aloud" last right={<Toggle label="Read replies aloud" value={Boolean(look.speak)} onChange={(speak) => updateBot(botId, { speak })} />} /> : null}
        </Group>
        </> : null}

        <View style={styles.reset}>
          <Button label="Reset this bot's look" kind="quiet" icon="reset" onPress={() => resetBot(botId)} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  stage: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stageBar: { left: 14, position: 'absolute' },
  stageName: { marginTop: 4 },
  page: { paddingHorizontal: 16, paddingTop: 10 },
  states: { flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 6, paddingVertical: 12 },
  state: { alignItems: 'center', gap: 5 },
  stack: { gap: 10 },
  reset: { marginTop: 22 },
  shape: { marginTop: 10 },
});
