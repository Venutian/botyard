/**
 * Botyard's own store: one SQLite file (`studio.db` in Botyard's home folder) that holds everything the
 * engine knows.
 *
 * Every row keeps its whole object in `raw`, exactly as the API gives it, next to a handful of plain
 * columns the list
 * questions filter and sort on. An answer is rebuilt from `raw`, so it comes out the way the crew's
 * scripts and the bots already read it; the columns only decide which rows and in what order.
 *
 * The write paths fill the store, `read.mjs` answers from it.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { TRACK_TABLES, TRACK_WHOLE_NUMBERS } from './track-tables.mjs'

export const SCHEMA_VERSION = 1

/** A date in any form it was written in, as the one form the columns are compared in. */
export const stamp = (value) => {
  if (value === null || value === undefined || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const text = (value) => (value === null || value === undefined ? null : String(value))
const whole = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.trunc(Number(value)) : null)
const flag = (value) => (value ? 1 : 0)
const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value))
/** A field under either spelling: the API says `issueId`, the database says `issue_id`. */
const either = (raw, camel) => {
  if (raw[camel] !== undefined) return raw[camel]
  return raw[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]
}
const col = (camel, as = text) => (raw) => as(either(raw, camel))

/**
 * The tables. `cols` are the plain columns, each with how it is read from the row's object; `more` are
 * further whole objects kept beside `raw` (a second view of the same thing); `packed`
 * objects are large and stored compressed. `key` is what makes a row the same row on the next import.
 */
