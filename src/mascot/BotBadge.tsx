import { memo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Line, Path, Rect } from 'react-native-svg';
import { inkOn, mix } from '../theme/color';
import { useLook } from '../theme/prefs';
import { BotState, Build, Hat, Portrait, STATE_WORDS } from './look';

/**
 * A bot's badge: a yard robot on a plate painted in its suit colour. The robot is a screen for a
 * head, a hat that says its job, shoulders that say its build, and one piece of gear. Its eyes and a
 * painted tag at the corner say where its work stands. It never moves: it is redrawn when something
 * changes, as the map is.
 *
 * Everything is drawn in a 100 by 100 box: the hat above y 28, the head from 26 to 66, the body below 68.
 */

const HEAD = { x: 24, y: 27, w: 52, h: 39, r: 10 };
const SCREEN = { x: 29.5, y: 32.5, w: 41, h: 28, r: 6 };
const EYE_Y = 46.5;
const EYES = [41, 59];

/** Each build's shoulders and body, from the neck down to the bottom edge. */
const BODY: Record<Build, string> = {
  standard: 'M28 100 L30 80 Q31 72 40 72 L60 72 Q69 72 70 80 L72 100 Z',
  heavy: 'M12 100 L12 82 Q12 72 24 72 L76 72 Q88 72 88 82 L88 100 Z',
  barrel: 'M16 100 Q12 72 50 72 Q88 72 84 100 Z',
  slim: 'M36 100 L37 80 Q38 73 44 73 L56 73 Q62 73 63 80 L64 100 Z',
  robed: 'M10 100 L38 72 L62 72 L90 100 Z',
  curvy: 'M24 100 Q20 84 32 76 Q40 71 50 72 Q60 71 68 76 Q80 84 76 100 Z',
  lady: 'M30 100 Q30 86 36 78 Q42 72 50 72 Q58 72 64 78 Q70 86 70 100 Z',
  vee: 'M34 100 L16 80 Q14 72 24 72 L76 72 Q86 72 84 80 L66 100 Z',
};

function HatShape({ hat, paint, trim }: { hat: Hat; paint: string; trim: string }) {
  switch (hat) {
    case 'crown':
      return <Path d="M30 27 L28 9 L39 19 L50 6 L61 19 L72 9 L70 27 Z" fill="#f2c14e" stroke={trim} strokeWidth={2} strokeLinejoin="round" />;
    case 'wizard':
      return (
        <G>
          <Path d="M50 1 L66 25 L34 25 Z" fill={paint} stroke={trim} strokeWidth={2} strokeLinejoin="round" />
          <Rect x={22} y={23} width={56} height={6} rx={3} fill={paint} stroke={trim} strokeWidth={2} />
          <Circle cx={51} cy={15} r={2.6} fill="#f2c14e" />
        </G>
      );
    case 'beret':
      return (
        <G>
          <Ellipse cx={47} cy={22} rx={27} ry={8.5} fill={paint} stroke={trim} strokeWidth={2} />
          <Rect x={46} y={9} width={4} height={6} rx={2} fill={trim} />
        </G>
      );
    case 'feelers':
      return (
        <G stroke={trim} strokeWidth={2.4} strokeLinecap="round">
          <Line x1={40} y1={27} x2={33} y2={11} />
          <Line x1={60} y1={27} x2={67} y2={11} />
          <Circle cx={33} cy={9} r={4} fill={paint} />
          <Circle cx={67} cy={9} r={4} fill={paint} />
        </G>
      );
    case 'hardhat':
      return (
        <G>
          <Path d="M27 27 Q27 8 50 8 Q73 8 73 27 Z" fill="#f3b94c" stroke={trim} strokeWidth={2} strokeLinejoin="round" />
          <Rect x={20} y={24} width={60} height={6} rx={3} fill="#f3b94c" stroke={trim} strokeWidth={2} />
          <Rect x={47} y={9} width={6} height={15} rx={2} fill={trim} opacity={0.35} />
        </G>
      );
    case 'cog':
      return (
        <G>
          {[-52, -26, 0, 26, 52].map((turn) => (
            <Rect key={turn} x={46} y={3} width={8} height={10} rx={2} fill="#9aa5b1" stroke={trim} strokeWidth={1.6} transform={`rotate(${turn} 50 28)`} />
          ))}
          <Path d="M29 28 Q29 9 50 9 Q71 9 71 28 Z" fill="#9aa5b1" stroke={trim} strokeWidth={2} strokeLinejoin="round" />
          <Circle cx={50} cy={21} r={4.5} fill={trim} opacity={0.4} />
        </G>
      );
    case 'headphones':
      return (
        <G>
          <Path d="M21 44 Q21 12 50 12 Q79 12 79 44" fill="none" stroke={trim} strokeWidth={5} strokeLinecap="round" />
          <Rect x={14} y={38} width={11} height={19} rx={4.5} fill={paint} stroke={trim} strokeWidth={2} />
          <Rect x={75} y={38} width={11} height={19} rx={4.5} fill={paint} stroke={trim} strokeWidth={2} />
        </G>
      );
    case 'tophat':
      return (
        <G>
          <Rect x={34} y={3} width={32} height={22} rx={3} fill={trim} />
          <Rect x={34} y={17} width={32} height={5} fill={paint} />
          <Rect x={24} y={23} width={52} height={6} rx={3} fill={trim} />
        </G>
      );
    default:
      return (
        <G stroke={trim} strokeWidth={2.4} strokeLinecap="round">
          <Line x1={50} y1={27} x2={50} y2={12} />
          <Circle cx={50} cy={9} r={4.2} fill={paint} />
        </G>
      );
  }
}

