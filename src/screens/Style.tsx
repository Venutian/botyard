import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatMessage } from '../api';
import { Crew, Nav } from '../crew';
import { BotBadge } from '../mascot/BotBadge';
import { portraitOf, SUIT_COLOURS } from '../mascot/look';
import { fontStyle, FontChoice, FONT_CHOICES, FontId } from '../theme/fonts';
import { Prefs, useLook, WallpaperId, WALLPAPERS } from '../theme/prefs';
import { DAY, LOOK_CHOICES, LookChoice, NIGHT, Plates } from '../theme/plates';
import { ask, tell } from '../ui/ask';
import { Bubble, TypingBubble } from '../ui/Bubble';
import { Icon } from '../ui/Icon';
import { Button, Chips, ColorPicker, Field, GlassButton, Group, Label, Row, Segmented, Slider, styles as kit, Title, Toggle, Txt, useTap } from '../ui/kit';
import { Wallpaper, WALLPAPER_NAMES } from '../ui/Wallpaper';

const SAMPLE: ChatMessage[] = [
  { id: 's1', from: 'Lead', mine: false, text: 'Lighthouse passed review. Want the report?', at: '2026-11-03T09:41:00' },
  { id: 's2', from: 'You', mine: true, text: 'Yes, send it over.', at: '2026-11-03T09:42:00' },
];

function LookPreview() {
  const { p, t } = useLook();
  const lead = useMemo(() => portraitOf({ name: 'Lead', role: 'lead', status: 'idle' }), []);
  return (
    <View style={[styles.preview, { backgroundColor: t.app, borderColor: t.outline ? t.ink : t.line, borderWidth: t.hair }]}>
      <Wallpaper id={p.wallpaper} />
      <Bubble message={SAMPLE[0]} first last bot={lead} />
      <Bubble message={SAMPLE[1]} first last bot={lead} />
      <TypingBubble bot={lead} />
    </View>
  );
}

/** One look to pick: a small board of plates in its colours. "Match phone" shows half of each. */
function LookTile({ choice, name, active, onPress }: { choice: LookChoice; name: string; active: boolean; onPress: () => void }) {
  const { t } = useLook();
  const halves: Plates[] = choice === 'system' ? [DAY, NIGHT] : [choice === 'day' ? DAY : NIGHT];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ selected: active }} onPress={onPress} style={styles.look}>
      <View style={[styles.lookFace, { borderColor: active ? t.accent : t.line }]}>
        {halves.map((plates) => (
          <View key={plates.id} style={[styles.lookHalf, { backgroundColor: plates.app }]}>
            <View style={[styles.miniPlate, { backgroundColor: plates.card, borderColor: plates.line }]} />
            <View style={[styles.miniPlate, styles.miniShort, { backgroundColor: plates.card, borderColor: plates.line }]} />
            <View style={[styles.miniPaint, { backgroundColor: plates.accent }]} />
          </View>
        ))}
      </View>
      <Txt size={13} weight={600} color={active ? t.ink : t.ink2} numberOfLines={1} style={styles.lookName}>{name}</Txt>
    </Pressable>
  );
}

