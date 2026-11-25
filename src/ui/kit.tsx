import * as Haptics from 'expo-haptics';
import { ReactNode, Ref, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextProps,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, Pattern, Rect, Stop } from 'react-native-svg';
import { hexToHue, hsl, inkOn, isHex } from '../theme/color';
import { Weight } from '../theme/fonts';
import { useLook } from '../theme/prefs';
import { DESCRIBE } from './describe';
import { Icon, IconName } from './Icon';

/** Browsers ring a focused field. The app has no such ring on a phone, so the PC build drops it too. */
export const plainField = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as object;

export function useTap() {
  const { p } = useLook();
  return useCallback((kind: 'select' | 'light' | 'done' = 'select') => {
    if (!p.haptics || Platform.OS === 'web') return;
    if (kind === 'select') Haptics.selectionAsync().catch(() => undefined);
    if (kind === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (kind === 'done') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }, [p.haptics]);
}

export function Txt({ size = 15, weight = 400, color, style, ...rest }: TextProps & { size?: number; weight?: Weight; color?: string }) {
  const { t, font } = useLook();
  return <Text {...rest} style={[{ color: color ?? t.ink, fontSize: size, lineHeight: Math.round(size * 1.38) }, font(weight), style]} />;
}

export function Title({ children }: { children: ReactNode }) {
  const { t, sign } = useLook();
  // A plate's title is a sign: taller, tighter, in the sign face.
  if (t.plates) return <Txt accessibilityRole="header" size={40} weight={700} style={[styles.signTitle, sign()]}>{children}</Txt>;
  return <Txt accessibilityRole="header" size={32} weight={700} style={styles.title}>{children}</Txt>;
}

/** A name, a job code or a short heading in the sign face (the bold body font outside Plates). */
export function Sign({ size = 20, color, style, ...rest }: TextProps & { size?: number; color?: string }) {
  const { t, sign } = useLook();
  return <Text {...rest} style={[{ color: color ?? t.ink, fontSize: size, lineHeight: Math.round(size * (t.plates ? 1.08 : 1.3)) }, sign(), style]} />;
}

export function Label({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { t } = useLook();
  return <View style={[styles.label, style]}><Txt accessibilityRole="header" size={14} weight={600} color={t.ink2}>{children}</Txt></View>;
}

/** An icon on its own: its label names it, its hint says what pressing it does. */
export function GlassButton({ icon, label, onPress, size = 44, hint, dot }: { icon: IconName; label: string; onPress: () => void; size?: number; hint?: string; /** A small mark in the corner: something new behind it. */ dot?: boolean }) {
  const { t } = useLook();
  const tap = useTap();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        styles.center,
        { width: size, height: size, borderRadius: t.plates ? t.r.button : size / 2, backgroundColor: t.plates ? t.card : t.glass, borderWidth: t.outline ? 2 : 0, borderColor: t.plates && t.dark ? '#05070a' : t.ink, boxShadow: t.plates ? t.shadow : undefined },
        pressed && (t.plates ? styles.down : styles.pressed),
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.48)} color={t.ink} />
      {dot ? <View style={[styles.dot, { backgroundColor: t.accent, borderColor: t.card }]} /> : null}
    </Pressable>
  );
}

/** A button. `hint` is a short line that says what pressing it does, written under it so a phone shows it too. */
export function Button({ label, onPress, kind = 'primary', busy, disabled, icon, hint }: { label: string; onPress: () => void; kind?: 'primary' | 'quiet' | 'danger'; busy?: boolean; disabled?: boolean; icon?: IconName; hint?: string }) {
  const { p, t } = useLook();
  const tap = useTap();
  const ink = kind === 'primary' ? t.accentInk : kind === 'danger' ? t.bad : t.ink;
  const press = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(busy || disabled), busy: Boolean(busy) }}
      disabled={busy || disabled}
      onPress={() => {
        tap('light');
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { borderRadius: t.r.button },
        kind === 'primary' && { backgroundColor: t.accent, boxShadow: t.shadow },
        kind === 'quiet' && { backgroundColor: t.plates ? t.card : t.control, boxShadow: t.plates ? t.shadow : undefined },
        kind === 'danger' && { borderColor: t.bad, borderWidth: t.hair },
        t.outline && kind !== 'danger' && { borderColor: t.plates && t.dark ? '#05070a' : t.ink, borderWidth: 2 },
        // A plate's button is a key: it goes down when pressed.
        pressed && t.plates && kind !== 'danger' && styles.keyDown,
        (busy || disabled || (pressed && !t.plates)) && styles.dim,
      ]}
    >
      {busy ? <ActivityIndicator color={ink} /> : (
        <>
          {icon ? <Icon name={icon} size={18} color={ink} /> : null}
          <Txt size={15} weight={700} color={ink}>{label}</Txt>
        </>
      )}
    </Pressable>
  );
  return hint && p.explain ? <View style={styles.hinted}>{press}<Txt size={13} color={t.ink2}>{hint}</Txt></View> : press;
}