export const TABLES = {
  company: {
    key: ['id'],
    cols: { id: col('id'), name: col('name'), description: col('description'), status: col('status'), issue_prefix: col('issuePrefix'), issue_counter: col('issueCounter', whole), updated_at: col('updatedAt', stamp) },
  },
  agents: {
    key: ['id'],
    cols: {
      id: col('id'), company_id: col('companyId'), name: col('name'), role: col('role'), title: col('title'), status: col('status'),
      reports_to: col('reportsTo'), adapter_type: col('adapterType'), url_key: col('urlKey'), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
    },
    indexes: [['company_id', 'created_at']],
  },
  agent_revisions: {
    key: ['id'],
    cols: { id: col('id'), agent_id: col('agentId'), position: (_, x) => whole(x.position), created_at: col('createdAt', stamp) },
    indexes: [['agent_id', 'position']],
  },
  // A bot's instructions as they were after each save: the text itself is in the row's object.
  instruction_revisions: {
    key: ['id'],
    cols: { id: col('id'), agent_id: col('agentId'), position: (_, x) => whole(x.position), created_at: col('createdAt', stamp) },
    indexes: [['agent_id', 'position']],
  },
  agent_runtime: {
    key: ['agent_id'],
    cols: { agent_id: col('agentId'), session_id: col('sessionId'), last_run_id: col('lastRunId'), updated_at: col('updatedAt', stamp) },
  },
  projects: {
    key: ['id'],
    cols: {
      id: col('id'), company_id: col('companyId'), name: col('name'), description: col('description'), status: col('status'), url_key: col('urlKey'),
      position: (_, x) => whole(x.position), archived_at: col('archivedAt', stamp), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
    },
    indexes: [['company_id', 'position']],
  },
  project_workspaces: {
    key: ['id'],
    cols: { id: col('id'), project_id: col('projectId'), name: col('name'), cwd: col('cwd'), repo_url: col('repoUrl'), repo_ref: col('repoRef'), is_primary: col('isPrimary', flag) },
    indexes: [['project_id']],
  },
  // A job is an "issue" in the API's paths. `raw` is the job's whole page (GET /issues/:id); `list_raw` is the
  // shorter row the job list gives, which carries a cut description and the last-activity time.
  jobs: {
    key: ['id'],
    more: ['list_raw'],
    cols: {
      id: col('id'), company_id: col('companyId'), identifier: col('identifier'), issue_number: col('issueNumber', whole), title: col('title'),
      description: col('description'), status: col('status'), priority: col('priority'), parent_id: col('parentId'), project_id: col('projectId'),
      assignee_agent_id: col('assigneeAgentId'), assignee_user_id: col('assigneeUserId'), created_by_agent_id: col('createdByAgentId'), created_by_user_id: col('createdByUserId'),
      assignee_adapter_overrides: col('assigneeAdapterOverrides', json), execution_workspace_id: col('executionWorkspaceId'),
      conversation_agent_id: col('conversationAgentId'), conversation_user_id: col('conversationUserId'), conversation_state: col('conversationState'),
      origin_kind: col('originKind'), harness_kind: col('harnessKind'), hidden_at: col('hiddenAt', stamp),
      started_at: col('startedAt', stamp), completed_at: col('completedAt', stamp), cancelled_at: col('cancelledAt', stamp),
      created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
      // When the job last moved.
      last_activity_at: (raw, x) => stamp(x.list_raw?.lastActivityAt ?? x.lastActivityAt ?? raw.lastActivityAt ?? raw.updatedAt),
    },
    indexes: [['company_id', 'status'], ['project_id'], ['assignee_agent_id'], ['parent_id'], ['updated_at'], ['identifier'], ['conversation_agent_id']],
  },
  job_relations: {
    key: ['id'],
    cols: { id: col('id'), job_id: col('issueId'), related_job_id: col('relatedIssueId'), type: col('type'), created_at: col('createdAt', stamp) },
    indexes: [['job_id'], ['related_job_id']],
  },
  comments: {
    key: ['id'],
    cols: {
      id: col('id'), job_id: col('issueId'), position: (_, x) => whole(x.position), author_agent_id: col('authorAgentId'), author_user_id: col('authorUserId'),
      body: col('body'), created_by_run_id: col('createdByRunId'), deleted_at: col('deletedAt', stamp), created_at: col('createdAt', stamp),
    },
    indexes: [['job_id', 'position']],
  },
  // A card is a question, a confirmation or a sign-in request a bot left on a job.
  cards: {
    key: ['id'],
    cols: { id: col('id'), job_id: col('issueId'), position: (_, x) => whole(x.position), kind: col('kind'), status: col('status'), created_at: col('createdAt', stamp), resolved_at: col('resolvedAt', stamp) },
    indexes: [['job_id', 'position'], ['status']],
  },
  documents: {
    key: ['id'],
    cols: { id: col('id'), title: col('title'), format: col('format'), latest_revision_id: col('latestRevisionId'), latest_revision_number: col('latestRevisionNumber', whole), body: col('body'), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp) },
  },
  // Which document a job holds under which name ("plan", "dispatch-brief").
  job_documents: {
    key: ['job_id', 'key'],
    raw: false,
    cols: { job_id: (_, x) => text(x.job_id), key: (_, x) => text(x.key), document_id: (_, x) => text(x.document_id), position: (_, x) => whole(x.position) },
    indexes: [['document_id']],
  },
  document_versions: {
    key: ['id'],
    cols: { id: col('id'), document_id: col('documentId'), job_id: col('issueId'), key: col('key'), position: (_, x) => whole(x.position), revision_number: col('revisionNumber', whole), created_at: col('createdAt', stamp) },
    indexes: [['document_id', 'position']],
  },
  attachments: {
    key: ['id'],
    cols: {
      id: col('id'), job_id: col('issueId'), position: (_, x) => whole(x.position), asset_id: col('assetId'), comment_id: col('issueCommentId'), filename: col('originalFilename'),
      content_type: col('contentType'), byte_size: col('byteSize', whole), object_key: col('objectKey'), created_at: col('createdAt', stamp),
    },
    indexes: [['job_id', 'position'], ['asset_id']],
  },
  // What a file is and where its bytes are: `object_key` is its place under the files folder.
  assets: {
    key: ['id'],
    cols: { id: col('id'), object_key: col('objectKey'), content_type: col('contentType'), byte_size: col('byteSize', whole), sha256: col('sha256'), filename: col('originalFilename'), file_path: (_, x) => text(x.file_path), created_at: col('createdAt', stamp) },
    indexes: [['object_key']],
  },
  products: {
    key: ['id'],
    cols: { id: col('id'), job_id: col('issueId'), project_id: col('projectId'), type: col('type'), title: col('title'), url: col('url'), status: col('status'), created_at: col('createdAt', stamp) },
    indexes: [['job_id']],
  },
  // A run is one time a bot was started. `raw` is the run's whole page and is large (it carries the
  // prompt the bot was given), so it is stored compressed. `summary_raw` is the row of the run list;
  // `live_raw` is the row shown while the run was still going.
  runs: {
    key: ['id'],
    packed: true,
    more: ['summary_raw', 'live_raw'],
    cols: {
      id: col('id'), company_id: col('companyId'), agent_id: col('agentId'), job_id: col('issueId'), status: col('status'), invocation_source: col('invocationSource'),
      trigger_detail: col('triggerDetail'), wakeup_request_id: col('wakeupRequestId'), started_at: col('startedAt', stamp), finished_at: col('finishedAt', stamp),
      error: col('error'), error_code: col('errorCode'), exit_code: col('exitCode', whole), usage_json: col('usageJson', json), result_json: col('resultJson', json),
      session_id_before: col('sessionIdBefore'), session_id_after: col('sessionIdAfter'), log_ref: col('logRef'), log_bytes: col('logBytes', whole),
      stdout_excerpt: col('stdoutExcerpt'), stderr_excerpt: col('stderrExcerpt'), retry_of_run_id: col('retryOfRunId'),
      created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp),
    },
    indexes: [['company_id', 'created_at'], ['agent_id', 'created_at'], ['job_id', 'created_at'], ['status']],
  },
  // A job's own list of runs, in the shape and order its page shows them.
  job_runs: {
    key: ['job_id', 'run_id'],
    cols: { job_id: (_, x) => text(x.job_id), run_id: col('runId'), position: (_, x) => whole(x.position) },
    indexes: [['job_id', 'position'], ['run_id']],
  },
  wakes: {
    key: ['id'],
    cols: { id: col('id'), agent_id: col('agentId'), source: col('source'), reason: col('reason'), status: col('status'), run_id: col('runId'), requested_at: col('requestedAt', stamp), finished_at: col('finishedAt', stamp) },
    indexes: [['agent_id', 'requested_at'], ['status']],
  },
  // Where a bot left off on a job: the engine's own session id and the folder it was working in.
  sessions: {
    key: ['id'],
    cols: { id: col('id'), agent_id: col('agentId'), position: (_, x) => whole(x.position), adapter_type: col('adapterType'), task_key: col('taskKey'), last_run_id: col('lastRunId'), updated_at: col('updatedAt', stamp) },
    indexes: [['agent_id', 'position'], ['task_key']],
  },
  // Tokens and cost, one row per run and model.
  usage: {
    key: ['id'],
    cols: {
      id: col('id'), company_id: col('companyId'), run_id: col('heartbeatRunId'), agent_id: col('agentId'), job_id: col('issueId'), project_id: col('projectId'),
      provider: col('provider'), biller: col('biller'), billing_type: col('billingType'), model: col('model'), cost_status: col('costStatus'), receipt_hash: col('receiptHash'),
      input_tokens: col('inputTokens', whole), cached_input_tokens: col('cachedInputTokens', whole), output_tokens: col('outputTokens', whole),
      // Kept as the text Postgres gives, so a sum can be exact to the last decimal.
      cost_cents: (raw) => text(raw.cost_cents_text ?? either(raw, 'costCents') ?? '0'), occurred_at: col('occurredAt', stamp),
    },
    indexes: [['company_id', 'occurred_at'], ['run_id'], ['agent_id']],
  },
  routines: {
    key: ['id'],
    more: ['list_raw'],
    cols: { id: col('id'), company_id: col('companyId'), title: col('title'), status: col('status'), project_id: col('projectId'), assignee_agent_id: col('assigneeAgentId'), position: (_, x) => whole(x.position), created_at: col('createdAt', stamp), updated_at: col('updatedAt', stamp) },
    indexes: [['company_id', 'position']],
  },
  routine_triggers: {
    key: ['id'],
    cols: { id: col('id'), routine_id: (raw, x) => text(x.routine_id ?? either(raw, 'routineId')), kind: col('kind'), enabled: col('enabled', flag), cron_expression: col('cronExpression'), timezone: col('timezone'), next_run_at: col('nextRunAt', stamp) },
    indexes: [['routine_id']],
  },
  routine_runs: {
    key: ['id'],
    cols: { id: col('id'), routine_id: col('routineId'), position: (_, x) => whole(x.position), status: col('status'), job_id: col('linkedIssueId'), triggered_at: col('triggeredAt', stamp) },
    indexes: [['routine_id', 'position']],
  },
  routine_revisions: {
    key: ['id'],
    cols: { id: col('id'), routine_id: col('routineId'), position: (_, x) => whole(x.position), revision_number: col('revisionNumber', whole), created_at: col('createdAt', stamp) },
    indexes: [['routine_id', 'position']],
  },
  activity: {
    key: ['id'],
    cols: { id: col('id'), action: col('action'), entity_type: col('entityType'), entity_id: col('entityId'), actor_type: col('actorType'), actor_id: col('actorId'), agent_id: col('agentId'), run_id: col('runId'), created_at: col('createdAt', stamp) },
    indexes: [['entity_type', 'entity_id'], ['created_at'], ['run_id']],
  },
  // The folder (a git worktree) a job is worked in.
  workspaces: {
    key: ['id'],
    cols: { id: col('id'), project_id: col('projectId'), job_id: col('sourceIssueId'), name: col('name'), status: col('status'), cwd: col('cwd'), branch: col('branchName'), base_ref: col('baseRef'), updated_at: col('updatedAt', stamp) },
    indexes: [['job_id'], ['project_id']],
  },
  // Tracks: saved ways for work to move, their requests, trips and steps (docs/tracks.md).
  ...TRACK_TABLES,
}