export function StyleScreen({ crew, nav, onForget }: { crew: Crew; nav: Nav; onForget: () => void }) {
  const { p, t, update, surprise, undo, reset, lookCode, applyLookCode } = useLook();
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState('');
  const insets = useSafeAreaInsets();
  const tap = useTap();
  const choose = (next: Partial<Prefs>) => {
    tap();
    update(next);
  };

  const confirmReset = () => ask('Reset the style?', 'Day or night, wallpaper, bubbles and text go back to the defaults. Each bot keeps its picture.', 'Reset', reset);
  const confirmForget = () => ask('Change connection?', 'You will need the pairing code from your PC again.', 'Change', onForget);

  const addPrompt = () => {
    const words = prompt.trim();
    if (!words || p.prompts.includes(words)) return;
    update({ prompts: [...p.prompts, words] });
    setPrompt('');
  };

  const useCode = () => {
    if (applyLookCode(code.trim())) setCode('');
    else tell('That is not a look code', 'Paste the whole code, from the first bracket to the last.');
  };

  return (
    <ScrollView stickyHeaderIndices={[1]} contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 120 }}>
      <View style={styles.head}>
        <Title>Style</Title>
        <View style={styles.headActions}>
          <Pressable accessibilityRole="button" onPress={() => { tap('done'); surprise(); }} style={({ pressed }) => [styles.surprise, { backgroundColor: t.accent, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }, pressed && kit.dim]}>
            <Icon name="shuffle" size={17} color={t.accentInk} />
            <Txt size={14} weight={700} color={t.accentInk}>Surprise me</Txt>
          </Pressable>
          {undo ? <GlassButton icon="reset" label="Undo the surprise" onPress={undo} size={40} /> : null}
        </View>
      </View>

      <View style={[styles.sticky, { backgroundColor: t.app }]}><LookPreview /></View>

      <View style={styles.page}>
        <Label>Day or night</Label>
        <View style={styles.looks}>
          {LOOK_CHOICES.map((choice) => <LookTile key={choice.id} choice={choice.id} name={choice.name} active={p.skin === choice.id} onPress={() => choose({ skin: choice.id })} />)}
        </View>
      </View>

      <View style={styles.page}>
        <Label>Accent</Label>
        <Group>
          <Row title="Accent colour" detail="Buttons, tabs and highlights" last>
            <ColorPicker value={p.accent} palette={SUIT_COLOURS} inherit="Amber" onChange={(accent) => update({ accent })} />
          </Row>
        </Group>

        <Label>Wallpaper</Label>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {WALLPAPERS.map((id: WallpaperId) => (
          <Pressable key={id} accessibilityRole="button" accessibilityLabel={WALLPAPER_NAMES[id]} accessibilityState={{ selected: p.wallpaper === id }} onPress={() => choose({ wallpaper: id })} style={styles.paper}>
            <View style={[styles.paperFace, { backgroundColor: t.app, borderColor: p.wallpaper === id ? t.accent : t.line }]}>
              <Wallpaper id={id} strength={0.7} />
            </View>
            <Txt size={12} weight={600} color={p.wallpaper === id ? t.ink : t.ink2}>{WALLPAPER_NAMES[id]}</Txt>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.page}>
        <View style={styles.gapTop}>
          <Group>
            <Row title="Strength">
              <Slider label="Wallpaper strength" value={p.wallpaperStrength} min={0} max={1} onChange={(wallpaperStrength) => update({ wallpaperStrength })} />
            </Row>
            <Row title="Show on every screen" last right={<Toggle label="Show on every screen" value={p.wallpaperEverywhere} onChange={(wallpaperEverywhere) => update({ wallpaperEverywhere })} />} />
          </Group>
        </View>

        <Label>Bubbles</Label>
        <Group>
          <Row title="Shape">
            <Segmented<Prefs['bubbleShape']>
              value={p.bubbleShape}
              options={[{ id: 'tail', name: 'Tail' }, { id: 'corner', name: 'Corner' }, { id: 'round', name: 'Round' }]}
              onChange={(bubbleShape) => update({ bubbleShape })}
            />
          </Row>
          <Row title="Roundness">
            <Slider label="Bubble roundness" value={p.bubbleRadius} min={4} max={26} onChange={(value) => update({ bubbleRadius: Math.round(value) })} />
          </Row>
          <Row title="Your bubbles">
            <Chips<Prefs['mineFill']>
              value={p.mineFill}
              options={[{ id: 'skin', name: 'Skin' }, { id: 'accent', name: 'Accent' }, { id: 'gradient', name: 'Gradient' }, { id: 'bot', name: "Bot's colour" }, { id: 'custom', name: 'Custom' }]}
              onChange={(mineFill) => update({ mineFill })}
            />
            {p.mineFill === 'custom' ? <ColorPicker value={p.mineColor} palette={SUIT_COLOURS} onChange={(mineColor) => mineColor && update({ mineColor })} /> : null}
          </Row>
          <Row title="Bot bubbles">
            <Segmented<Prefs['botFill']>
              value={p.botFill}
              options={[{ id: 'card', name: 'Plain' }, { id: 'tint', name: 'Tinted' }, { id: 'none', name: 'No bubble' }]}
              onChange={(botFill) => update({ botFill })}
            />
          </Row>
          <Row title="Spacing" last>
            <Segmented<Prefs['spacing']>
              value={p.spacing}
              options={[{ id: 'tight', name: 'Tight' }, { id: 'normal', name: 'Normal' }, { id: 'airy', name: 'Airy' }]}
              onChange={(spacing) => update({ spacing })}
            />
          </Row>
        </Group>

        <Label>Text</Label>
        <Group>
          <Row title="Font">
            <Chips<FontChoice>
              value={p.font}
              options={FONT_CHOICES}
              onChange={(font) => update({ font })}
              styleFor={(id) => (id === 'skin' ? {} : fontStyle(id as FontId, 600))}
            />
          </Row>
          <Row title="Chat text size">
            <Slider label="Chat text size" value={p.textScale} min={0.85} max={1.35} onChange={(textScale) => update({ textScale })} />
          </Row>
          <Row title="Show message times" right={<Toggle label="Show message times" value={p.showTimes} onChange={(showTimes) => update({ showTimes })} />} />
          <Row title="Show message previews" last right={<Toggle label="Show message previews" value={p.showPreviews} onChange={(showPreviews) => update({ showPreviews })} />} />
        </Group>

        <Label>Crew</Label>
        <Group>
          {(crew.bots ?? []).map((bot, index, list) => {
            const who = portraitOf(bot, p.bots[bot.id]);
            return (
              <Row
                key={bot.id}
                title={who.name}
                detail={bot.title}
                last={index === list.length - 1}
                onPress={() => nav.push({ name: 'bot', botId: bot.id })}
                right={<View style={styles.crewRight}><BotBadge who={who} size={38} /><Icon name="chevron" size={18} color={t.ink3} /></View>}
              />
            );
          })}
        </Group>

        <Label>Saved prompts</Label>
        <Group>
          {p.prompts.map((words) => (
            <Row key={words} title={words} right={<GlassButton icon="close" label={`Remove ${words}`} size={32} onPress={() => update({ prompts: p.prompts.filter((w) => w !== words) })} />} />
          ))}
          <Row title="Add a prompt" detail="Type / in a chat to use these" last>
            <Field value={prompt} onChangeText={setPrompt} onSubmitEditing={addPrompt} maxLength={200} placeholder="Show me the latest build" style={{ backgroundColor: t.control }} />
            <Button label="Add" kind="quiet" onPress={addPrompt} disabled={!prompt.trim()} />
          </Row>
        </Group>

        <Label>Share this look</Label>
        <Group>
          <Row title="Your look as a code" detail="Photos stay on this phone" right={<Button label="Share" kind="quiet" icon="share" onPress={() => Share.share({ message: lookCode() }).catch(() => undefined)} />} />
          <Row title="Use a code" last>
            <Field value={code} onChangeText={setCode} multiline autoCapitalize="none" autoCorrect={false} placeholder="Paste a look code" style={{ backgroundColor: t.control }} />
            <Button label="Apply" kind="quiet" onPress={useCode} disabled={!code.trim()} />
          </Row>
        </Group>

        <Label>App</Label>
        <Group>
          {Platform.OS !== 'web' ? <Row title="Tell me when bots need me" detail="Checks about every 15 minutes" right={<Toggle label="Tell me when bots need me" value={p.notify} onChange={(notify) => update({ notify })} />} /> : null}
          <Row title="Devices" detail="See and cut off what can reach your studio" onPress={() => nav.push({ name: 'devices' })} right={<Icon name="shield" size={20} color={t.ink3} />} />
          <Row title="Vibrate on taps" right={<Toggle label="Vibrate on taps" value={p.haptics} onChange={(haptics) => update({ haptics })} />} />
          <Row title="Tab names" last right={<Toggle label="Tab names" value={p.tabLabels} onChange={(tabLabels) => update({ tabLabels })} />} />
        </Group>

        <View style={styles.footer}>
          <Button label="Reset the style" kind="quiet" icon="reset" onPress={confirmReset} />
          <Button label="Change connection" kind="quiet" icon="link" onPress={confirmForget} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 10, paddingHorizontal: 18 },
  headActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  surprise: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 7, minHeight: 40, paddingHorizontal: 14 },
  sticky: { paddingBottom: 6, paddingHorizontal: 16 },
  preview: { borderRadius: 22, overflow: 'hidden', paddingBottom: 12, paddingHorizontal: 12, paddingTop: 2 },
  page: { paddingHorizontal: 16 },
  gapTop: { marginTop: 10 },
  rail: { gap: 10, paddingHorizontal: 16 },
  looks: { flexDirection: 'row', gap: 10 },
  look: { flex: 1 },
  lookFace: { borderRadius: 10, borderWidth: 2, flexDirection: 'row', height: 92, overflow: 'hidden' },
  lookHalf: { flex: 1, gap: 6, padding: 8 },
  miniPlate: { borderRadius: 4, borderWidth: 1, height: 16 },
  miniShort: { width: '62%' },
  miniPaint: { borderRadius: 3, bottom: 8, height: 10, left: 8, position: 'absolute', width: 22 },
  lookName: { marginTop: 6, textAlign: 'center' },
  paper: { alignItems: 'center', gap: 5, width: 76 },
  paperFace: { borderRadius: 16, borderWidth: 2, height: 100, overflow: 'hidden', width: 76 },
  crewRight: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  footer: { gap: 14, marginTop: 24 },
});