/** One piece of gear, the first the look names that the phone can draw. */
function Gear({ gear, trim, light }: { gear: string[]; trim: string; light: string }) {
  const first = gear.find((name) => ['sash', 'cape', 'toolbelt', 'bowtie', 'magnifier', 'satchel', 'wrench'].includes(name));
  switch (first) {
    case 'sash':
      return <Path d="M33 74 L41 73 L70 100 L58 100 Z" fill="#f2c14e" stroke={trim} strokeWidth={1.6} strokeLinejoin="round" />;
    case 'cape':
      return <Path d="M36 72 L50 84 L64 72 L60 70 L50 77 L40 70 Z" fill={light} stroke={trim} strokeWidth={1.6} strokeLinejoin="round" />;
    case 'toolbelt':
      return (
        <G>
          <Rect x={14} y={89} width={72} height={7} fill={trim} opacity={0.75} />
          <Rect x={45} y={87.5} width={10} height={10} rx={2} fill="#f2c14e" stroke={trim} strokeWidth={1.4} />
        </G>
      );
    case 'bowtie':
      return <Path d="M40 73 L50 78 L60 73 L60 84 L50 79 L40 84 Z" fill={light} stroke={trim} strokeWidth={1.6} strokeLinejoin="round" />;
    case 'magnifier':
      return (
        <G stroke={trim} strokeLinecap="round">
          <Line x1={62} y1={90} x2={69} y2={97} strokeWidth={3.4} />
          <Circle cx={57} cy={85} r={6.5} fill={light} strokeWidth={2.2} />
        </G>
      );
    case 'satchel':
      return (
        <G>
          <Line x1={38} y1={73} x2={62} y2={96} stroke={trim} strokeWidth={3} />
          <Rect x={54} y={86} width={15} height={12} rx={2.5} fill={light} stroke={trim} strokeWidth={1.6} />
        </G>
      );
    case 'wrench':
      return (
        <G stroke={trim} strokeLinecap="round">
          <Line x1={45} y1={95} x2={56} y2={84} strokeWidth={4} />
          <Circle cx={58.5} cy={81.5} r={5} fill="none" strokeWidth={2.6} />
        </G>
      );
    default:
      return null;
  }
}

/** The eyes say the state: open, wide at work, half shut while waiting, set hard when blocked, out when off. */
function Eyes({ state, ink }: { state: BotState; ink: string }) {
  if (state === 'off') return <Line x1={40} y1={EYE_Y} x2={60} y2={EYE_Y} stroke={ink} strokeWidth={2.4} strokeLinecap="round" opacity={0.45} />;
  return (
    <G>
      {EYES.map((x, side) => {
        if (state === 'working') return <Rect key={x} x={x - 4} y={EYE_Y - 7.5} width={8} height={13} rx={3.6} fill={ink} />;
        if (state === 'waiting') return <Rect key={x} x={x - 5.5} y={EYE_Y - 1.6} width={11} height={3.6} rx={1.8} fill={ink} />;
        if (state === 'blocked') {
          const lean = side === 0 ? 1 : -1;
          return <Line key={x} x1={x - 5 * lean} y1={EYE_Y - 4} x2={x + 5 * lean} y2={EYE_Y + 1.5} stroke={ink} strokeWidth={3.6} strokeLinecap="round" />;
        }
        return <Circle key={x} cx={x} cy={EYE_Y - 1} r={4.6} fill={ink} />;
      })}
      {state === 'working' ? [42, 50, 58].map((x) => <Rect key={x} x={x - 2} y={55.5} width={4} height={2.4} rx={1.2} fill={ink} opacity={0.75} />) : null}
    </G>
  );
}

