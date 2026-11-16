/**
 * How a job is shown. Its engine code (`NGE-326`, the studio's letters and the job's number) is the
 * stable key and never changes. The code people read is the project's own letters with the same
 * number (`BAL-326`); a job with no project reads `CREW-326`. Both forms name the same job.
 */
export const NO_PROJECT_CODE = 'CREW'
const SHAPE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/
export const PROJECT_CODE = /^[A-Z]{2,6}$/

const companyPrefix = (store) => store.object('SELECT raw FROM company LIMIT 1')?.issuePrefix || ''

/** The letters a project's jobs are shown with, or null when it has none yet. */
export function codeOfProject(store, projectId) {
  if (!projectId) return NO_PROJECT_CODE
  return store.object('SELECT raw FROM projects WHERE id = ?', projectId)?.code || null
}

/** `BAL-326` for the job whose engine code is `NGE-326`; the engine code itself when its project has no letters. */
export function displayOf(store, identifier, cache = new Map()) {
  const found = SHAPE.exec(String(identifier ?? ''))
  if (!found) return null
  if (cache.has(identifier)) return cache.get(identifier)
  const row = store.row('SELECT project_id FROM jobs WHERE identifier = ?', identifier)
  const letters = row ? codeOfProject(store, row.project_id) : null
  const out = letters ? `${letters}-${found[2]}` : identifier
  cache.set(identifier, out)
  return out
}

/** Any form of a job's code → the engine's own (`bal-326` → `NGE-326`); anything else comes back as it was. */
export function engineCode(store, ref) {
  if (typeof ref !== 'string') return ref
  const found = SHAPE.exec(ref.trim())
  if (!found) return ref
  const letters = found[1].toUpperCase()
  const prefix = companyPrefix(store)
  if (!prefix) return ref
  if (letters === prefix.toUpperCase()) return `${prefix}-${found[2]}`
  const known = letters === NO_PROJECT_CODE || store.objects('SELECT raw FROM projects').some((p) => p.code === letters)
  return known ? `${prefix}-${found[2]}` : ref
}

/** Put `displayIdentifier` beside every `identifier` in an answer, however deep. */
export function withDisplay(store, value) {
  const prefix = companyPrefix(store).toUpperCase()
  if (!prefix) return value
  const cache = new Map()
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) walk(node[key])
    const id = node.identifier
    if (typeof id === 'string' && id.toUpperCase().startsWith(`${prefix}-`) && SHAPE.test(id)) node.displayIdentifier = displayOf(store, id, cache)
  }
  walk(value)
  return value
}

/** Rewrite the job codes a request names (`issueId`, `parentId`, the blockers) to the engine's own. */
export function engineBody(store, body) {
  if (!body || typeof body !== 'object') return body
  const out = Array.isArray(body) ? [...body] : { ...body }
  for (const key of Object.keys(out)) {
    const v = out[key]
    if (['issueId', 'parentId'].includes(key)) out[key] = engineCode(store, v)
    else if (key === 'blockedByIssueIds' && Array.isArray(v)) out[key] = v.map((x) => engineCode(store, x))
    else if (key === 'payload' && v && typeof v === 'object') out[key] = engineBody(store, v)
  }
  return out
}
