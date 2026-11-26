import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEED_LIMITS, keepEnds, runFeed } from '../server/lib/run-feed.mjs'

/** A run's log as the engine writes it: the tool's lines cut into pieces of `size` characters. */
function logOf(lines, { size = 37, stderr = [] } = {}) {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  const rows = []
  let seq = 0
  for (let i = 0; i < text.length; i += size) rows.push({ chunk: text.slice(i, i + size), seq: seq++, stream: 'stdout', ts: '2026-11-14T20:00:00Z' })
  for (const line of stderr) rows.push({ chunk: `${line}\n`, seq: seq++, stream: 'stderr', ts: '2026-11-14T20:00:01Z' })
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

const kinds = (feed) => feed.items.map((i) => (i.kind === 'tool' ? `tool:${i.name}:${i.state}` : i.kind))

test('Claude Code: its words, its thinking, each tool with its input and result, and the closing words once', () => {
  const feed = runFeed(logOf([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', cwd: '/w/job' },
    { type: 'system', subtype: 'thinking_tokens', session_id: 's1', estimated_tokens: 50 },
    { type: 'assistant', session_id: 's1', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'The test file first.\nThen the fix.' }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm1', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm1', content: [{ type: 'text', text: 'Reading the **tests**.' }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } },
    { type: 'rate_limit_event', session_id: 's1', rate_limit_info: {} },
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok 12 tests' }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/w/job/a.js' } }] } },
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'File not found' }] }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm3', content: [{ type: 'tool_use', id: 'tu3', name: 'mcp__botyard__close_job', input: { id: 'YRD-1' } }] } },
    { type: 'assistant', session_id: 's1', message: { id: 'm4', content: [{ type: 'text', text: 'Done: the tests pass.' }] } },
    { type: 'result', subtype: 'success', session_id: 's1', result: 'Done: the tests pass.', usage: {} },
  ]))
  assert.deepEqual(kinds(feed), ['note', 'thinking', 'said', 'tool:Bash:done', 'tool:Read:failed', 'tool:botyard: close job:running', 'said'])
  const [, thought, said, bash, read] = feed.items
  assert.equal(thought.text, 'The test file first.\nThen the fix.')
  assert.equal(said.text, 'Reading the **tests**.')
  assert.equal(bash.summary, 'npm test')
  assert.match(bash.input, /"command": "npm test"/)
  assert.equal(bash.output, 'ok 12 tests')
  assert.equal(read.output, 'File not found')
  assert.equal(feed.cut, 0)
})

test('Claude Code: a failed ending is an error, and a sub-agent\'s steps are marked as its', () => {
  const feed = runFeed(logOf([
    { type: 'assistant', session_id: 's', parent_tool_use_id: 'tuX', message: { content: [{ type: 'text', text: 'Looking around' }] } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' },
  ]))
  assert.equal(feed.items[0].depth, 1)
  assert.deepEqual(feed.items[1], { key: feed.items[1].key, kind: 'error', text: 'It reached its turn limit before finishing' })
})

test('Codex: messages, reasoning, a command started then finished in place, a failed command and an error', () => {
  const feed = runFeed(logOf([
    'Reading the launcher settings',
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Check the folder first' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Checking the folder.' } },
    { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'ls', aggregated_output: 'a.js\nb.js\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' } },
    { type: 'turn.failed', error: { message: 'Quota exceeded' } },
  ]))
  assert.deepEqual(kinds(feed), ['note', 'thinking', 'said', 'tool:Shell:done', 'tool:Shell:failed', 'tool:Edit files:done', 'error'])
  assert.equal(feed.items[3].output, 'a.js\nb.js')
  assert.equal(feed.items[5].summary, 'update a.js')
  assert.equal(feed.items[6].text, 'Quota exceeded')
})

test('OpenCode: text, a tool with its output, a tool that failed, an API error and the runner\'s notes on stderr', () => {
  const feed = runFeed(logOf([
    { type: 'step_start', sessionID: 'ses', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'ses', part: { id: 'p1', type: 'text', text: 'Let me look.' } },
    { type: 'tool_use', sessionID: 'ses', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'cd /w/job && git log -1' }, output: 'abc fix' } } },
    { type: 'tool_use', sessionID: 'ses', part: { type: 'tool', tool: 'read', callID: 'c2', state: { status: 'error', input: { filePath: '/w/job/x.md' }, error: 'File not found' } } },
    { type: 'error', sessionID: 'ses', error: { name: 'APIError', data: { message: 'Too Many Requests' } } },
    { type: 'step_finish', sessionID: 'ses', part: { type: 'step-finish', tokens: {} } },
  ], { stderr: ['beam-free ran out; continuing the same session on flint-free.', 'fatal: not a git repository'] }), { cwd: '/w/job' })
  assert.deepEqual(kinds(feed), ['said', 'tool:bash:done', 'tool:read:failed', 'error', 'note', 'error'])
  // The run's own folder is left out of the one line, and kept in the full input.
  assert.equal(feed.items[1].summary, 'git log -1')
  assert.match(feed.items[1].input, /cd \/w\/job && git log -1/)
  assert.equal(feed.items[2].summary, 'x.md')
  assert.equal(feed.items[2].output, 'File not found')
  assert.equal(feed.items[3].text, 'Too Many Requests')
})

