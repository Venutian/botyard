/** Each free model is shown with the Claude it is about as good as, from the crew's own checks of its work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeLike } from '../server/lib/models.mjs'

test('a free model is placed against Claude by its tier and how much of its checked work passed', () => {
  assert.equal(claudeLike({ tier: 'strong', pass: 8, fail: 2 }), 'about Claude Sonnet')
  assert.equal(claudeLike({ tier: 'strong', pass: 3, fail: 1 }), 'about Claude Haiku', 'too few checks to say Sonnet')
  assert.equal(claudeLike({ tier: 'strong', pass: 10, fail: 5 }), 'about Claude Haiku')
  assert.equal(claudeLike({ tier: 'strong' }), 'about Claude Haiku', 'unmeasured strong model')
  assert.equal(claudeLike({ tier: 'strong', pass: 1, fail: 4 }), 'below Claude Haiku')
  assert.equal(claudeLike({ tier: 'light', pass: 9, fail: 0 }), 'below Claude Haiku')
})
