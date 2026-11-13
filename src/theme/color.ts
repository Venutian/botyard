/** Colour helpers. Everything takes and returns #rrggbb, and #rrggbbaa input is read as #rrggbb. */

const channels = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

export const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

export function mix(hex: string, toward: string, amount: number) {
  const a = channels(hex);
  const b = channels(toward);
  return toHex(a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount);
}

export function alpha(hex: string, amount: number) {
  const [r, g, b] = channels(hex);
  return `rgba(${r},${g},${b},${amount})`;
}

export function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The readable ink for text sitting on this colour. */
export const inkOn = (hex: string) => (luminance(hex) > 0.36 ? '#101214' : '#ffffff');

export function hexToHue(hex: string) {
  const [r, g, b] = channels(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export function hsl(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) ;
  };
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

export const shiftHue = (hex: string, degrees: number) => hsl((hexToHue(hex) + degrees + 360) % 360, 0.82, 0.56);

/** A mascot's body: lit from the top right, shaded towards the bottom left. */
export const gradientFor = (hex: string): [string, string, string] => [mix(hex, '#ffffff', 0.55), hex, mix(hex, '#000000', 0.42)];