const WHOLE_NUMBERS = new Set(['issue_number', 'issue_counter', 'position', 'latest_revision_number', 'revision_number', 'byte_size', 'log_bytes', 'exit_code', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'is_primary', 'enabled', ...TRACK_WHOLE_NUMBERS])
const sqlType = (name) => (WHOLE_NUMBERS.has(name) ? 'INTEGER' : 'TEXT')

function createSql(name, table) {
  const cols = Object.keys(table.cols).map((c) => `"${c}" ${sqlType(c)}`)
  if (table.raw !== false) cols.push(`"raw" ${table.packed ? 'BLOB' : 'TEXT'}`)
  for (const extra of table.more || []) cols.push(`"${extra}" TEXT`)
  const out = [`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')}, PRIMARY KEY (${table.key.map((k) => `"${k}"`).join(', ')}))`]
  for (const index of table.indexes || []) out.push(`CREATE INDEX IF NOT EXISTS "${name}_by_${index.join('_')}" ON "${name}" (${index.map((k) => `"${k}"`).join(', ')})`)
  return out
}

const pack = (object) => zlib.deflateSync(Buffer.from(JSON.stringify(object)))
/** A stored object back as it was: text, or the compressed bytes of a large one. */
export function unpack(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value)
  return JSON.parse(zlib.inflateSync(value).toString())
}

