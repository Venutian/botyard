import { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import { shiftHue } from '../theme/color';
import { useLook, WallpaperId } from '../theme/prefs';

export const WALLPAPER_NAMES: Record<WallpaperId, string> = {
  none: 'Plain',
  dots: 'Dots',
  grid: 'Grid',
  plus: 'Plus',
  diagonal: 'Stripes',
  waves: 'Waves',
  stars: 'Stars',
  confetti: 'Confetti',
  aurora: 'Aurora',
  sunset: 'Sunset',
  tide: 'Tide',
};

function Tile({ id, ink, accent }: { id: WallpaperId; ink: string; accent: string }): ReactNode {
  switch (id) {
    case 'dots':
      return <Pattern id={`tile-${id}`} width={22} height={22} patternUnits="userSpaceOnUse"><Circle cx={11} cy={11} r={1.7} fill={ink} /></Pattern>;
    case 'grid':
      return <Pattern id={`tile-${id}`} width={34} height={34} patternUnits="userSpaceOnUse"><Path d="M34 0H0V34" stroke={ink} strokeWidth={1} fill="none" /></Pattern>;
    case 'plus':
      return <Pattern id={`tile-${id}`} width={38} height={38} patternUnits="userSpaceOnUse"><Path d="M19 13v12M13 19h12" stroke={ink} strokeWidth={1.8} strokeLinecap="round" /></Pattern>;
    case 'diagonal':
      return <Pattern id={`tile-${id}`} width={18} height={18} patternUnits="userSpaceOnUse"><Line x1={-2} y1={20} x2={20} y2={-2} stroke={ink} strokeWidth={1.4} /></Pattern>;
    case 'waves':
      return <Pattern id={`tile-${id}`} width={72} height={26} patternUnits="userSpaceOnUse"><Path d="M0 13c12-12 24-12 36 0s24 12 36 0" stroke={ink} strokeWidth={1.6} fill="none" /></Pattern>;
    case 'stars':
      return (
        <Pattern id={`tile-${id}`} width={130} height={130} patternUnits="userSpaceOnUse">
          <Path d="M30 22l2 7 7 2-7 2-2 7-2-7-7-2 7-2z" fill={ink} />
          <Path d="M100 86l1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5z" fill={ink} />
          <Circle cx={78} cy={30} r={1.6} fill={ink} />
          <Circle cx={22} cy={100} r={1.2} fill={ink} />
          <Circle cx={118} cy={20} r={1} fill={ink} />
          <Circle cx={60} cy={70} r={1.4} fill={ink} />
        </Pattern>
      );
    case 'confetti':
      return (
        <Pattern id={`tile-${id}`} width={92} height={92} patternUnits="userSpaceOnUse">
          <Rect x={14} y={12} width={12} height={4} rx={2} fill={accent} transform="rotate(32 20 14)" />
          <Rect x={62} y={22} width={12} height={4} rx={2} fill={ink} transform="rotate(-24 68 24)" />
          <Rect x={34} y={58} width={12} height={4} rx={2} fill={ink} transform="rotate(70 40 60)" />
          <Rect x={72} y={70} width={12} height={4} rx={2} fill={accent} transform="rotate(12 78 72)" />
          <Circle cx={12} cy={72} r={2.6} fill={accent} />
          <Circle cx={50} cy={32} r={2.2} fill={ink} />
        </Pattern>
      );
    default:
      return null;
  }
}

/** Fills its parent behind a screen. `strength` runs from barely there at 0 to loud at 1. */
export function Wallpaper({ id, strength }: { id: WallpaperId; strength?: number }) {
  const { p, t } = useLook();
  if (id === 'none') return null;
  const amount = strength ?? p.wallpaperStrength;
  const second = shiftHue(t.accent, 70);
  const third = shiftHue(t.accent, -60);

  if (id === 'aurora') {
    return (
      <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill} opacity={0.2 + amount * 0.7}>
        <Defs>
          <RadialGradient id="a1" cx="18%" cy="12%" r="70%"><Stop offset="0" stopColor={t.accent} /><Stop offset="1" stopColor={t.accent} stopOpacity={0} /></RadialGradient>
          <RadialGradient id="a2" cx="92%" cy="48%" r="62%"><Stop offset="0" stopColor={second} /><Stop offset="1" stopColor={second} stopOpacity={0} /></RadialGradient>
          <RadialGradient id="a3" cx="24%" cy="96%" r="66%"><Stop offset="0" stopColor={third} /><Stop offset="1" stopColor={third} stopOpacity={0} /></RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#a1)" />
        <Rect width="100%" height="100%" fill="url(#a2)" />
        <Rect width="100%" height="100%" fill="url(#a3)" />
      </Svg>
    );
  }

  if (id === 'sunset' || id === 'tide') {
    const stops = id === 'sunset' ? ['#ff5f6d', '#ffc371', '#7a3e9d'] : ['#0ea5c6', '#377fe6', '#01a492'];
    return (
      <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill} opacity={0.15 + amount * 0.7}>
        <Defs>
          <LinearGradient id={`sky-${id}`} x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={stops[0]} />
            <Stop offset="0.5" stopColor={stops[1]} />
            <Stop offset="1" stopColor={stops[2]} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#sky-${id})`} />
      </Svg>
    );
  }

  return (
    <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill} opacity={0.05 + amount * 0.36}>
      <Defs><Tile id={id} ink={t.ink} accent={t.accent} /></Defs>
      <Rect width="100%" height="100%" fill={`url(#tile-${id})`} />
    </Svg>
  );
}
