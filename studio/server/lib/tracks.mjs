/**
 * Tracks as the page and the phone show them (docs/tracks.md): the saved tracks, the requests on them
 * and their cost, one trip step by step, and what the owner does to a trip. Everything is asked of
 * the engine; this only shapes it for a screen and says no in plain words.
 */
import { EngineError, call, companyId } from './engine.mjs'

const ACTIONS = new Set(['approve', 'back', 'context', 'rerun', 'pause', 'resume', 'stop'])
const MAX_NOTE = 4000

/** Money as the sheets show it: dollars to the cent, a tenth of a cent when it is less. */
export function dollars(usd) {
  const n = Number(usd) || 0
  if (n === 0) return '$0'
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

const STATE_WORDS = {
  running: 'Moving', paused: 'Paused', 'not-in-main': 'Done, not in main', done: 'Finished', stuck: 'Stuck', stopped: 'Stopped',
}
const REQUEST_WORDS = { working: 'Moving', 'not-in-main': 'Done, not in main', done: 'Finished', stopped: 'Stopped' }

/** One request as a row: what was asked, its track, where its trip stands, what it cost. */
export function requestRow(r) {
  const trip = r.trip || {}
  const at = trip.status === 'running' && trip.currentTitle ? `${trip.currentTitle}${trip.currentKind === 'gate' ? ' (waits for you)' : ''}` : STATE_WORDS[trip.status] || ''
  return {
    id: r.id, job: r.jobCode || '', jobId: r.jobId, title: r.title, track: r.trackKey, status: r.status, state: REQUEST_WORDS[r.status] || r.status,
    at, tripId: trip.id || '', tripStatus: trip.status || '', waitsForOwner: trip.status === 'running' && trip.currentKind === 'gate', reason: trip.reason || '',
    costUsd: Number(r.cost?.usd) || 0, cost: dollars(r.cost?.usd), tokens: (r.cost?.inputTokens || 0) + (r.cost?.outputTokens || 0), updatedAt: r.updatedAt,
  }
}

/** The saved tracks, each with its steps and lines, and the newest requests. */
export async function tracksPage(options) {
  const co = await companyId(options)
  const [tracks, requests] = await Promise.all([call(`/companies/${co}/tracks`, options), call(`/companies/${co}/requests?limit=60`, options)])
  return {
    tracks: tracks.map((t) => ({ id: t.id, key: t.key, title: t.title, description: t.description || '', version: t.version, builtIn: Boolean(t.builtIn), steps: t.current?.steps || [], lines: t.current?.lines || [], delivers: t.current?.delivers || 'change' })),
    requests: requests.map(requestRow),
  }
}

/** One trip as the run view draws it: the steps in order with their state, result and cost. */
export async function tripPage(id, options) {
  if (!id) throw new EngineError(400, 'Say which trip')
  const trip = await call(`/trips/${encodeURIComponent(id)}`, options)
  const request = await call(`/requests/${encodeURIComponent(trip.requestId)}`, options)
  const steps = trip.steps.map((s) => ({
    id: s.id, kind: s.kind, title: s.title, state: s.state, needs: s.needs, leaves: s.leaves, bot: s.bot || '', ruling: Boolean(s.ruling),
    tries: s.tries.length, current: trip.current === s.id, ask: s.kind === 'gate' ? s.latest?.ask || null : null,
    verdict: s.latest?.snapshot?.verdict || '', findings: s.latest?.snapshot?.findings || '', summary: s.latest?.snapshot?.summary || '',
    leftNames: Object.keys(s.latest?.snapshot?.leaves || {}), left: s.latest?.snapshot?.leaves || {}, numbers: s.latest?.snapshot?.numbers || {},
    job: s.latest?.jobCode || '', jobId: s.latest?.jobId || '', note: s.latest?.inputs?.note || '', handedFindings: s.latest?.inputs?.findings || '',
    costUsd: Number(s.cost?.usd) || 0, cost: dollars(s.cost?.usd), startedAt: s.latest?.startedAt || '', finishedAt: s.latest?.finishedAt || '',
  }))
  const gate = trip.status === 'running' ? steps.find((s) => s.current && s.kind === 'gate' && s.state === 'working') : null
  return {
    id: trip.id, status: trip.status, state: STATE_WORDS[trip.status] || trip.status, reason: trip.reason || '', current: trip.current, rounds: trip.rounds || {},
    track: trip.track, lines: trip.track.lines, steps, cost: dollars(trip.cost?.usd), costUsd: Number(trip.cost?.usd) || 0,
    request: requestRow(request), commit: trip.commit || '',
    gate: gate ? { step: gate.id, title: gate.title, ask: gate.ask, backTo: steps.slice(0, steps.indexOf(gate)).map((s) => ({ id: s.id, title: s.title })) } : null,
    can: { pause: trip.status === 'running', resume: trip.status === 'paused', stop: !['done', 'stopped'].includes(trip.status), rerun: steps.map((s) => s.id) },
  }
}

/**
 * The owner's hand on a trip. At a gate: approve; back (to an earlier step, with a note); context (a note,
 * and the step before the gate runs again). Any time: rerun from a step (with a note), pause, resume, stop.
 */
export async function tripAct(id, { action, step = '', to = '', note = '' } = {}, options) {
  if (!id) throw new EngineError(400, 'Say which trip')
  if (!ACTIONS.has(action)) throw new EngineError(400, `A trip can be: ${[...ACTIONS].join(', ')}`)
  const said = String(note || '').slice(0, MAX_NOTE)
  const path = `/trips/${encodeURIComponent(id)}`
  if (['approve', 'back', 'context'].includes(action)) await call(`${path}/gate`, { ...options, method: 'POST', body: { action, to: to || undefined, note: said } })
  else if (action === 'rerun') await call(`${path}/rerun`, { ...options, method: 'POST', body: { step, note: said } })
  else await call(`${path}/${action}`, { ...options, method: 'POST', body: {} })
  return tripPage(id, options)
}
