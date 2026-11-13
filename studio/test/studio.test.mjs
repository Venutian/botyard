/**
 * The map draws the yard's own crew. These tests pin where each bot stands: in the bay of the
 * project its job belongs to, or in the depot when it has none.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CREW_ROOM, SCREENS, faceName, studioRoster } from '../server/lib/studio.mjs'

const NOW = Date.parse('2026-11-10T13:00:00Z')
const ago = (minutes) => NOW - minutes * 60_000
const records = {
  projects: [
    { id: 'p-harbour', name: 'Harbour', primaryWorkspace: { cwd: '/home/o/harbour' } },
    { id: 'p-studio', name: 'Botyard', workspaces: [{ cwd: '/home/o/studio' }] },
  ],
  agents: [{ id: 'freelancer', name: 'Freelancer' }, { id: 'lead', name: 'Lead' }, { id: 'critic', name: 'Critic' }],
  issues: [
    { identifier: 'LH-7', title: 'Town kit', status: 'in_progress', projectId: 'p-harbour', assigneeAgentId: 'freelancer' },
    { identifier: 'LH-8', title: 'Old job', status: 'cancelled', projectId: 'p-harbour', assigneeAgentId: 'freelancer' },
    { identifier: 'LH-9', title: 'Door fix', status: 'blocked', projectId: 'p-studio', assigneeAgentId: 'lead' },
  ],
}
const manager = {
  bots: [
    { id: 'freelancer', name: 'Freelancer', title: 'Builder', status: 'running', model: 'DeepSeek', where: 'free', why: '', projectId: 'p-harbour', job: { id: 'j7', ref: 'LH-7', title: 'Town kit', stage: 'Building', minutes: 4 }, last: null },
    { id: 'lead', name: 'Lead', title: 'Director', status: 'idle', model: 'Sonnet 5.5', where: 'Claude', why: '', projectId: 'p-studio', job: null, last: { id: 'j9', ref: 'LH-9', title: 'Door fix', at: ago(50) } },
    { id: 'critic', name: 'Critic', title: '', status: 'paused', model: 'Opus 5.5', where: 'Claude', why: 'Paused by hand', projectId: '', job: null, last: null },
  ],
}
const roster = () => studioRoster({ manager, records, now: NOW })
const byId = (list, id) => list.find((t) => t.id === id)

test('each bot of the crew is a character in the room of its job', () => {
  const list = roster()
  const freelancer = byId(list, 'crew:freelancer:p-harbour')
  assert.deepEqual([freelancer.project, freelancer.title, freelancer.running, freelancer.crew.job.ref, freelancer.canOpen], ['Harbour', 'Freelancer', true, 'LH-7', false])
  assert.ok(freelancer.size > 1)
  // Its last job was in Botyard and its thread still says so, but with no job now it waits in the depot.
  const lead = byId(list, 'crew:lead:p-studio')
  assert.deepEqual([lead.project, lead.running, lead.hasError, lead.preview], ['Depot', false, true, 'Last on LH-9 Door fix'])
  assert.equal(lead.crew.job, null)
  // Given a job there again, the same character (same thread id) stands in that project's bay.
  const job = { id: 'j9', ref: 'LH-9', title: 'Door fix', stage: 'Building', minutes: 1 }
  const busy = studioRoster({ manager: { bots: manager.bots.map((b) => (b.id === 'lead' ? { ...b, status: 'running', job } : b)) }, records, now: NOW })
  assert.deepEqual([byId(busy, 'crew:lead:p-studio').project, byId(busy, 'crew:lead:p-studio').crew.job.ref], ['Botyard', 'LH-9'])
  assert.equal(byId(busy, 'crew:freelancer:p-harbour').project, 'Harbour')
  const critic = byId(list, 'crew:critic:none')
  assert.equal(critic.project, 'Depot')
  assert.ok(NOW - critic.lastActivityAt > 3 * 24 * 3600_000, 'a paused bot is asleep')
})

test('the map shows only the crew, in projects and the depot: no screen keepers', () => {
  const list = roster()
  assert.deepEqual(list.filter((t) => t.screen || t.harness === 'screen' || String(t.id).startsWith('screen:')), [])
  assert.deepEqual(list.map((t) => t.id).sort(), ['crew:critic:none', 'crew:freelancer:p-harbour', 'crew:lead:p-studio'], 'the crew, and nobody else')
  assert.ok(list.every((t) => t.crew && t.harness === 'crew' && t.canOpen === false), 'every character is a bot of the yard')
  assert.deepEqual([...new Set(list.map((t) => t.project))].sort(), ['Depot', 'Harbour'])
  // The bot whose last job was in Botyard does not hold that project's bay open.
  assert.deepEqual(list.filter((t) => t.project === 'Botyard'), [])
  assert.deepEqual(list.map((t) => [t.id, t.project]).sort(), [['crew:critic:none', 'Depot'], ['crew:freelancer:p-harbour', 'Harbour'], ['crew:lead:p-studio', 'Depot']])
  for (const screen of SCREENS) assert.equal(list.some((t) => t.project === screen.room), false, `${screen.room} is not a room on the map`)
  // The screens are still told to the page, which opens them from the dock.
  assert.deepEqual(SCREENS.map((s) => [s.id, s.room, s.name]), [['chats', 'Chat room', 'Chats'], ['manager', "Manager's office", 'Manager'], ['settings', 'Control room', 'Settings']])
})

test('a bot without a job stands in the depot', () => {
  assert.equal(CREW_ROOM, 'Depot')
  const idle = { id: 'spare', name: 'Spare', title: '', status: 'idle', model: 'Sonnet 5.5', where: 'Claude', why: '', projectId: '', job: null, last: null }
  // Stopped with its project still on it from the last job, and at work in Botyard.
  const stopped = { ...idle, id: 'halted', name: 'Halted', status: 'stopped', projectId: 'p-harbour', last: { id: 'j8', ref: 'LH-8', title: 'Old job', at: ago(90) } }
  const hand = { ...idle, id: 'hand', name: 'Hand', status: 'running', projectId: 'p-studio', job: { id: 'j9', ref: 'LH-9', title: 'Door fix', stage: 'Building', minutes: 2 } }
  const list = studioRoster({ manager: { bots: [...manager.bots, idle, stopped, hand] }, records, now: NOW })
  const inDepot = list.filter((t) => t.project === CREW_ROOM)
  assert.deepEqual(inDepot.map((t) => [t.id, t.title]).sort(), [['crew:critic:none', 'Critic'], ['crew:halted:p-harbour', 'Halted'], ['crew:lead:p-studio', 'Lead'], ['crew:spare:none', 'Spare']], 'paused, stopped or free, with a project or none, a bot with no job waits in the depot')
  assert.equal(list.some((t) => t.project === 'Crew room'), false, 'the old name is gone')
  // Only a bot with a job stands in a project's bay, and it is the bay of that job.
  assert.deepEqual(list.filter((t) => t.crew && t.project !== CREW_ROOM).map((t) => [t.id, t.project, Boolean(t.crew.job)]).sort(), [['crew:freelancer:p-harbour', 'Harbour', true], ['crew:hand:p-studio', 'Botyard', true]])
  for (const bot of inDepot) assert.equal(bot.crew.job, null, `${bot.title} has no job`)
})

test('a portrait is found by the bot\'s name', () => {
  assert.deepEqual(['Lead', 'Senior Builder', 'Second Builder'].map(faceName), ['lead', 'senior-builder', 'second-builder'])
})

test("Needs you's list and a chat's cards are kept apart, so opening a bot never breaks the dock", async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/ui/studio.js', import.meta.url), 'utf8')
  // _cards is the Needs you list (an array, read by index and filtered); a chat's own cards are a Map by id.
  assert.doesNotMatch(src, /this\._cards\s*=\s*new Map/)
  assert.doesNotMatch(src, /this\._cards\?*\.get\(/)
  assert.match(src, /this\._chatCards\s*=\s*new Map/)
})
