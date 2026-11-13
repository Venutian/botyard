import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { ChatMessage, SYSTEM } from '../api';
import { BotBadge } from '../mascot/BotBadge';
import { Portrait } from '../mascot/look';
import { alpha, inkOn, mix, shiftHue } from '../theme/color';
import { Prefs, Theme, useLook } from '../theme/prefs';
import { Markdown } from './Markdown';
import { clock } from './time';
import { Txt } from './kit';

const useNativeDriver = Platform.OS !== 'web';
const AVATAR = 30;
const SPACING = { tight: { gap: 2, split: 8, x: 11, y: 6 }, normal: { gap: 3, split: 12, x: 13, y: 8 }, airy: { gap: 6, split: 18, x: 15, y: 11 } };

export type Fill = { color: string; to?: string; ink: string };

export function mineFill(p: Prefs, t: Theme, botColor: string): Fill {
  switch (p.mineFill) {
    case 'accent':
      return { color: t.accent, ink: t.accentInk };
    case 'gradient':
      return { color: t.accent, to: shiftHue(t.accent, 46), ink: t.accentInk };
    case 'bot':
      return { color: botColor, ink: inkOn(botColor) };
    case 'custom':
      return { color: p.mineColor, ink: inkOn(p.mineColor) };
    default:
      return { color: t.mine, ink: t.mineInk };
  }
}

export function botFill(p: Prefs, t: Theme, botColor: string): Fill | null {
  if (p.botFill === 'none') return null;
  if (p.botFill === 'tint') {
    const color = mix(t.card, botColor, t.dark ? 0.3 : 0.2);
    return { color, ink: inkOn(color) === '#ffffff' ? t.ink : mix(t.ink, '#000000', 0.2) };
  }
  return { color: t.card, ink: t.ink };
}

/** The little hook on the last bubble of a run. */
function Tail({ color, left }: { color: string; left: boolean }) {
  const d = left ? 'M16 0H10V8C10 13 7 17.5 .5 19.6 6 20.5 12 19.6 16 16Z' : 'M0 0H6V8C6 13 9 17.5 15.5 19.6 10 20.5 4 19.6 0 16Z';
  return (
    <Svg width={16} height={20} viewBox="0 0 16 20" style={[styles.tail, left ? styles.tailLeft : styles.tailRight]}>
      <Path d={d} fill={color} />
    </Svg>
  );
}

function BubbleFill({ fill, id }: { fill: Fill; id: string }) {
  if (!fill.to) return null;
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={fill.color} />
          <Stop offset="1" stopColor={fill.to} />
        </LinearGradient>
      </Defs>
      <Rect width={100} height={100} fill={`url(#${id})`} />
    </Svg>
  );
}

type Props = {
  message: ChatMessage;
  /** First and last in a run of messages from the same side. */
  first: boolean;
  last: boolean;
  bot: Portrait;
  fresh?: boolean;
  /** Names the bot above its message, for rooms with more than one. */
  named?: boolean;
};