/** A grouped card of settings rows, with a line between them. */
export function Group({ children }: { children: ReactNode }) {
  const { t } = useLook();
  return <View style={[styles.group, { borderRadius: t.r.card, backgroundColor: t.card, borderColor: t.outline ? (t.plates && t.dark ? '#05070a' : t.ink) : 'transparent', borderWidth: t.outline ? 2 : 0, boxShadow: t.shadow }]}>{children}</View>;
}

export function Row({ title, detail, right, onPress, last, children }: { title: string; detail?: string; right?: ReactNode; onPress?: () => void; last?: boolean; children?: ReactNode }) {
  const { t } = useLook();
  const body = (
    <View style={[styles.row, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.rowHead}>
        <View style={styles.flex}>
          <Txt size={15} weight={600}>{title}</Txt>
          {detail ? <Txt size={13} color={t.ink2}>{detail}</Txt> : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && styles.dim}>{body}</Pressable> : body;
}

export function Toggle({ value, onChange, label, hint }: { value: boolean; onChange: (next: boolean) => void; label: string; hint?: string }) {
  const { t } = useLook();
  const tap = useTap();
  const travel = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(travel, { toValue: value ? 1 : 0, useNativeDriver: Platform.OS !== 'web', speed: 24, bounciness: 6 }).start();
  }, [value, travel]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value }}
      onPress={() => {
        tap();
        onChange(!value);
      }}
      hitSlop={8}
      style={[styles.track, { backgroundColor: value ? t.accent : t.edge, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}
    >
      <Animated.View style={[styles.knob, { transform: [{ translateX: travel.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] }]} />
    </Pressable>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; name: string }[]; onChange: (next: T) => void }) {
  const { t } = useLook();
  const tap = useTap();
  return (
    <View style={[styles.segments, { backgroundColor: t.control, borderRadius: t.plates ? t.r.button : 12 }]}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            hitSlop={{ top: 3, bottom: 3 }}
            onPress={() => {
              tap();
              onChange(option.id);
            }}
            style={[styles.segment, t.plates && { borderRadius: t.r.chip }, active && { backgroundColor: t.plates ? t.ink : t.app, borderColor: t.outline ? t.ink : 'transparent', borderWidth: t.outline ? 2 : 0 }]}
          >
            <Txt size={13} weight={600} color={active ? (t.plates ? t.card : t.ink) : t.ink2} numberOfLines={1}>{option.name}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A row of filter chips. `hints` says in a short line what each chip shows; the chosen chip's line is written under
 * the row, so a phone (which has no hover) never leaves a filter unexplained.
 */
export function Chips<T extends string>({ value, options, onChange, styleFor, hints }: { value: T; options: { id: T; name: string }[]; onChange: (next: T) => void; styleFor?: (id: T) => object; hints?: Partial<Record<T, string>> }) {
  const { p, t } = useLook();
  const tap = useTap();
  const said = p.explain ? hints?.[value] : undefined;
  const row = (
    <View style={styles.chips}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityHint={hints?.[option.id]}
            accessibilityState={{ selected: active }}
            hitSlop={{ top: 2, bottom: 2 }}
            onPress={() => {
              tap();
              onChange(option.id);
            }}
            style={[styles.chip, { borderRadius: t.r.chip, backgroundColor: active ? t.accent : t.plates ? t.card : t.control, borderColor: active ? t.accent : t.line, borderWidth: StyleSheet.hairlineWidth }]}
          >
            <Txt size={13} weight={600} color={active ? t.accentInk : t.ink} style={styleFor?.(option.id)}>{option.name}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
  return said ? <View style={styles.chipsBox}>{row}<Txt size={13} color={t.ink2}>{said}</Txt></View> : row;
}

/** Anything pressable with its description written under it: a phone has no hover, so the words stay on screen. */
export function Hinted({ hint, children }: { hint: string; children: ReactNode }) {
  const { p, t } = useLook();
  if (!p.explain) return <>{children}</>;
  return (
    <View style={styles.hintedFit}>
      {children}
      <Txt size={13} color={t.ink2}>{hint}</Txt>
    </View>
  );
}

/**
 * "What these words mean": a fold that lists the status words on the screen, each with its description from
 * describe.ts. A phone has no hover, so this is where a tag such as Checking or Blocked is explained. Only the
 * words given are listed; a word with no description is skipped, and a fold with nothing to say is not drawn.
 */
export function Words({ words, from = DESCRIBE.status, title = 'What these words mean' }: { words: string[]; from?: Record<string, string>; title?: string }) {
  const { t } = useLook();
  const [open, setOpen] = useState(false);
  const lines = [...new Set(words)].filter((w) => from[w]);
  if (!lines.length) return null;
  return (
    <View style={styles.words}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={open ? 'Hides the list' : 'Shows what each word means'} hitSlop={8} onPress={() => setOpen(!open)} style={({ pressed }) => [styles.wordsHead, pressed && styles.dim]}>
        <Txt size={13} weight={600} color={t.ink2}>{`${title}  ${open ? '▴' : '▾'}`}</Txt>
      </Pressable>
      {open ? lines.map((w) => <Txt key={w} size={13} color={t.ink2}>{from[w]}</Txt>) : null}
    </View>
  );
}

const THUMB = 26;

export function Slider({ value, min, max, onChange, label, track }: { value: number; min: number; max: number; onChange: (next: number) => void; label: string; track?: ReactNode }) {
  const { t } = useLook();
  const [width, setWidth] = useState(0);
  const live = useRef({ width: 0, start: 0, onChange, min, max });
  live.current = { ...live.current, width, onChange, min, max };

  const move = (x: number) => {
    const { width: w, min: lo, max: hi, onChange: change } = live.current;
    if (!w) return;
    const share = Math.min(1, Math.max(0, (x - THUMB / 2) / (w - THUMB)));
    change(lo + share * (hi - lo));
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // The settings list must not take the drag away and scroll instead.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      live.current.start = event.nativeEvent.locationX;
      move(live.current.start);
    },
    onPanResponderMove: (_, gesture) => move(live.current.start + gesture.dx),
  })).current;

  const share = (value - min) / (max - min);
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: Math.round(value * 100) / 100 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.slider}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={[styles.sliderTrack, { backgroundColor: t.control }]}>
        {track ?? <View style={{ backgroundColor: t.accent, height: '100%', width: `${share * 100}%` }} />}
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: share * Math.max(0, width - THUMB), borderColor: t.edge }]} />
    </View>
  );
}

