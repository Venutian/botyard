/** Each free model carries one chip for where it stands against Claude, from the crew's own checks of its work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chipMeaning, claudeLike } from '../server/lib/models.mjs'

test('a free model gets its Claude chip from how much of its checked work passed, and unrated below three checks', () => {
  const chip = (pass, fail) => claudeLike({ pass, fail }).chip
  assert.equal(chip(0, 0), 'unrated')
  assert.equal(chip(2, 0), 'unrated', 'two checks are not enough to say')
  assert.equal(chip(1, 4), '-Haiku')
  assert.equal(chip(2, 3), 'Haiku')
  assert.equal(chip(11, 9), '+Haiku')
  assert.equal(chip(4, 0), '+Haiku', 'perfect but few checks stays at +Haiku')
  assert.equal(chip(8, 2), 'Sonnet')
  assert.equal(chip(9, 1), '+Sonnet')
  assert.equal(chip(15, 0), 'Opus')
  assert.equal(chipMeaning('+Haiku'), 'About as good as Claude Haiku, a bit better')
  assert.equal(chipMeaning('-Haiku'), 'Weaker than Claude Haiku')
  assert.equal(claudeLike({ pass: 8, fail: 2 }).tier, 'sonnet')
})

test('a published benchmark grades a model first, whatever its provider; the crew record only fills in where none exists', async () => {
  const { benchmarkGrade } = await import('../server/lib/models.mjs')
  assert.equal(claudeLike({ model: 'opencode/glm-5.3-flash-free', pass: 0, fail: 9 }).chip, '+Sonnet', 'the benchmark wins over a poor record')
  assert.equal(claudeLike({ model: 'hyperbolic/glm-5.3-flash' }).chip, '+Sonnet', 'any provider')
  assert.equal(claudeLike({ model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b' }).from, 'benchmark')
  assert.equal(claudeLike({ model: 'kilo/nvidia/nemotron-3.5-super-vl:free' }).chip, '+Haiku')
  assert.equal(claudeLike({ model: 'opencode/deepseek-v4.1-flash-free', pass: 10, fail: 5 }).from, 'checks', 'no published score: the crew record')
  assert.equal(claudeLike({ model: 'opencode/beam-free' }).chip, 'unrated')
  assert.equal(benchmarkGrade('opencode/nemotron-3.5-lightning-free').score, 52.8)
})
