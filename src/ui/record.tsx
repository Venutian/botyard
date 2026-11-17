import { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLook } from '../theme/prefs';
import { styles as kit, Txt } from './kit';

/** One labelled number or word: the label over the value, the unit in the value, a small line under it. */
export type Fact = { label: string; value: string; sub?: string; node?: ReactNode };

/**
 * The few facts that decide a record, two to a row on a phone: a label over each value, so no number is
 * ever bare. A fact with nothing worked out is left out by the caller, never shown as a dash.
 */
export function Facts({ items }: { items: Fact[] }) {
  const { t } = useLook();
  if (!items.length) return null;
  return (
    <View style={styles.facts}>
      {items.map((f) => (
        <View key={f.label} style={styles.fact} accessible accessibilityLabel={`${f.label}: ${f.value}${f.sub ? `, ${f.sub}` : ''}`}>
          <Txt size={12} color={t.ink2}>{f.label}</Txt>
          {f.node ?? <Txt size={15} weight={700}>{f.value}</Txt>}
          {f.sub ? <Txt size={12} color={t.ink3}>{f.sub}</Txt> : null}
        </View>
      ))}
    </View>
  );
}

/** Long notes as labelled lines, shown when a record is opened. */
export function Notes({ items }: { items: { label: string; text: string }[] }) {
  const { t } = useLook();
  if (!items.length) return null;
  return (
    <View style={styles.notes}>
      {items.map((n) => (
        <View key={n.label} style={styles.note}>
          <Txt size={13} weight={700} color={t.ink2}>{n.label}</Txt>
          <Txt size={14}>{n.text}</Txt>
        </View>
      ))}
    </View>
  );
}

/**
 * A record to decide on (a finding, an idea), as a plate of its own: the title and a two-line summary, the
 * decision on the right (`right`), the labelled facts under them (outside the tap area, so a fact may hold a button), then `face` (what must stay in reach, such
 * as the buttons of a finding that waits for the owner). The long notes and the rest of the buttons
 * (`details`) open under it with Details, the same as on the PC.
 */
export function RecordCard({ title, line, badge, right, facts, face, details, open, onToggle, dim }: {
  title: string; line?: string; badge?: ReactNode; right?: ReactNode; facts?: Fact[]; face?: ReactNode; details?: ReactNode;
  open: boolean; onToggle: () => void; dim?: boolean;
}) {
  const { t } = useLook();
  const edge = t.outline ? (t.plates && t.dark ? '#05070a' : t.ink) : t.line;
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: edge, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth, borderRadius: Math.min(t.r.card, 12), boxShadow: t.shadow }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={open ? 'Hides the details' : 'Shows the details'} onPress={onToggle} style={({ pressed }) => [styles.head, pressed && kit.dim]}>
        <View style={styles.top}>
          <View style={styles.flex}>
            {badge}
            <Txt size={16} weight={dim ? 600 : 700} accessibilityRole="header">{title}</Txt>
            {line ? <Txt size={13} color={t.ink2} numberOfLines={open ? undefined : 2}>{line}</Txt> : null}
          </View>
          {right ? <View style={styles.right}>{right}</View> : null}
        </View>
      </Pressable>
      {facts?.length ? <View style={styles.factsBox}><Facts items={facts} /></View> : null}
      {face ? <View style={styles.face}>{face}</View> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? 'Hide details' : 'Details'} on ${title}`} onPress={onToggle}
        style={({ pressed }) => [styles.toggle, { borderTopColor: t.line }, pressed && kit.dim]}>
        <Txt size={14} weight={700} color={t.ink2}>{open ? 'Hide details  ▴' : 'Details  ▾'}</Txt>
      </Pressable>
      {open && details ? <View style={[styles.details, { borderTopColor: edge }]}>{details}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
  head: { gap: 12, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 10 },
  factsBox: { paddingBottom: 12, paddingHorizontal: 14 },
  top: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  flex: { flex: 1, gap: 4, minWidth: 0 },
  right: { alignItems: 'flex-end', gap: 6, maxWidth: 120 },
  facts: { columnGap: 14, flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  fact: { flexBasis: '45%', flexGrow: 1, minWidth: 0 },
  face: { gap: 8, paddingBottom: 12, paddingHorizontal: 14 },
  toggle: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 44 },
  details: { borderTopWidth: 2, gap: 12, padding: 14 },
  notes: { gap: 10 },
  note: { gap: 2 },
});