function HueTrack() {
  const hues = [0, 60, 120, 180, 240, 300, 360];
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id="hues" x1="0" y1="0" x2="1" y2="0">
          {hues.map((h) => <Stop key={h} offset={h / 360} stopColor={hsl(h, 0.82, 0.56)} />)}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#hues)" />
    </Svg>
  );
}

/** Colour swatches with any custom colour by hue or hex code. `inherit` is the "use the default" swatch. */
export function ColorPicker({ value, palette, onChange, inherit }: { value: string | null; palette: string[]; onChange: (next: string | null) => void; inherit?: string }) {
  const { t, font } = useLook();
  const tap = useTap();
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const lower = value?.toLowerCase() ?? null;

  useEffect(() => setDraft(value ?? ''), [value]);

  const swatch = (color: string | null, key: string) => {
    const active = color === null ? lower === null : lower === color.toLowerCase();
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={color ?? inherit}
        hitSlop={3}
        accessibilityState={{ selected: active }}
        onPress={() => {
          tap();
          setCustom(false);
          onChange(color);
        }}
        style={[styles.swatch, { backgroundColor: color ?? t.control, borderColor: active ? t.ink : t.line }]}
      >
        {color === null ? <Icon name="reset" size={15} color={t.ink} /> : active ? <Icon name="check" size={15} color={inkOn(color)} weight={3} /> : null}
      </Pressable>
    );
  };

  return (
    <View style={styles.pickerGap}>
      <View style={styles.chips}>
        {inherit ? swatch(null, 'inherit') : null}
        {palette.map((color) => swatch(color, color))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Custom colour"
          accessibilityState={{ expanded: custom }}
          hitSlop={3}
          onPress={() => setCustom(!custom)}
          style={[styles.swatch, { backgroundColor: t.control, borderColor: custom ? t.ink : 'transparent' }]}
        >
          <Icon name="plus" size={16} color={t.ink} />
        </Pressable>
      </View>
      {custom ? (
        <View style={styles.pickerGap}>
          <Slider label="Hue" value={value ? hexToHue(value) : 200} min={0} max={359} onChange={(h) => onChange(hsl(h, 0.82, 0.56))} track={<HueTrack />} />
          <TextInput
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              const hex = text.startsWith('#') ? text : `#${text}`;
              if (isHex(hex)) onChange(hex.toLowerCase());
            }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={7}
            accessibilityLabel="Colour as a hex code"
            placeholder="#ff2e97"
            placeholderTextColor={t.ink3}
            style={[styles.field, font(400), { backgroundColor: t.control, color: t.ink, borderColor: t.edge, borderWidth: StyleSheet.hairlineWidth }]}
          />
        </View>
      ) : null}
    </View>
  );
}

