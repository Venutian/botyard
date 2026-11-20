/**
 * What a run used, as its own share. Some tools report a resumed session's running total instead of the
 * run's own share, so a run that carries on a session would count everything before it again:
 *
 * - Claude Code's closing line gives `total_cost_usd` for the whole session so far. Its token counts
 *   are the run's own.
 * - Codex's `turn.completed` gives the thread's token counts so far.
 *
 * The engine books each run's own share and keeps what the tool printed under `reported`, so the next
 * run of the same session can take its share from it. A number that is lower than the last one means
 * the tool started counting again (a new thread under the same id), and is the run's own as it is.
 * Every reader (the pages, the crew's scripts) can then add runs up as they are.
 */
import { pack, unpack } from './store.mjs'

const TOKENS = ['inputTokens', 'cachedInputTokens', 'outputTokens']

/** Which numbers a tool reports as a session's running total. */
export const RUNNING_TOTALS = {
  claude_local: ['costUsd'],
  codex_local: TOKENS,
}

/** The tool a run used, for a run booked before its adapter was written down: told from its model. */
export function adapterOfModel(model) {
  const m = String(model || '').toLowerCase()
  if (m.startsWith('claude') || m === 'mixed') return 'claude_local'
  if (m.startsWith('gpt') || m.includes('codex')) return 'codex_local'
  return ''
}

/**
 * A run's own usage from what its tool printed (`reported`) and what the tool printed for the run before
 * it in the same session (`before`, or null for a fresh session).
 */
export function ownShare(adapterType, reported, before) {
  const out = { ...reported }
  const totals = RUNNING_TOTALS[adapterType] || []
  for (const key of totals) {
    const now = reported[key]
    const then = before ? before[key] : null
    if (typeof now !== 'number' || typeof then !== 'number' || now < then) continue
    out[key] = key === 'costUsd' ? Math.round((now - then) * 1e7) / 1e7 : now - then
  }
  out.perRun = true
  if (totals.length) out.reported = Object.fromEntries(totals.map((k) => [k, reported[k] ?? null]))
  return out
}

/** What the tool printed for a run: its own `reported` numbers, or, for a run booked before this, its usage as it stands. */
const printed = (usage) => ({ ...(usage || {}), ...((usage && usage.reported) || {}) })

/**
 * What the tool printed for the last run of `agentId` that ended in `session`, before `createdAt`; null
 * when there is none.
 */
export function lastPrinted(store, agentId, session, createdAt) {
  if (!session) return null
  const row = store.row('SELECT usage_json FROM runs WHERE agent_id = ? AND session_id_after = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1', agentId, session, createdAt)
  if (!row || !row.usage_json) return null
  try { return printed(JSON.parse(row.usage_json)) } catch { return null }
}

const MARK = 'usage_per_run'

/**
 * Turn every run booked before this into its own share, once: the store remembers it was done. Only the
 * usage of a run and of its usage rows is changed; nothing else on the run is touched.
 * Returns how many runs changed.
 */
export function convertBookedRuns(store) {
  if (store.meta(MARK)) return 0
  const last = new Map()
  let changed = 0
  const setRun = store.db.prepare('UPDATE runs SET raw = ?, usage_json = ?, summary_raw = ? WHERE id = ?')
  const setUsage = store.db.prepare('UPDATE usage SET raw = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ? WHERE id = ?')
  store.tx(() => {
    for (const row of store.rows('SELECT id, agent_id, session_id_before, session_id_after, raw, summary_raw FROM runs ORDER BY created_at, id')) {
      const run = unpack(row.raw)
      const usage = run && run.usageJson
      if (!usage || typeof usage !== 'object' || usage.perRun) {
        if (row.session_id_after && usage) last.set(`${row.agent_id} ${row.session_id_after}`, printed(usage))
        continue
      }
      const adapter = adapterOfModel(usage.model)
      const before = row.session_id_before ? last.get(`${row.agent_id} ${row.session_id_before}`) || null : null
      const own = ownShare(adapter, usage, before)
      if (row.session_id_after) last.set(`${row.agent_id} ${row.session_id_after}`, printed(own))
      let summary = row.summary_raw
      if (summary) {
        try {
          const s = JSON.parse(summary)
          for (const k of TOKENS) if (s[k] !== undefined && s[k] !== null) s[k] = String(own[k] ?? 0)
          summary = JSON.stringify(s)
        } catch { /* left as it was */ }
      }
      setRun.run(pack({ ...run, usageJson: own }), JSON.stringify(own), summary, row.id)
      for (const u of store.objects('SELECT raw FROM usage WHERE run_id = ?', row.id)) {
        const next = { ...u, inputTokens: own.inputTokens ?? 0, cachedInputTokens: own.cachedInputTokens ?? 0, outputTokens: own.outputTokens ?? 0 }
        setUsage.run(JSON.stringify(next), next.inputTokens, next.cachedInputTokens, next.outputTokens, u.id)
      }
      changed += 1
    }
    store.setMeta(MARK, new Date().toISOString())
  })
  return changed
}
