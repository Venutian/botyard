import { createContext, Fragment, ReactNode, useContext, useMemo } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { useLook } from '../theme/prefs';

/** Opens a job in the app by its reference (LH-42); the app's root gives it. */
export const JobLinks = createContext<((ref: string) => void) | null>(null);
// Bots link jobs by their place in the studio: [LH-42](/LH/issues/LH-42#comment-...).
const JOB_LINK = /^\/[A-Z]+\/issues\/([A-Z]+-\d+)/;

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; rows: string[][] };

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

function parse(source: string): Block[] {
  const lines = source.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
    } else if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i += 1;
      blocks.push({ kind: 'code', text: code.join('\n') });
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', rows });
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') });
      i += 1;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].replace(pattern, '$1'));
      blocks.push({ kind: 'list', ordered, items });
    } else {
      const text: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```)/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i]) && !TABLE_RULE.test(lines[i + 1] ?? '')) text.push(lines[i++]);
      if (!text.length) text.push(lines[i++]);
      blocks.push({ kind: 'text', text: text.join('\n') });
    }
  }
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:|\/)[^)]+\)|\*[^*\s][^*]*\*)/g;

function Inline({ text, ink, size }: { text: string; ink: string; size: number }) {
  const { t, font } = useLook();
  const openJob = useContext(JobLinks);
  const follow = (url: string) => {
    const job = JOB_LINK.exec(url);
    if (job && openJob) return openJob(job[1]);
    // A link inside the studio that is not a job has no page of its own in the app.
    if (url.startsWith('/')) return;
    Linking.openURL(url);
  };
  return (
    <>
      {text.split(INLINE).map((part, index) => {
        if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
        if (part.startsWith('**')) return <Text key={index} style={font(700)}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('`')) return <Text key={index} style={{ backgroundColor: t.control, fontFamily: 'monospace', fontSize: size * 0.9 }}>{part.slice(1, -1)}</Text>;
        if (part.startsWith('[')) {
          const [, label, url] = /\[([^\]]+)\]\(([^)]+)\)/.exec(part) ?? [];
          return <Text key={index} onPress={() => follow(url)} style={{ color: t.accentText, textDecorationLine: 'underline' }}>{label}</Text>;
        }
        return <Text key={index} style={{ fontStyle: 'italic', color: ink }}>{part.slice(1, -1)}</Text>;
      })}
    </>
  );
}

/** Bots answer in markdown, and the lead reports status as a table, so messages are drawn rather than shown raw. */
export function Markdown({ text, ink, size }: { text: string; ink: string; size: number }) {
  const { t, font } = useLook();
  const blocks = useMemo(() => parse(text), [text]);
  const body = { color: ink, fontSize: size, lineHeight: Math.round(size * 1.42), ...font(400) };

  const draw = (block: Block, index: number): ReactNode => {
    switch (block.kind) {
      case 'heading':
        return <Text key={index} selectable style={[body, font(700), { fontSize: size + 1 }]}><Inline text={block.text} ink={ink} size={size} /></Text>;
      case 'code':
        return (
          <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: t.control, borderRadius: 10 }}>
            <Text selectable style={{ color: ink, fontFamily: 'monospace', fontSize: size * 0.82, lineHeight: size * 1.25, padding: 10 }}>{block.text}</Text>
          </ScrollView>
        );
      case 'list':
        return (
          <View key={index} style={{ gap: 4 }}>
            {block.items.map((item, n) => (
              <View key={n} style={{ flexDirection: 'row', gap: 8 }}>
                <Text style={[body, { color: t.ink3 }]}>{block.ordered ? `${n + 1}.` : '•'}</Text>
                {/* Shrinks to fit but asks for its full width first: with `flex: 1` a list in a chat bubble took the
                    width of the shortest paragraph beside it, and long items wrapped into a thin column. */}
                <Text selectable style={[body, { flexShrink: 1 }]}><Inline text={item} ink={ink} size={size} /></Text>
              </View>
            ))}
          </View>
        );
      case 'table': {
        const columns = block.rows[0].length;
        // A column is as wide as its longest cell asks for, between 72 and 240: a fixed narrow column wrapped
        // every sentence into a few words a line.
        const widths = Array.from({ length: columns }, (_, c) => {
          const longest = Math.max(...block.rows.map((row) => (row[c] ?? '').replace(/[*`]/g, '').length));
          return Math.round(Math.min(240, Math.max(72, longest * size * 0.82 * 0.56 + 20)));
        });
        return (
          <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ borderColor: t.line, borderRadius: 10, borderWidth: 1, overflow: 'hidden' }}>
              {block.rows.map((row, r) => (
                <View key={r} style={{ backgroundColor: r === 0 ? t.control : 'transparent', borderTopColor: t.line, borderTopWidth: r ? 1 : 0, flexDirection: 'row' }}>
                  {Array.from({ length: columns }, (_, c) => (
                    <View key={c} style={{ borderLeftColor: t.line, borderLeftWidth: c ? 1 : 0, paddingHorizontal: 9, paddingVertical: 6, width: widths[c] }}>
                      <Text selectable style={[body, { fontSize: size * 0.82, lineHeight: size * 1.14 }, r === 0 && font(700)]}><Inline text={row[c] ?? ''} ink={ink} size={size * 0.82} /></Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      }
      default:
        return <Text key={index} selectable style={body}><Inline text={block.text} ink={ink} size={size} /></Text>;
    }
  };

  return <View style={{ gap: 8 }}>{blocks.map(draw)}</View>;
}
