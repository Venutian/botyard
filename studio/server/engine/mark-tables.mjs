/**
 * The store's table for reviews: the owner's marks on one piece of a bot's work, sent as one message.
 * Kept apart, like the track tables, so the store and the marks code both read it without one
 * importing the other. The whole review is in `raw`; the columns only find and sort rows.
 */
const stamp = (value) => {
  if (value === null || value === undefined || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const text = (value) => (value === null || value === undefined ? null : String(value))
const col = (name, as = text) => (raw) => as(raw[name])

export const MARK_TABLES = {
  reviews: {
    key: ['id'],
    cols: {
      id: col('id'), company_id: col('companyId'), job_id: col('jobId'), project_id: col('projectId'), verdict: col('verdict'),
      piece_kind: (raw) => text(raw.piece?.kind), created_at: col('createdAt', stamp),
    },
    indexes: [['job_id', 'created_at'], ['company_id', 'created_at'], ['project_id', 'created_at']],
  },
}
