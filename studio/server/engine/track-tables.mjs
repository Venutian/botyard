/**
 * The store's tables for tracks (docs/tracks.md): saved tracks and their versions, requests, trips and
 * each try of each step. Kept apart so the store and the track runner both read them without one
 * importing the other. Each row keeps its whole object in `raw`; the columns only find and sort rows.
 */
const stamp = (value) => {
  if (value === null || value === undefined || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const text = (value) => (value === null || value === undefined ? null : String(value))
const whole = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.trunc(Number(value)) : null)
const col = (name, as = text) => (raw) => as(raw[name])

export const TRACK_TABLES = {
  tracks: {
    key: ['id'],
    cols: { id: col('id'), company_id: col('companyId'), key: col('key'), title: col('title'), status: col('status'), version: col('version', whole), updated_at: col('updatedAt', stamp) },
    indexes: [['company_id', 'key']],
  },
  track_versions: {
    key: ['id'],
    cols: { id: col('id'), track_id: col('trackId'), version: col('version', whole), created_at: col('createdAt', stamp) },
    indexes: [['track_id', 'version']],
  },
  requests: {
    key: ['id'],
    cols: {
      id: col('id'), company_id: col('companyId'), project_id: col('projectId'), job_id: col('jobId'), track_id: col('trackId'),
      status: col('status'), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
    },
    indexes: [['company_id', 'status'], ['job_id']],
  },
  trips: {
    key: ['id'],
    cols: {
      id: col('id'), request_id: col('requestId'), track_id: col('trackId'), version: col('version', whole), status: col('status'),
      parent_trip_id: col('parentTripId'), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
    },
    indexes: [['request_id'], ['status'], ['parent_trip_id']],
  },
  trip_steps: {
    key: ['id'],
    cols: {
      id: col('id'), trip_id: col('tripId'), step_id: col('stepId'), try_number: col('try', whole), status: col('status'), job_id: col('jobId'),
      started_at: col('startedAt', stamp), finished_at: col('finishedAt', stamp), created_at: col('createdAt', stamp),
    },
    indexes: [['trip_id', 'created_at'], ['job_id'], ['status']],
  },
}

/** Whole-number columns of these tables. */
export const TRACK_WHOLE_NUMBERS = ['version', 'try_number']