function BubbleView({ message, first, last, bot, fresh, named }: Props) {
  const { p, t, font } = useLook();
  const pop = useRef(new Animated.Value(fresh ? 0 : 1)).current;

  useEffect(() => {
    if (fresh) Animated.spring(pop, { toValue: 1, useNativeDriver, speed: 18, bounciness: 9 }).start();
  }, [fresh, pop]);

  if (SYSTEM.includes(message.from)) {
    return <View style={styles.system}><Txt size={12} color={t.ink3} style={styles.systemText}>{message.text}</Txt></View>;
  }
  // One of the crew's scripts speaking to the bot (a crew check, the review guard): a note in the
  // middle, under the script's name, so it is neither read as the bot's words nor as the owner's.
  if (message.note) {
    return (
      <View style={[styles.scriptNote, { borderColor: t.line }]}>
        <Txt size={11} weight={700} color={t.ink3}>{`${message.from}${message.at ? `  ${clock(message.at)}` : ''}`}</Txt>
        <Markdown text={message.text} ink={t.ink2} size={13} />
      </View>
    );
  }

  const space = SPACING[p.spacing];
  const size = Math.round(16 * p.textScale);
  const mine = message.mine;
  const fill = mine ? mineFill(p, t, bot.colour) : botFill(p, t, bot.colour);
  const ink = fill?.ink ?? t.ink;
  const hook = p.bubbleShape === 'tail' && last && Boolean(fill) && !fill?.to;
  const tuck = p.bubbleShape !== 'round' && last;
  const radius = p.bubbleRadius;
  const shape = {
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: !mine && tuck ? 5 : radius,
    borderBottomRightRadius: mine && tuck ? 5 : radius,
  };
  const outlined = t.outline && fill ? { borderColor: t.ink, borderWidth: 2 } : null;
  const time = p.showTimes && last && message.at ? clock(message.at) : '';

  return (
    <Animated.View
      style={[
        { marginTop: first ? space.split : space.gap, opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) }] },
        { transformOrigin: mine ? 'right bottom' : 'left bottom' },
      ]}
    >
      {named && first && !mine ? <Txt size={12} weight={700} color={bot.colour} style={styles.named}>{bot.name}</Txt> : null}
      <View style={[styles.line, mine && styles.lineMine]}>
        {!mine ? <View style={styles.avatar}>{last ? <BotBadge who={bot} size={AVATAR} /> : null}</View> : null}
        <View style={styles.bubbleWrap}>
          {hook && fill ? <Tail color={fill.color} left={!mine} /> : null}
          <View style={[shape, styles.bubble, fill ? { backgroundColor: fill.color } : null, outlined, { paddingHorizontal: fill ? space.x : 2, paddingVertical: fill ? space.y : 2 }]}>
            {fill ? <BubbleFill fill={fill} id={`b${message.id}`} /> : null}
            {mine ? <Text selectable style={[textStyle(size, ink), font(400)]}>{message.text}</Text> : <Markdown text={message.text} ink={ink} size={size} />}
          </View>
        </View>
      </View>
      {time ? <Txt size={11} color={t.ink3} style={[styles.time, mine ? styles.timeMine : styles.timeBot]}>{time}</Txt> : null}
    </Animated.View>
  );
}

const textStyle = (size: number, color: string) => ({ color, fontSize: size, lineHeight: Math.round(size * 1.42) });

export const Bubble = memo(BubbleView, (a, b) =>
  a.message.id === b.message.id && a.message.text === b.message.text && a.first === b.first && a.last === b.last && a.bot === b.bot);

function Dot({ color, delay }: { color: string; delay: number }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const swing = (toValue: number) => Animated.timing(value, { toValue, duration: 300, easing: Easing.inOut(Easing.sin), useNativeDriver });
    const loop = Animated.loop(Animated.sequence([Animated.delay(delay), swing(1), swing(0), Animated.delay(420 - delay)]));
    loop.start();
    return () => loop.stop();
  }, [value, delay]);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }), transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }] }]} />;
}

/** Three dots in the bot's own colour, with its mascot beside them, thinking. */
export function TypingBubble({ bot }: { bot: Portrait }) {
  const { t } = useLook();
  return (
    <View style={[styles.line, styles.typing]}>
      <View style={styles.avatar}><BotBadge who={bot} size={AVATAR} state="working" /></View>
      <View style={[styles.typingBubble, { backgroundColor: alpha(bot.colour, t.dark ? 0.2 : 0.14) }]}>
        <Dot color={bot.colour} delay={0} />
        <Dot color={bot.colour} delay={140} />
        <Dot color={bot.colour} delay={280} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { alignItems: 'flex-end', flexDirection: 'row', gap: 6 },
  lineMine: { justifyContent: 'flex-end' },
  avatar: { width: AVATAR },
  bubbleWrap: { flexShrink: 1, maxWidth: '86%' },
  bubble: { overflow: 'hidden' },
  tail: { bottom: 0, position: 'absolute' },
  tailRight: { right: -8 },
  tailLeft: { left: -8 },
  named: { marginBottom: 2, marginLeft: AVATAR + 10 },
  time: { marginTop: 3 },
  timeMine: { marginRight: 4, textAlign: 'right' },
  timeBot: { marginLeft: AVATAR + 10 },
  system: { alignItems: 'center', marginVertical: 8, paddingHorizontal: 24 },
  scriptNote: { borderRadius: 12, borderStyle: 'dashed', borderWidth: 1, gap: 4, marginHorizontal: 18, marginVertical: 8, paddingHorizontal: 12, paddingVertical: 9 },
  systemText: { textAlign: 'center' },
  typing: { marginTop: 12 },
  typingBubble: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', gap: 5, height: 36, paddingHorizontal: 14 },
  dot: { borderRadius: 4, height: 8, width: 8 },
});