/** The painted tag at the corner: green at work, amber waiting, hazard stripes when blocked, grey when off. */
function Tag({ state, good, warn, bad, off, edge }: { state: BotState; good: string; warn: string; bad: string; off: string; edge: string }) {
  if (state === 'free') return null;
  const paint = state === 'working' ? good : state === 'waiting' ? warn : state === 'blocked' ? '#f2c14e' : off;
  const mark = inkOn(paint);
  return (
    <G>
      <Defs>
        <ClipPath id="tag"><Rect x={62} y={66} width={36} height={32} rx={8} /></ClipPath>
      </Defs>
      <Rect x={62} y={66} width={36} height={32} rx={8} fill={paint} />
      {state === 'blocked' ? (
        <G clipPath="url(#tag)">
          {[58, 72, 86, 100].map((x) => <Path key={x} d={`M${x} 100 L${x + 16} 64 L${x + 23} 64 L${x + 7} 100 Z`} fill="#15191f" />)}
        </G>
      ) : null}
      <Rect x={62} y={66} width={36} height={32} rx={8} fill="none" stroke={edge} strokeWidth={3} />
      {state === 'working' ? <Path d="M75 74 L88 82 L75 90 Z" fill={mark} /> : null}
      {state === 'waiting' ? <G fill={mark}><Rect x={73} y={74} width={5} height={16} rx={2} /><Rect x={82} y={74} width={5} height={16} rx={2} /></G> : null}
      {state === 'blocked' ? <G><Circle cx={80} cy={82} r={9} fill="#15191f" /><Rect x={78.4} y={75.5} width={3.2} height={8.5} rx={1.6} fill={bad} /><Circle cx={80} cy={87.6} r={1.9} fill={bad} /></G> : null}
      {state === 'off' ? <Rect x={72} y={80} width={16} height={4} rx={2} fill={mark} /> : null}
    </G>
  );
}

type Props = {
  who: Portrait;
  size: number;
  /** Shows this state in place of the bot's own, for a moment the screen knows better (it is answering now). */
  state?: BotState;
  /** The corner tag. On by default from 30 points up; a row that already says the state in words turns it off. */
  tag?: boolean;
};

export const BotBadge = memo(function BotBadge({ who, size, state, tag }: Props) {
  const { t } = useLook();
  const now = state ?? who.state;
  const showTag = (tag ?? size >= 30) && now !== 'free';
  // The plate is the suit colour, deepened by night and lightened by day; the robot is the colour itself.
  const plate = mix(who.colour, t.dark ? '#05070a' : '#ffffff', t.dark ? 0.62 : 0.68);
  const trim = mix(who.colour, '#05070a', 0.62);
  const light = mix(who.colour, '#ffffff', 0.55);
  const lit = who.screen === 'light';
  const screen = lit ? '#f4f1ea' : '#0d1117';
  const eyes = lit ? '#15191f' : mix(who.colour, '#ffffff', 0.6);
  const round = who.photo ? who.frame === 'round' : false;
  const label = `${who.name}, ${STATE_WORDS[now].toLowerCase()}`;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, opacity: now === 'off' ? 0.62 : 1 }}>
      {who.photo ? (
        <Image source={{ uri: who.photo, headers: who.photoHeaders }} style={[StyleSheet.absoluteFill, { borderColor: trim, borderRadius: round ? size / 2 : size * 0.16, borderWidth: Math.max(1, size * 0.03) }]} resizeMode="cover" />
      ) : null}
      <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        {who.photo ? null : (
          <G>
            <Rect x={1.5} y={1.5} width={97} height={97} rx={16} fill={plate} stroke={trim} strokeWidth={3} />
            <Defs>
              <ClipPath id="plate"><Rect x={3} y={3} width={94} height={94} rx={14.5} /></ClipPath>
            </Defs>
            <G clipPath="url(#plate)">
              <Path d={BODY[who.build]} fill={who.colour} stroke={trim} strokeWidth={2.2} strokeLinejoin="round" />
              <Gear gear={who.gear} trim={trim} light={light} />
            </G>
            <Rect x={44} y={64} width={12} height={10} fill={trim} />
            <HatShape hat={who.hat} paint={light} trim={trim} />
            <Rect x={HEAD.x} y={HEAD.y} width={HEAD.w} height={HEAD.h} rx={HEAD.r} fill={who.colour} stroke={trim} strokeWidth={2.4} />
            <Rect x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} rx={SCREEN.r} fill={screen} />
            <Eyes state={now} ink={eyes} />
          </G>
        )}
        {showTag ? <Tag state={now} good={t.good} warn={t.warn} bad={t.bad} off={t.ink3} edge={t.app} /> : null}
      </Svg>
    </View>
  );
});