test('Gemini through the engine\'s client: a tool ends when the next thing comes, a failure marks its own', () => {
  const feed = runFeed(logOf([
    { type: 'session', sessionId: 'g1', resumed: false, model: 'gemini-x' },
    { type: 'tool', title: 'cat OWNER.md', status: 'in_progress' },
    { type: 'tool', title: 'npm test', status: 'pending' },
    { type: 'tool', title: 'npm test', status: 'failed' },
    { type: 'text', text: 'The tests fail.' },
    { type: 'result', sessionId: 'g1', stopReason: 'end_turn', usage: {}, text: 'The tests fail.' },
  ]))
  assert.deepEqual(kinds(feed), ['note', 'tool:Tool:done', 'tool:Tool:failed', 'said'])
  assert.equal(feed.items[1].summary, 'cat OWNER.md')
})

test('a run still going: the read ends mid-line, and the half line waits for the next read', () => {
  const whole = logOf([
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }] } },
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'Still waiting on the build' }] } },
  ], { size: 25 })
  const rows = whole.trim().split('\n')
  // Most of the records, as a reader sees a log the engine is still writing.
  const now = runFeed(rows.slice(0, rows.length - 2).join('\n'))
  assert.deepEqual(kinds(now), ['tool:Bash:running'])
  assert.deepEqual(kinds(runFeed(whole)), ['tool:Bash:running', 'said'])
})

test('the end of a long log: its first line is a fragment, and a result whose call was cut off stands alone', () => {
  const records = [
    { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'early', content: 'found it' }] } },
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'Found it.' }] } },
  ].map((e, n) => JSON.stringify({ chunk: `${JSON.stringify(e)}\n`, seq: n + 1, stream: 'stdout' })).join('\n')
  // The read starts inside an earlier record, which held the call itself.
  const feed = runFeed(`l","seq":0,"stream":"stdout"}\n${records}`, { fromStart: false })
  assert.deepEqual(kinds(feed), ['tool:Tool:done', 'said'])
  assert.equal(feed.items[0].output, 'found it')
})

test('keys and tokens in a run\'s words are hidden, and long output keeps its start and its end', () => {
  const big = `${'a'.repeat(5000)}THE END`
  const feed = runFeed(logOf([
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" x' } }] } },
    { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } },
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'The key is sk-abcdefghijklmnopqrstuvwx' }] } },
  ]))
  assert.match(feed.items[0].summary, /Bearer \[hidden\]/)
  assert.doesNotMatch(feed.items[0].input, /abcdefghijklmnop/)
  assert.ok(feed.items[0].output.length < FEED_LIMITS.output + 80)
  assert.match(feed.items[0].output, /THE END$/)
  assert.match(feed.items[0].output, /characters left out/)
  assert.equal(feed.items[1].text, 'The key is [hidden]')
  assert.equal(keepEnds('short', 100), 'short')
})

test('a very long run keeps its newest steps and says how many went before', () => {
  const lines = Array.from({ length: FEED_LIMITS.items + 25 }, (_, n) => ({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: `Step ${n}` }] } }))
  const feed = runFeed(logOf(lines, { size: 500 }))
  assert.equal(feed.items.length, FEED_LIMITS.items)
  assert.equal(feed.cut, 25)
  assert.equal(feed.items.at(-1).text, `Step ${FEED_LIMITS.items + 24}`)
})

test('an empty or unreadable log is an empty feed', () => {
  assert.deepEqual(runFeed(''), { items: [], cut: 0 })
  assert.deepEqual(runFeed('not json\n{"chunk": 4}\n'), { items: [], cut: 0 })
})

test('OpenCode: the model the free runner starts on is a note, and so is the one it switches to', () => {
  const feed = runFeed(logOf([
    { type: 'model', model: 'nv/step-5', sessionID: '' },
    { type: 'text', sessionID: 's', part: { text: 'Reading.' } },
    { type: 'model', model: 'kilo/nemotron:free', sessionID: '' },
  ]), { fromStart: true })
  assert.deepEqual(feed.items.filter((i) => i.kind === 'note').map((i) => i.text), ['On nv/step-5', 'On kilo/nemotron:free'])
})
