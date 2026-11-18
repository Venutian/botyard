/** Reviews (engine/marks.mjs): the owner's marks on text and pictures, sent as one message, at a gate too; and the cut of a picture (engine/crop.mjs). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { openStore } from '../server/engine/store.mjs'
import { answer } from '../server/engine/api.mjs'
import { addComment, createJob, putDocument } from '../server/engine/write.mjs'
import { attach } from '../server/engine/files.mjs'
import { cropMark, cropPng, pixelBox, readPng, sizeOf } from '../server/engine/crop.mjs'
import { gateOf, placeOf, renderReview, sendReview } from '../server/engine/marks.mjs'
import { saveTrack, startRequest, tickTracks } from '../server/engine/tracks.mjs'

const OWNER = { user: 'local-board' }
const BOT = { agent: 'b1', run: 'r1' }
const T0 = Date.parse('2026-11-18T12:00:00Z')

/** A PNG of the given size, red on the left half and blue on the right, every row with a different filter. */
function png(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const at = y * (width * 4 + 1) + 1 + x * 4
      raw.set(x < width / 2 ? [220, 30, 30, 255] : [30, 30, 220, 255], at)
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0)
  head.writeUInt32BE(height, 4)
  head[8] = 8
  head[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function yard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'))
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  store.put('agents', { id: 'b1', companyId: 'co', name: 'Builder', status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Harbour', status: 'in_progress' }, { position: 0 })
  const job = createJob(store, 'co', { title: 'Write the harbour page', description: 'Make a page.\n\nIt says when the ferry leaves.', assigneeAgentId: 'b1', projectId: 'p1', status: 'in_progress' }, { now: T0, actor: OWNER })
  return { store, dataDir, job }
}

test('a quote is found by its words, over line breaks, nearest the marked line', () => {
  const text = 'Title\n\nFirst paragraph says hello\nand goes on.\n\nSecond says hello too.'
  assert.deepEqual(placeOf(text, 'hello and goes', 0), { line: 3, lineEnd: 4, paragraph: 2, count: 1 })
  assert.equal(placeOf(text, 'hello', 6).line, 6)
  assert.equal(placeOf(text, 'hello', 6).paragraph, 3)
  assert.equal(placeOf(text, 'not there'), null)
})

test('a picture is cut around its box, and around a point as a square, in its own colours', () => {
  const bytes = png(200, 100)
  assert.deepEqual(sizeOf(bytes), { width: 200, height: 100, type: 'image/png' })
  const cut = cropMark(bytes, { x: 0.6, y: 0.2, w: 0.2, h: 0.5 })
  assert.deepEqual(cut.marked, { x: 120, y: 20, w: 40, h: 50 })
  const out = readPng(cut.png)
  assert.equal(out.width, cut.area.width)
  assert.equal(out.height, cut.area.height)
  assert.deepEqual([...out.pixels.subarray(0, 4)], [30, 30, 220, 255])
  const point = pixelBox({ x: 0.5, y: 0.5, w: 0, h: 0 }, 200, 100)
  assert.equal(point.width, 24)
  assert.equal(readPng(cropPng(bytes, point)).width, 24)
  assert.equal(cropMark(Buffer.from('not a picture'), { x: 0, y: 0, w: 1, h: 1 }).png, null)
})

test('marks on the brief, a document, a message and a picture go to the bot as one comment with the cut copies', () => {
  const { store, dataDir, job } = yard()
  putDocument(store, job.id, 'plan', { body: '# Plan\n\n1. Draw the map\n2. Write the times\n3. Add the prices' }, { now: T0, actor: BOT })
  const said = addComment(store, job.id, { body: 'Done the first pass.\n\nThe ferry leaves at nine.' }, { now: T0, actor: BOT })
  const shot = attach(store, 'co', job.id, { name: 'harbour.png', type: 'image/png', bytes: png(200, 100) }, { now: T0, actor: BOT, dataDir })
  const review = sendReview(store, job.id, {
    piece: { kind: 'document', ref: 'plan', title: 'the plan' },
    marks: [
      { kind: 'text', quote: 'Write the times', comment: 'Times in 24 hours', line: 4 },
      { kind: 'picture', attachmentId: shot.id, box: { x: 0.6, y: 0.2, w: 0.2, h: 0.5 }, comment: 'This blue is too dark' },
    ],
    note: 'Nearly there',
  }, { now: T0 + 1000, actor: OWNER, dataDir })
  assert.equal(review.marks[0].line, 4)
  assert.match(review.text, /1\. document "plan", line 4\n {3}> Write the times\n {3}Comment: Times in 24 hours/)
  assert.match(review.text, /2\. picture "harbour\.png", box x 120–160, y 20–70 of 200×100/)
  assert.match(review.text, /Cut copy: mark-2-harbour\.png/)
  assert.match(review.text, /Overall: Nearly there/)
  const comment = store.object('SELECT raw FROM comments WHERE id = ?', review.commentId)
  assert.equal(comment.authorType, 'user')
  assert.equal(comment.body, review.text)
  const files = store.objects('SELECT raw FROM attachments WHERE comment_id = ?', comment.id)
  assert.deepEqual(files.map((f) => f.originalFilename), ['mark-2-harbour.png'])
  // The bot is woken by the comment, like any word from the owner.
  assert.ok(store.objects("SELECT raw FROM wakes WHERE agent_id = 'b1' AND status = 'queued'").some((w) => w.payload?.issueId === job.id))

  const onMessage = sendReview(store, job.id, { piece: { kind: 'message', ref: said.id }, marks: [{ kind: 'text', quote: 'leaves at nine', comment: 'It is half past nine' }] }, { now: T0 + 2000, actor: OWNER, dataDir })
  assert.match(onMessage.text, /Builder's message of 2026-11-18 12:00 UTC, paragraph 2, line 3/)
  const onBrief = sendReview(store, job.id, { piece: { kind: 'brief' }, marks: [{ kind: 'text', quote: 'ferry', comment: 'Name the boat' }] }, { now: T0 + 3000, actor: OWNER, dataDir })
  assert.match(onBrief.text, /the job's brief, line 3/)
  // One review, marks on several pieces: each says its own place.
  const several = sendReview(store, job.id, { piece: { kind: 'work', title: 'LH-1' }, marks: [
    { kind: 'text', quote: 'Draw the map', comment: 'A real map', piece: { kind: 'document', ref: 'plan' } },
    { kind: 'text', quote: 'first pass', comment: 'Which pass?', piece: { kind: 'message', ref: said.id } },
  ] }, { now: T0 + 4000, actor: OWNER, dataDir })
  assert.match(several.text, /1\. document "plan", line 3/)
  assert.match(several.text, /2\. Builder's message of .*, paragraph 1, line 1/)
  // Words that are not in the piece are refused, so a mark never points at nothing.
  assert.throws(() => sendReview(store, job.id, { piece: { kind: 'brief' }, marks: [{ kind: 'text', quote: 'a castle', comment: 'x' }] }, { actor: OWNER, dataDir }), /not in the job's brief/)
  assert.throws(() => sendReview(store, job.id, { piece: { kind: 'brief' }, marks: [{ kind: 'text', quote: 'ferry', comment: '' }] }, { actor: OWNER, dataDir }), /no comment/)
})

test('only the owner sends marks: a bot\'s pass is refused, through the engine\'s front door too', () => {
  const { store, dataDir, job } = yard()
  const body = { piece: { kind: 'brief' }, marks: [{ kind: 'text', quote: 'ferry', comment: 'x' }] }
  assert.throws(() => sendReview(store, job.id, body, { actor: BOT, dataDir }), /Only the owner sends marks/)
  const refused = answer(store, { method: 'POST', url: `/api/issues/${job.id}/reviews`, body }, { dataDir, actor: { agent: 'b1', run: 'r1' } })
  assert.equal(refused.status, 403)
  const sent = answer(store, { method: 'POST', url: `/api/issues/${job.id}/reviews`, body }, { dataDir, actor: OWNER })
  assert.equal(sent.status, 201)
  const kept = answer(store, { method: 'GET', url: `/api/issues/${job.id}/reviews` }, { dataDir, actor: OWNER })
  assert.equal(kept.body.length, 1)
  assert.equal(answer(store, { method: 'GET', url: `/api/companies/co/reviews?projectId=p1` }, { dataDir, actor: OWNER }).body.length, 1)
  assert.equal(answer(store, { method: 'GET', url: `/api/reviews/${sent.body.id}` }, { dataDir, actor: OWNER }).body.verdict, 'back')
})

test('a review of a job waiting at a gate is the gate\'s answer: the marks are the note the work goes back with', async () => {
  const { store, dataDir } = yard()
  const io = {
    startKeeper(specFile) {
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
      fs.writeFileSync(spec.env.BOTYARD_STEP_OUT, JSON.stringify({ leaves: { text: `draft(${spec.env.BOTYARD_IN_NOTE || ''})` } }))
      fs.writeFileSync(spec.logFile, '')
      fs.writeFileSync(spec.resultFile, JSON.stringify({ exitCode: 0, timedOut: false }))
      return 1
    },
    alive: () => false,
    inMain: async () => true,
  }
  saveTrack(store, 'co', {
    key: 'write', delivers: 'nothing',
    steps: [{ id: 'draft', kind: 'script', command: 'draft', leaves: ['text'] }, { id: 'look', kind: 'gate', needs: ['text'] }],
    lines: [{ from: 'draft', to: 'look', on: 'always' }],
  }, { actor: OWNER })
  const request = startRequest(store, 'co', { track: 'write', title: 'A page' }, { now: T0, actor: OWNER })
  await tickTracks(store, { dataDir, io, now: T0 })
  const gate = gateOf(store, request.jobId)
  assert.deepEqual(gate.before.map((s) => s.id), ['draft'])
  // The job a step made (where the work is) finds the same gate.
  const work = createJob(store, 'co', { title: 'Draft it', assigneeAgentId: 'b1' }, { now: T0, actor: OWNER })
  const row = store.object("SELECT raw FROM trip_steps WHERE step_id = 'draft'")
  store.put('trip_steps', { ...row, jobId: work.id })
  assert.equal(gateOf(store, work.id).tripId, gate.tripId)
  const review = sendReview(store, request.jobId, { piece: { kind: 'brief' }, marks: [], note: 'Shorter, please', gate: { tripId: gate.tripId, to: 'draft' } }, { now: T0 + 1, actor: OWNER, dataDir })
  assert.equal(review.commentId, null)
  assert.equal(review.gate.tripId, gate.tripId)
  assert.equal(gateOf(store, request.jobId), null)
  await tickTracks(store, { dataDir, io, now: T0 + 2 })
  assert.match(store.object("SELECT raw FROM cards WHERE status = 'pending'").summary, /Overall: Shorter, please/)
  assert.throws(() => sendReview(store, request.jobId, { piece: { kind: 'brief' }, note: 'x', gate: { tripId: 'old' } }, { actor: OWNER, dataDir }), /not waiting at a gate/)
})

test('the message reads the same whatever the order of its parts', () => {
  const text = renderReview({ piece: { kind: 'page', title: 'the demo yard' }, verdict: 'back', note: '', marks: [{ n: 1, kind: 'page', url: 'http://localhost:5275/', element: 'button.new-job', text: 'New job', comment: 'Bigger' }] })
  assert.match(text, /1\. page http:\/\/localhost:5275\/, element button\.new-job\n {3}> New job\n {3}Comment: Bigger/)
})

// ── the owner's side: the page and the phone ask through lib/marks.mjs ─────────────

/** The engine itself behind a fetch, so the page's library is tested against the real paths. */
function engineFetch(store, dataDir) {
  return async (url, init = {}) => {
    const at = new URL(url)
    const out = answer(store, { method: init.method || 'GET', url: at.pathname + at.search, body: init.body ? JSON.parse(init.body) : {} }, { dataDir, actor: OWNER })
    return new Response(JSON.stringify(out.body ?? null), { status: out.status, headers: { 'content-type': 'application/json' } })
  }
}

test('a job offers the bot\'s last message first, then its earlier ones, the brief, documents and pictures; the send goes through', async () => {
  const { reviewRecord, reviewSources, sendMarks } = await import('../server/lib/marks.mjs')
  const { store, dataDir, job } = yard()
  addComment(store, job.id, { body: 'First go.' }, { now: T0, actor: BOT })
  addComment(store, job.id, { body: 'Second go, with the times.' }, { now: T0 + 1, actor: BOT })
  putDocument(store, job.id, 'plan', { body: 'Step one' }, { now: T0, actor: BOT })
  attach(store, 'co', job.id, { name: 'shot.png', type: 'image/png', bytes: png(20, 10) }, { now: T0, actor: BOT, dataDir })
  const fetcher = engineFetch(store, dataDir)
  const src = await reviewSources({ job: job.id }, { fetcher })
  assert.deepEqual(src.pieces.map((p) => p.kind), ['message', 'message', 'brief', 'document', 'picture'])
  assert.equal(src.pieces[0].title, 'Last message from Builder')
  assert.equal(src.pieces[0].text, 'Second go, with the times.')
  assert.match(src.pieces[4].src, /^\/api\/studio\/file\?id=/)
  assert.match((await reviewSources({ job: job.id }, { fetcher, picture: (id) => `/v1/proof/${id}` })).pieces[4].src, /^\/v1\/proof\//)
  await assert.rejects(sendMarks({ jobId: 'nope' }, { fetcher }), /Say which job/)
  const sent = await sendMarks({ jobId: job.id, piece: { kind: 'message', ref: src.pieces[0].ref }, marks: [{ kind: 'text', quote: 'the times', comment: 'Which times?' }] }, { fetcher })
  assert.match(sent.text, /paragraph 1, line 1/)
  assert.equal((await reviewRecord({ job: job.id }, { fetcher })).reviews.length, 1)
  assert.equal((await reviewRecord({ id: sent.id }, { fetcher })).id, sent.id)
})

test('the sheet\'s reckoning: numbered lines, a box from a drag, a tap as a point, and one payload for marks on several pieces', async () => {
  const { boxFrom, linesHtml, markWhere, payloadOf } = await import('../src/ui/marks-core.js')
  const html = linesHtml('# Head\n\n<b>bold</b>', new Map([[3, [2]]]))
  assert.match(html, /class="mk-line head" data-n="1"/)
  assert.match(html, /data-n="2"><span class="mk-text">&#8203;/)
  assert.match(html, /class="mk-line marked" data-n="3"><span class="mk-text">&lt;b&gt;bold/)
  const rect = { left: 100, top: 50, width: 200, height: 100 }
  assert.deepEqual(boxFrom({ x: 300, y: 150 }, { x: 200, y: 100 }, rect), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  assert.deepEqual(boxFrom({ x: 150, y: 75 }, { x: 152, y: 76 }, rect), { x: 0.25, y: 0.25, w: 0, h: 0 })
  assert.equal(markWhere({ kind: 'text', line: 3, lineEnd: 5 }), 'lines 3–5')
  const state = {
    jobId: 'j', ref: 'HAR-1', title: 'Shop', note: ' ok ', current: 'brief', gate: null,
    pieces: [{ id: 'brief', kind: 'brief', ref: '', title: 'The brief' }, { id: 'picture:p', kind: 'picture', ref: 'p', title: 'shot.png' }],
    marks: [{ n: 1, kind: 'text', pieceId: 'brief', quote: 'a', line: 1, lineEnd: 1, comment: 'x' }, { n: 2, kind: 'picture', pieceId: 'picture:p', box: { x: 0, y: 0, w: 0, h: 0 }, comment: 'y' }],
  }
  const out = payloadOf(state, 'back')
  assert.deepEqual(out.piece, { kind: 'work', ref: '', title: 'HAR-1 Shop' })
  assert.equal(out.note, 'ok')
  assert.deepEqual(out.marks[1], { kind: 'picture', comment: 'y', piece: { kind: 'picture', ref: 'p' }, attachmentId: 'p', box: { x: 0, y: 0, w: 0, h: 0 } })
  assert.equal(payloadOf({ ...state, marks: state.marks.slice(0, 1) }, 'back').piece.kind, 'brief')
  assert.deepEqual(payloadOf({ ...state, gate: { tripId: 't' } }, 'back', 'draft').gate, { tripId: 't', to: 'draft' })
})

test('the bot\'s next run is shown the marks: the review in its news, the cut copy beside it as a picture to open', async () => {
  const { wakePrompt } = await import('../server/engine/prompt.mjs')
  const { filesForRun } = await import('../server/engine/runner.mjs')
  const { store, dataDir, job } = yard()
  const shot = attach(store, 'co', job.id, { name: 'harbour.png', type: 'image/png', bytes: png(200, 100) }, { now: T0, actor: BOT, dataDir })
  const review = sendReview(store, job.id, { piece: { kind: 'picture', ref: shot.id }, marks: [{ kind: 'picture', attachmentId: shot.id, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, comment: 'Brighter sky' }] }, { now: T0 + 1, actor: OWNER, dataDir })
  const agent = store.object("SELECT raw FROM agents WHERE id = 'b1'")
  const comments = store.objects('SELECT raw FROM comments WHERE job_id = ?', job.id)
  const files = filesForRun(store, job, agent, comments, '', fs.mkdtempSync(path.join(os.tmpdir(), 'marks-run-')), { dataDir })
  const prompt = wakePrompt({ agent, job: store.object('SELECT raw FROM jobs WHERE id = ?', job.id), wake: { reason: 'issue_commented' }, comments, files })
  assert.ok(prompt.includes(review.text.split('\n')[0]))
  assert.match(prompt, /The owner, .*:\n[\s\S]*Comment: Brighter sky/)
  assert.match(prompt, /picture attached: .*mark-1-harbour\.png \(image\/png/)
})

// ── the answer tray beside Needs you (lib/tray.mjs) ────────────────────────────────

test('answers held in the tray go at one press, each to the job that asked; one that fails stays with why; the tray is the owner\'s alone', async () => {
  const { createCard } = await import('../server/engine/write.mjs')
  const { dropItem, holdItem, readTray, sendTray, waitingQuestions } = await import('../server/lib/tray.mjs')
  const { store, dataDir, job } = yard()
  const other = createJob(store, 'co', { title: 'Pick a colour', assigneeAgentId: 'b1', status: 'in_progress' }, { now: T0, actor: OWNER })
  const ask = createCard(store, job.id, { kind: 'ask_user_questions', title: 'Which size?', payload: { questions: [{ id: 'size', prompt: 'Which size ships first?', options: [{ id: 's', label: 'Small' }, { id: 'l', label: 'Large' }] }] } }, { now: T0, actor: BOT })
  const yes = createCard(store, other.id, { kind: 'request_confirmation', title: 'Ship it?' }, { now: T0, actor: BOT })
  const fetcher = engineFetch(store, dataDir)
  const file = path.join(dataDir, 'tray.json')

  const waiting = await waitingQuestions({ job: job.id }, { fetcher })
  assert.deepEqual(waiting.questions.map((q) => [q.kind, q.title, q.items[0].options.map((o) => o.label)]), [['choice', 'Which size?', ['Small', 'Large']]])
  holdItem({ kind: 'answer', jobId: job.id, cardId: ask.id, title: 'Which size?', answers: [{ questionId: 'size', optionIds: ['s'] }], said: 'Small' }, { file })
  holdItem({ kind: 'accept', jobId: other.id, cardId: yes.id, title: 'Ship it?' }, { file })
  holdItem({ kind: 'review', jobId: job.id, review: { piece: { kind: 'brief' }, marks: [{ kind: 'text', quote: 'ferry', comment: 'Name it' }] } }, { file })
  // A second answer to the same question takes the first one's place.
  holdItem({ kind: 'answer', jobId: job.id, cardId: ask.id, title: 'Which size?', answers: [{ questionId: 'size', optionIds: ['l'] }], said: 'Large' }, { file })
  assert.equal(readTray(file).length, 3)
  assert.throws(() => holdItem({ kind: 'answer', jobId: job.id, cardId: ask.id, answers: [] }, { file }), /Answer the question first/)
  holdItem({ kind: 'reject', jobId: other.id, cardId: '00000000-0000-4000-8000-000000000000', title: 'Gone' }, { file })

  const settled = []
  const out = await sendTray({ file, fetcher, settle: async (id, verb) => settled.push([id, verb]) })
  assert.equal(out.sent, 3)
  assert.equal(out.failed, 1)
  assert.deepEqual(out.items.map((i) => i.title), ['Gone'])
  assert.ok(out.items[0].error)
  assert.equal(store.object('SELECT raw FROM cards WHERE id = ?', ask.id).status, 'answered')
  assert.deepEqual(store.object('SELECT raw FROM cards WHERE id = ?', ask.id).result.answers[0].optionIds, ['l'])
  assert.equal(store.object('SELECT raw FROM cards WHERE id = ?', yes.id).status, 'accepted')
  assert.deepEqual(settled, [[yes.id, 'accept']])
  assert.equal(store.objects('SELECT raw FROM reviews WHERE job_id = ?', job.id).length, 1)
  assert.deepEqual(dropItem(out.items[0].key, { file }).items, [])
})

// ── guided reading of a change (lib/chapters.mjs) ─────────────────────────────────

test('a change is read in chapters: the heart first, what it touches, how it is checked, the glue; overviews asked once and kept', async () => {
  const { chaptersOf, guidedChange, kindOfFile, namesAdded } = await import('../server/lib/chapters.mjs')
  const hunk = (n, from = 0) => `@@ -${from},0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')}`
  const files = [
    { path: 'server/engine/marks.mjs', added: 300, removed: 0, patch: `@@ -0,0 +1,3 @@\n+export function sendReview() {}\n+function helper() {}\n+export const MARK_KINDS = ['text']` },
    { path: 'src/ui/marks.css', added: 80, removed: 0, patch: hunk(80) },
    { path: 'server/api.mjs', added: 4, removed: 0, patch: '@@ -10,0 +11,4 @@\n+import { sendReview } from "./engine/marks.mjs"\n+x\n+y\n+z' },
    { path: 'server/lib/other.mjs', added: 40, removed: 5, patch: hunk(40, 3) },
    { path: 'test/marks.test.mjs', added: 120, removed: 0, patch: hunk(120) },
    { path: 'package.json', added: 1, removed: 1, patch: '@@ -3 +3 @@\n-"1.0"\n+"1.1"' },
    { path: 'docs/marks.md', added: 20, removed: 0, patch: hunk(20) },
    { path: 'src/ui/tiny.js', added: 2, removed: 0, patch: '@@ -1,0 +2,2 @@\n+a\n+b' },
  ]
  assert.deepEqual(['a/test/x.mjs', 'tools/marks-test.mjs', 'docs/a.md', 'app.json', 'a.css', 'a.mjs'].map(kindOfFile), ['test', 'test', 'doc', 'settings', 'style', 'source'])
  assert.deepEqual(namesAdded(files[0]), ['sendReview', 'MARK_KINDS', 'helper'])
  const chapters = chaptersOf(files)
  assert.deepEqual(chapters.map((c) => [c.id, c.files.map((f) => f.path)]), [
    ['heart', ['server/engine/marks.mjs', 'src/ui/marks.css']],
    ['effects', ['server/api.mjs', 'server/lib/other.mjs']],
    ['checks', ['test/marks.test.mjs']],
    ['glue', ['package.json', 'docs/marks.md', 'src/ui/tiny.js']],
  ])
  assert.match(chapters[0].overview, /^2 files, \+380 −0; new: marks\.mjs, marks\.css\.\nAdds sendReview, MARK_KINDS, helper\.$/)
  // A cheap model's words replace the script's, once; the next reading reads them from the folder.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'overviews-'))
  let asked = 0
  const ask = async (command, prompt) => { asked += 1; assert.match(prompt, /## heart: The heart of it/); return { heart: 'It sends reviews.\nLook at the gate path.', glue: 'Version and notes.' } }
  const one = await guidedChange({ files, commits: [], branch: 'b', base: 'main' }, { overview: true, folder, command: 'cheap', ask })
  assert.deepEqual(one.chapters.map((c) => c.by), ['model', 'script', 'script', 'model'])
  assert.equal(one.chapters[0].overview, 'It sends reviews.\nLook at the gate path.')
  await guidedChange({ files, commits: [], branch: 'b', base: 'main' }, { overview: true, folder, command: 'cheap', ask })
  assert.equal(asked, 1)
  // No command, or one that answers nothing: the script's words stand.
  assert.equal((await guidedChange({ files }, { overview: true, folder, command: '', ask })).chapters[0].by, 'script')
  assert.equal((await guidedChange({ files: files.slice(1) }, { overview: true, folder, command: 'cheap', ask: async () => null })).chapters[0].by, 'script')
})
