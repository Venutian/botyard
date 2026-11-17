// A bot's initial is written on its own colour: whatever colour a bot is given, the initial reads.

import test from 'node:test'
import assert from 'node:assert/strict'
import { botColour, inkOn, learnColours } from '../src/ui/crew-colours.js'

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

test('the ink on any paint reaches 4.5:1 (WCAG AA for text)', () => {
  let worst = Infinity
  for (let i = 0; i < 4096; i++) {
    const paint = `#${[i >> 8, (i >> 4) & 15, i & 15].map((v) => (v * 17).toString(16).padStart(2, '0')).join('')}`
    worst = Math.min(worst, contrast(paint, inkOn(paint)))
  }
  assert.ok(worst >= 4.5, `the worst paint reads at ${worst.toFixed(2)}:1`)
})

test('mid tones that a fixed cut-off got wrong take dark ink', () => {
  for (const paint of ['#f06fae', '#c49a6c', '#e2404d']) assert.equal(inkOn(paint), '#000000', paint)
  for (const paint of ['#6457e8', '#1d1e22']) assert.equal(inkOn(paint), '#ffffff', paint)
})

test('a bot is looked up by name, and an unknown one gets the spare colour with its ink', () => {
  learnColours([{ name: 'Pink', look: { colour: '#f06fae' } }])
  assert.deepEqual(botColour('Pink'), { paint: '#f06fae', ink: '#000000' })
  assert.deepEqual(botColour('Nobody'), { paint: '#7d8590', ink: inkOn('#7d8590') })
})
