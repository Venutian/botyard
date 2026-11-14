import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openrouterLeft, usageRows } from '../server/lib/usage.mjs'
import { freeForecast, freeProvider, publishedLimit } from '../server/lib/models.mjs'
import { usageHtml } from '../src/ui/usage.js'

const NOW = 1_794_680_000

test('each free model is known by its provider, and its published limit is the most exact one', () => {
  assert.equal(freeProvider('opencode/beam-free'), 'OpenCode free')
  assert.equal(freeProvider('openrouter/x/y:free'), 'OpenRouter free')
  assert.equal(freeProvider('nvidia/minimaxai/minimax-m3.1-flash'), 'NVIDIA')
  assert.match(publishedLimit('opencode/longcat-flash'), /100 requests a day/)
  assert.match(publishedLimit('opencode/beam-free'), /No limit published/)
  assert.equal(publishedLimit('elsewhere/model'), '')
})

test('a free model\'s forecast: the usual work before it stops, what is left of it, and when one that is out is back', () => {
  const state = {
    models: {
      'nvidia/a': { state: 'up', since: NOW - 300, tokens: 1000, seconds: 300, runs: 1, rounds: [
        { up: 1, out: 2, back: 3, tokens: 100_000, seconds: 900, runs: 2 },
        { up: 4, out: 5, back: 6, tokens: 200_000, seconds: 1500, runs: 3 },
        { up: 7, out: 8, back: 9, tokens: 0, seconds: 0, runs: 0, fixed: true },
      ] },
      'opencode/b': { state: 'out', since: NOW - 3600, tokens: 0, seconds: 0, runs: 0, rounds: [
        { up: 0, out: 100, back: 100 + 7200, tokens: 0, seconds: 0 },
        { up: 0, out: 200, back: 200 + 10800, tokens: 0, seconds: 0 },
      ] },
      'opencode/c': { state: 'up', since: NOW, tokens: 0, seconds: 0, runs: 0, rounds: [{ up: 0, out: 1, back: 2, tokens: 5, seconds: 60 }] },
      'opencode/d': { state: 'out', since: NOW, fixed_until: NOW + 999, rounds: [] },
    },
  }
  const f = freeForecast(state, NOW)
  assert.deepEqual(f.get('nvidia/a'), { state: 'up', since: NOW - 300, round: { seconds: 300, tokens: 1000, runs: 1 }, usualSeconds: 1200, usualTokens: 150_000, leftSeconds: 900, leftTokens: 149_000 })
  assert.equal(f.get('opencode/b').back, NOW - 3600 + 9000)
  // Seen once: nothing is guessed from it.
  assert.equal(f.get('opencode/c').usualSeconds, undefined)
  assert.equal(f.get('opencode/d').back, NOW + 999)
})

