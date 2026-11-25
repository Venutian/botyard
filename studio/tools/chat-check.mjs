#!/usr/bin/env node
/**
 * The proof that a bot answers in chat on this computer: the first-run guide's "Say hello to a bot"
 * step, done through the page's own API against a running Botyard.
 *
 *   node tools/chat-check.mjs [http://127.0.0.1:5274] [--minutes 6] [--any-outcome]
 *
 * It finds the yard's lead bot (the starter crew is added first when the yard has none), says hello
 * and waits for the bot's answer. It prints the chat as it ends. Status 0 when the bot answered;
 * 1 when the bot could not answer (its reason is printed) or nothing came in time. With
 * --any-outcome a run that started and ended with a reason other than a missing tool also passes,
 * for a computer whose free models are used up for today.
 */
const args = process.argv.slice(2)
const at = (args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:5274').replace(/\/$/, '')
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 6
const anyOutcome = args.includes('--any-outcome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(path, body) {
  const res = await fetch(at + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: at, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${body ? 'POST' : 'GET'} ${path} answered ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

for (let i = 0; ; i++) {
  try { await call('/api/studio/first-run'); break } catch (err) { if (i > 60) { console.log(`FAIL Botyard does not answer at ${at}: ${err.message}`); process.exit(1) } await sleep(2000) }
}

let { chats } = await call('/api/studio/chats')
if (!chats?.length) {
  await call('/api/studio/bot', { action: 'starter' })
  ;({ chats } = await call('/api/studio/chats'))
}
const lead = chats.find((c) => !c.reportsTo) || chats[0]
if (!lead) { console.log('FAIL the yard has no bot to talk to'); process.exit(1) }
const botId = lead.bot?.id || lead.botId || lead.id
console.log(`ok   talking to ${lead.name || lead.bot?.name || botId}`)

await call('/api/studio/chat', { bot: botId, text: 'Hello! Reply with one short sentence.' })
const until = Date.now() + minutes * 60_000
let thread
while (Date.now() < until) {
  await sleep(5000)
  thread = await call(`/api/studio/chat?bot=${encodeURIComponent(botId)}`)
  const answered = thread.messages?.some((m) => !m.mine && String(m.text || '').trim())
  if (answered || thread.stopped) break
}
for (const m of thread?.messages || []) console.log(`     ${m.mine ? 'you' : m.from}: ${String(m.text || '').slice(0, 300).replace(/\s+/g, ' ')}`)
const answer = thread?.messages?.find((m) => !m.mine && String(m.text || '').trim())
if (answer) { console.log('ok   the bot answered'); process.exit(0) }
if (thread?.stopped) {
  console.log(`     the bot could not answer: ${thread.stopped.why}`)
  const missingTool = /ENOENT|not installed on this computer|cannot find it/i.test(thread.stopped.why || '')
  if (anyOutcome && !missingTool) { console.log('ok   the tool started (no answer: see the reason above)'); process.exit(0) }
  console.log('FAIL the bot could not answer'); process.exit(1)
}
console.log(`FAIL no answer in ${minutes} minutes`); process.exit(1)