export function Field({ label, tall, style, ref, ...rest }: TextInputProps & { label?: string; tall?: boolean; ref?: Ref<TextInput> }) {
  const { t, font } = useLook();
  return (
    <View style={styles.fieldWrap}>
      {label ? <Txt size={14} weight={600} color={t.ink2}>{label}</Txt> : null}
      <TextInput
        placeholderTextColor={t.ink3}
        textAlignVertical={tall ? 'top' : 'center'}
        accessibilityLabel={label ?? rest.placeholder}
        {...rest}
        ref={ref}
        style={[styles.field, font(400), { borderRadius: t.r.field, backgroundColor: t.card, color: t.ink, borderColor: t.edge, borderWidth: StyleSheet.hairlineWidth }, tall && styles.tall, style]}
      />
    </View>
  );
}

/** The strip along the top of a plate that needs the owner: yellow and ink, the workshop's own warning. */
export function Hazard() {
  const { t } = useLook();
  const ink = t.dark ? '#05070a' : '#15181d';
  return (
    <View style={[styles.hazard, { borderBottomColor: ink }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="hazard" width={18} height={18} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <Rect width={9} height={18} fill="#ffc61a" />
            <Rect x={9} width={9} height={18} fill="#15181d" />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#hazard)" />
      </Svg>
    </View>
  );
}

export function Sheet({ children, contentStyle }: { children: ReactNode; contentStyle?: StyleProp<ViewStyle> }) {
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={contentStyle}>{children}</ScrollView>;
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  pressed: { transform: [{ scale: 0.93 }] },
  down: { transform: [{ translateY: 2 }] },
  dot: { borderRadius: 6, borderWidth: 2, height: 12, position: 'absolute', right: -2, top: -2, width: 12 },
  keyDown: { transform: [{ scale: 0.97 }] },
  signTitle: { lineHeight: 42 },
  hazard: { borderBottomWidth: 2, height: 9, left: 0, position: 'absolute', right: 0, top: 0 },
  dim: { opacity: 0.6 },
  title: { letterSpacing: -0.6, lineHeight: 38 },
  label: { marginBottom: 8, marginLeft: 4, marginTop: 26 },
  button: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48, paddingHorizontal: 22 },
  group: { borderRadius: 18, overflow: 'hidden' },
  row: { gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  rowHead: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 28 },
  track: { borderRadius: 16, height: 30, justifyContent: 'center', paddingHorizontal: 2, width: 52 },
  knob: { backgroundColor: '#ffffff', borderRadius: 13, height: 26, width: 26 },
  segments: { borderRadius: 12, flexDirection: 'row', gap: 2, padding: 3 },
  segment: { alignItems: 'center', borderRadius: 9, flex: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipsBox: { gap: 6 },
  hinted: { gap: 4 },
  hintedFit: { alignSelf: 'flex-start', gap: 4 },
  words: { gap: 4 },
  wordsHead: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  chip: { borderRadius: 999, minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
  slider: { height: 44, justifyContent: 'center' },
  sliderTrack: { borderRadius: 7, height: 14, overflow: 'hidden' },
  thumb: { backgroundColor: '#ffffff', borderRadius: THUMB / 2, borderWidth: 1, height: THUMB, position: 'absolute', top: 9, width: THUMB },
  swatch: { alignItems: 'center', borderRadius: 20, borderWidth: 2, height: 44, justifyContent: 'center', width: 44 },
  pickerGap: { gap: 10 },
  fieldWrap: { gap: 6 },
  field: { borderRadius: 14, fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10 },
  tall: { minHeight: 130 },
});
