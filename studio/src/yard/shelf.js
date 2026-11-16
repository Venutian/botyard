import * as THREE from 'three'

/**
 * How a shelved project's bay looks: the ground and walls dimmed to about 55 percent and half
 * drained of colour, so it reads as shut up for a while without vanishing. Plain numbers and
 * colours, so it is tested without a browser.
 */

/** Brightness kept, and how much colour is kept, for a shelved bay. */
export const SHELF_LIGHT = 0.55
export const SHELF_COLOUR = 0.5

/** One colour as a shelved bay draws it: its grey blended in, then dimmed. */
export function dim(hex) {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [n >> 16, (n >> 8) & 255, n & 255]
  const grey = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
  const part = (v) => Math.round((grey + (v - grey) * SHELF_COLOUR) * SHELF_LIGHT).toString(16).padStart(2, '0')
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`
}

/** The same dimming for a welded geometry's vertex colours, in place. */
export function dimColours(geometry) {
  const colours = geometry.attributes.color
  const c = new THREE.Color()
  const hsl = {}
  for (let i = 0; i < colours.count; i++) {
    c.setRGB(colours.getX(i), colours.getY(i), colours.getZ(i), THREE.LinearSRGBColorSpace)
    c.getHSL(hsl, THREE.LinearSRGBColorSpace)
    c.setHSL(hsl.h, hsl.s * SHELF_COLOUR, hsl.l * SHELF_LIGHT, THREE.LinearSRGBColorSpace)
    colours.setXYZ(i, c.r, c.g, c.b)
  }
  colours.needsUpdate = true
  return geometry
}