test('the usage list: the subscriptions first with their shares, Gemini, then each free provider with its models', () => {
  const rows = usageRows({
    plans: { claude: { week: 0.03, resets: NOW + 3600 }, codex: { week: 0.95, fiveHours: 0.4, resets: NOW + 7200, fiveHoursResets: NOW + 600 } },
    windows: [{ name: 'Claude', '5h': 10, '24h': 20, '7d': 30 }, { name: 'OpenRouter free', '7d': 99 }, { name: 'Antigravity', '7d': 5 }, { name: 'Cloudflare', '7d': 7 }],
    free: [
      { label: 'Beam, free', provider: 'OpenCode free', state: 'answering', published: 'No limit published', learned: { usualSeconds: 1200, leftSeconds: 600, round: { seconds: 600 } } },
      { label: 'LongCat, free', provider: 'OpenCode free', state: 'aside', until: NOW + 50, why: 'did not answer', published: '100 requests a day' },
      { label: 'Flint, free', provider: 'OpenCode free', state: 'unchecked', published: 'No limit published' },
      { label: 'Inkling via OpenRouter', provider: 'OpenRouter free', state: 'aside', until: NOW + 999, published: '20 a minute and 1,000 a day' },
    ],
    usedUp: [{ label: 'Gemini 3 Pro', until: NOW + 400 }],
    openrouter: { left: 250 },
  })
  assert.deepEqual(rows.map((r) => r.name), ['Claude', 'Codex', 'Gemini', 'OpenCode free', 'OpenRouter free', 'Cloudflare'])
  const [claude, codex, gemini, opencode, openrouter, cloudflare] = rows
  assert.equal(claude.week, 0.03)
  assert.deepEqual(claude.tokens, { '5h': 10, '24h': 20, '7d': 30 })
  assert.equal(codex.fiveHours, 0.4)
  assert.deepEqual(codex.tokens, { '5h': 0, '24h': 0, '7d': 0 })
  assert.deepEqual(gemini.models, [{ label: 'Gemini 3 Pro', state: 'aside', back: NOW + 400 }])
  assert.equal(opencode.note, 'Published limit: no limit published.')
  assert.deepEqual(opencode.models[0], { label: 'Beam, free', state: 'answering', usualSeconds: 1200, leftSeconds: 600, roundSeconds: 600 })
  assert.deepEqual(opencode.models[1], { label: 'LongCat, free', state: 'aside', back: NOW + 50, why: 'did not answer', limit: '100 requests a day' })
  assert.equal(opencode.models[2].state, 'unchecked')
  assert.deepEqual(openrouter.day, { left: 250, limit: 1000, share: 0.75 })
  assert.deepEqual(cloudflare.models, [])
  // Without the crew's usage script: no share is made up.
  const bare = usageRows({ windows: [{ name: 'Claude', '7d': 1 }] })
  assert.equal(bare[0].week, null)
  assert.match(bare[0].note, /not known/)
})

test('OpenRouter is asked what is left of its free requests today, and a refusal or no key says nothing', async () => {
  let asked = 0
  const fetchImpl = async (url, { headers }) => {
    asked++
    assert.equal(url, 'https://openrouter.ai/api/v1/key')
    assert.equal(headers.Authorization, 'Bearer k1')
    return { ok: true, json: async () => ({ data: { free_model_daily_requests: { remaining: 812 } } }) }
  }
  assert.deepEqual(await openrouterLeft({ fetchImpl, key: 'k1', now: 1e12 }), { left: 812 })
  // Asked again only after two minutes.
  assert.deepEqual(await openrouterLeft({ fetchImpl, key: 'k1', now: 1e12 + 1000 }), { left: 812 })
  assert.equal(asked, 1)
  assert.equal(await openrouterLeft({ fetchImpl, key: '', now: 2e12 }), null)
  assert.equal(await openrouterLeft({ fetchImpl: async () => ({ ok: false }), key: 'k1', now: 3e12 }), null)
})

test('the list as HTML: meters for what is counted, a line a model, and the limits in plain words', () => {
  const html = usageHtml({ at: NOW * 1000, providers: usageRows({
    plans: { claude: { week: 0.92, resets: NOW + 3600 } },
    windows: [{ name: 'Claude', '5h': 1500, '24h': 2_000_000, '7d': 188_000_000 }],
    free: [{ label: 'Beam, free', provider: 'OpenCode free', state: 'answering', published: 'No limit published', learned: { usualSeconds: 1200, leftSeconds: 600 } }, { label: 'Out <one>', provider: 'OpenCode free', state: 'aside', until: NOW + 60 }],
    openrouter: null,
  }) }, NOW * 1000)
  assert.match(html, /u-meter bad/)
  assert.match(html, /92% used/)
  assert.match(html, /<b>2\.0M<\/b> in a day · <b>188M<\/b> in a week/)
  assert.match(html, /about 10 min left of the 20 min it usually gives/)
  assert.match(html, /Out &lt;one&gt;/)
  assert.match(html, /Out, usually back about/)
  assert.match(html, /1 of 2 models answering/)
  assert.match(usageHtml({ providers: [] }), /No AI has been used yet/)
})
