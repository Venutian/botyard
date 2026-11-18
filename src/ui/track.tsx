/** A track drawn, as on the PC page: a box a step, top to bottom; a pass down the middle, a skip down the right, a failed check's way back up the left, dashed, with its rounds. Still: no motion. */
import Svg, { Defs, G, Marker, Path, Rect, Text as SvgText } from 'react-native-svg';
import { TrackLine, TrackStep } from '../api';
import { useLook } from '../theme/prefs';

const KIND: Record<string, string> = { bot: 'Bot', script: 'Script', gate: 'You', track: 'Track' };

export function TrackDrawing({ steps, lines, states = {}, current = '', title }: { steps: TrackStep[]; lines: TrackLine[]; states?: Record<string, string>; current?: string; title: string }) {
  const { t } = useLook();
  const W = 360;
  const H = 46;
  const GAP = 26;
  const top = 12;
  const x0 = 78;
  const x1 = W - 78;
  const y = (i: number) => top + i * (H + GAP);
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const height = y(Math.max(0, steps.length - 1)) + H + top;
  let right = 0;
  let left = 0;
  const edge = (state: string, id: string) => (id === current ? t.accent : state === 'passed' ? t.good : state === 'failed' ? t.bad : state === 'working' || state === 'waiting' ? t.warn : t.edge);
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} accessibilityLabel={`${title}: ${steps.map((s) => s.title || s.id).join(', then ')}`}>
      <Defs>
        <Marker id="tk-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><Path d="M0 0 8 4 0 8z" fill={t.ink3} /></Marker>
        <Marker id="tk-b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><Path d="M0 0 8 4 0 8z" fill={t.bad} /></Marker>
      </Defs>
      {lines.map((line, n) => {
        const a = index.get(line.from);
        const b = index.get(line.to);
        if (a === undefined || b === undefined) return null;
        const fail = line.on === 'fail';
        if (b === a + 1 && !fail) return <Path key={n} d={`M${W / 2} ${y(a) + H} V${y(b) - 3}`} stroke={t.ink3} strokeWidth={1.6} fill="none" markerEnd="url(#tk-a)" />;
        if (b > a) {
          const x = x1 + 12 + (right++ % 4) * 11;
          return <Path key={n} d={`M${x1} ${y(a) + H * 0.62} H${x} V${y(b) + H * 0.38} H${x1 + 3}`} stroke={fail ? t.warn : t.ink3} strokeWidth={1.6} fill="none" markerEnd="url(#tk-a)" />;
        }
        const x = x0 - 12 - (left++ % 4) * 11;
        return (
          <G key={n}>
            <Path d={`M${x0} ${y(a) + H * 0.62} H${x} V${y(b) + H * 0.38} H${x0 - 3}`} stroke={t.bad} strokeWidth={1.6} strokeDasharray="4 3" fill="none" markerEnd="url(#tk-b)" />
            {line.rounds ? <SvgText x={x - 4} y={(y(a) + y(b) + H) / 2} fill={t.bad} fontSize={12} fontWeight="700" textAnchor="end">{`×${line.rounds}`}</SvgText> : null}
          </G>
        );
      })}
      {steps.map((s, i) => {
        const state = states[s.id] || '';
        const name = s.title || s.id;
        return (
          <G key={s.id}>
            <Rect x={x0} y={y(i)} width={x1 - x0} height={H} rx={9} fill={s.kind === 'script' ? t.panel : t.card} stroke={edge(state, s.id)} strokeWidth={s.id === current ? 3 : state ? 2 : 1.5} strokeDasharray={s.kind === 'gate' ? '5 3' : undefined} />
            <SvgText x={x0 + 12} y={y(i) + 17} fill={t.ink3} fontSize={12}>{`${KIND[s.kind] || s.kind}${s.ruling ? ', ruling' : ''}`}</SvgText>
            <SvgText x={x0 + 12} y={y(i) + 35} fill={state === 'not-started' ? t.ink3 : t.ink} fontSize={14} fontWeight="600">{name.length > 30 ? `${name.slice(0, 29)}…` : name}</SvgText>
          </G>
        );
      })}
    </Svg>
  );
}