/**
 * Open the store, making the file and its tables on first use. `:memory:` gives a store that lives
 * only as long as the caller holds it.
 */
export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  const found = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  const version = found ? Number(found.value) : 0
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`This store was written by a newer Botyard (schema ${version}, this one knows ${SCHEMA_VERSION})`)
  }
  // A table added since the store was made is added on open: making one changes nothing that is there.
  db.exec('BEGIN')
  for (const [name, table] of Object.entries(TABLES)) for (const sql of createSql(name, table)) db.exec(sql)
  db.exec('COMMIT')
  if (version < SCHEMA_VERSION) {
    // Version 1 is the first: later versions add their steps here, each run once and in order.
    db.exec('BEGIN')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(SCHEMA_VERSION))
    db.exec('COMMIT')
  }

  const prepared = new Map()
  const statement = (sql) => {
    if (!prepared.has(sql)) prepared.set(sql, db.prepare(sql))
    return prepared.get(sql)
  }
  const known = (name) => {
    const table = TABLES[name]
    if (!table) throw new Error(`The store has no table called ${name}`)
    return table
  }
  let depth = 0

  const store = {
    file,
    db,
    version: SCHEMA_VERSION,

    /** Everything inside `work` is written together or not at all. */
    tx(work) {
      if (depth > 0) return work()
      db.exec('BEGIN')
      depth += 1
      try {
        const result = work()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        depth -= 1
      }
    },

    /**
     * Write one row from its object. The same key written again replaces the row, so an import can run
     * any number of times. `extra` carries what the object itself does not say: its place in a list,
     * the job it hangs under, a second view of it.
     */
    put(name, raw, extra = {}) {
      const table = known(name)
      const names = Object.keys(table.cols)
      const values = names.map((c) => table.cols[c](raw || {}, extra))
      if (table.raw !== false) {
        names.push('raw')
        values.push(table.packed ? pack(raw) : JSON.stringify(raw))
      }
      for (const more of table.more || []) {
        names.push(more)
        values.push(json(extra[more]))
      }
      for (const k of table.key) if (values[names.indexOf(k)] === null) throw new Error(`A ${name} row needs its ${k}`)
      const sql = `INSERT INTO "${name}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')}) `
        + `ON CONFLICT (${table.key.map((k) => `"${k}"`).join(', ')}) DO UPDATE SET ${names.filter((n) => !table.key.includes(n)).map((n) => `"${n}" = excluded."${n}"`).join(', ') || `"${table.key[0]}" = excluded."${table.key[0]}"`}`
      statement(sql).run(...values)
    },

    /** Set columns of one row without touching its object (a file's new place, a second view). */
    patch(name, id, fields) {
      const table = known(name)
      const names = Object.keys(fields)
      for (const n of names) if (!(n in table.cols) && !(table.more || []).includes(n)) throw new Error(`${name} has no column ${n}`)
      const values = names.map((n) => ((table.more || []).includes(n) ? json(fields[n]) : fields[n]))
      statement(`UPDATE "${name}" SET ${names.map((n) => `"${n}" = ?`).join(', ')} WHERE "${table.key[0]}" = ?`).run(...values, id)
    },

    /** The rows hanging under one parent (a job's comments), swapped for the list just read. */
    replace(name, column, value, rows, extraOf = () => ({})) {
      const table = known(name)
      if (!(column in table.cols)) throw new Error(`${name} has no column ${column}`)
      store.tx(() => {
        statement(`DELETE FROM "${name}" WHERE "${column}" = ?`).run(value)
        rows.forEach((raw, position) => store.put(name, raw, { position, ...extraOf(raw, position) }))
      })
    },

    /** Take one row out by its key. */
    drop(name, id) {
      const table = known(name)
      statement(`DELETE FROM "${name}" WHERE "${table.key[0]}" = ?`).run(id)
    },

    remove(name, column, value) {
      const table = known(name)
      if (!(column in table.cols)) throw new Error(`${name} has no column ${column}`)
      statement(`DELETE FROM "${name}" WHERE "${column}" = ?`).run(value)
    },

    /** Rows as plain column values. The SQL is the caller's own, never built from a request's text. */
    rows: (sql, ...params) => statement(sql).all(...params),
    row: (sql, ...params) => statement(sql).get(...params) || null,
    /** The stored objects of the rows a query finds, in its order. `field` picks which view. */
    objects: (sql, ...params) => statement(sql).all(...params).map((r) => unpack(r.raw)),
    object: (sql, ...params) => {
      const found = statement(sql).get(...params)
      return found ? unpack(found.raw) : null
    },

    count: (name) => statement(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
    counts() {
      const out = {}
      for (const name of Object.keys(TABLES)) out[name] = store.count(name)
      return out
    },


    meta: (key) => statement('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    setMeta: (key, value) => { statement('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)) },

    /** Fold the write-ahead file back into the store, so the one file holds everything. */
    settle: () => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') },

    close() {
      prepared.clear()
      db.close()
    },
  }
  return store
}
