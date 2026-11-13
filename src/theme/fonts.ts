import * as Font from 'expo-font';
import { Platform, TextStyle } from 'react-native';

export type Weight = 400 | 600 | 700;
export type FontId = 'system' | 'serif' | 'plex' | 'geist' | 'inter' | 'poppins' | 'jakarta' | 'space' | 'mono' | 'pixelify';
export type FontChoice = FontId | 'skin';

export const FONT_CHOICES: { id: FontChoice; name: string }[] = [
  { id: 'skin', name: 'Plates default' },
  { id: 'system', name: 'System' },
  { id: 'plex', name: 'IBM Plex Sans' },
  { id: 'geist', name: 'Geist' },
  { id: 'inter', name: 'Inter' },
  { id: 'poppins', name: 'Poppins' },
  { id: 'jakarta', name: 'Jakarta' },
  { id: 'space', name: 'Space Grotesk' },
  { id: 'mono', name: 'JetBrains Mono' },
  { id: 'pixelify', name: 'Pixelify' },
  { id: 'serif', name: 'Serif' },
];

// Each file is required by name so the build keeps only these three weights.
const FILES: Partial<Record<FontId, Record<Weight, number>>> = {
  plex: {
    400: require('@expo-google-fonts/ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf'),
    600: require('@expo-google-fonts/ibm-plex-sans/600SemiBold/IBMPlexSans_600SemiBold.ttf'),
    700: require('@expo-google-fonts/ibm-plex-sans/700Bold/IBMPlexSans_700Bold.ttf'),
  },
  geist: {
    400: require('@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf'),
    600: require('@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf'),
    700: require('@expo-google-fonts/geist/700Bold/Geist_700Bold.ttf'),
  },
  inter: {
    400: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    600: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
    700: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
  },
  poppins: {
    400: require('@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf'),
    600: require('@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf'),
    700: require('@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf'),
  },
  jakarta: {
    400: require('@expo-google-fonts/plus-jakarta-sans/400Regular/PlusJakartaSans_400Regular.ttf'),
    600: require('@expo-google-fonts/plus-jakarta-sans/600SemiBold/PlusJakartaSans_600SemiBold.ttf'),
    700: require('@expo-google-fonts/plus-jakarta-sans/700Bold/PlusJakartaSans_700Bold.ttf'),
  },
  space: {
    400: require('@expo-google-fonts/space-grotesk/400Regular/SpaceGrotesk_400Regular.ttf'),
    600: require('@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf'),
    700: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf'),
  },
  mono: {
    400: require('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf'),
    600: require('@expo-google-fonts/jetbrains-mono/600SemiBold/JetBrainsMono_600SemiBold.ttf'),
    700: require('@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf'),
  },
  pixelify: {
    400: require('@expo-google-fonts/pixelify-sans/400Regular/PixelifySans_400Regular.ttf'),
    600: require('@expo-google-fonts/pixelify-sans/600SemiBold/PixelifySans_600SemiBold.ttf'),
    700: require('@expo-google-fonts/pixelify-sans/700Bold/PixelifySans_700Bold.ttf'),
  },
};

const familyName = (id: FontId, weight: Weight) => `${id}-${weight}`;

/** Loads a font's three weights once. A font that fails to load falls back to the system font. */
export async function loadFont(id: FontId) {
  const files = FILES[id];
  if (!files) return;
  await Font.loadAsync(Object.fromEntries((Object.keys(files) as unknown as Weight[]).map((weight) => [familyName(id, weight), files[weight]])));
}

export function fontStyle(id: FontId, weight: Weight): TextStyle {
  if (id === 'serif') return { fontFamily: Platform.OS === 'android' ? 'serif' : 'Georgia', fontWeight: String(weight) as TextStyle['fontWeight'] };
  if (id !== 'system' && Font.isLoaded(familyName(id, weight))) return { fontFamily: familyName(id, weight) };
  return { fontWeight: String(weight) as TextStyle['fontWeight'] };
}

/** The tall sign face of the Plates look: names, codes and titles. One weight. */
const SIGN = 'sign-800';
export async function loadSign() {
  if (Font.isLoaded(SIGN)) return;
  await Font.loadAsync({ [SIGN]: require('@expo-google-fonts/big-shoulders-display/BigShouldersDisplay_800ExtraBold.ttf') });
}
/** The sign face when it has loaded, else the heaviest weight of the body font. */
export const signStyle = (fallback: TextStyle): TextStyle => (Font.isLoaded(SIGN) ? { fontFamily: SIGN, letterSpacing: 0.3 } : fallback);
