/**
 * Files on jobs: a proof screenshot, a document, anything a bot or the owner attaches. The bytes are
 * kept under the engine's own folder, named by their place; the store holds what each one is and
 * which job it hangs on.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Refused } from './write.mjs'
import { filesDir } from './names.mjs'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
const iso = (now) => new Date(now).toISOString()
const safeName = (name) => String(name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'file'

/** The one file out of an upload form: `{ name, type, bytes }`, or null when the form has none. */
export function fileOfForm(raw, contentType = '') {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2]
  if (!boundary || !Buffer.isBuffer(raw)) return null
  const mark = Buffer.from(`--${boundary}`)
  let from = raw.indexOf(mark)
  while (from !== -1) {
    const next = raw.indexOf(mark, from + mark.length)
    if (next === -1) break
    const part = raw.subarray(from + mark.length, next)
    const split = part.indexOf('\r\n\r\n')
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8')
      const name = /filename="([^"]*)"/i.exec(head)?.[1]
      if (name !== undefined) {
        // The part's bytes end before the line break that precedes the next mark.
        const bytes = part.subarray(split + 4, part.length - 2)
        return { name, type: /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase() || 'application/octet-stream', bytes }
      }
    }
    from = next
  }
  return null
}

/** Attach a file to a job. */
export function attach(store, companyId, jobId, file, { now = Date.now(), actor, dataDir } = {}) {
  const job = store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', jobId, jobId)
  if (!job || job.companyId !== companyId) throw new Refused(404, 'Issue not found')
  if (!file?.bytes?.length) throw new Refused(400, 'Send the file in a form field called file')
  if (file.bytes.length > MAX_FILE_BYTES) throw new Refused(413, 'Files are limited to 10 MB')
  const id = randomUUID()
  const day = iso(now).slice(0, 10).split('-')
  const objectKey = path.join(companyId, 'issues', job.id, ...day, `${randomUUID()}-${safeName(file.name)}`)
  const place = path.join(filesDir(dataDir), objectKey)
  fs.mkdirSync(path.dirname(place), { recursive: true })
  fs.writeFileSync(place, file.bytes)
  const made = {
    id, companyId, issueId: job.id, issueCommentId: null, originatingRunId: actor?.run || null, assetId: randomUUID(), provider: 'local_disk', objectKey,
    contentType: file.type, byteSize: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex'), originalFilename: String(file.name || 'file').slice(0, 200),
    createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', createdAt: iso(now), updatedAt: iso(now),
    contentPath: `/api/attachments/${id}/content`, openPath: `/api/attachments/${id}/content`, downloadPath: `/api/attachments/${id}/content?download=1`,
  }
  store.put('attachments', made, { position: store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM attachments WHERE job_id = ?', job.id).n })
  return made
}

/** Where an attachment's bytes are, and what they are. A file whose bytes are not in the files folder is said to be missing. */
export function fileOf(store, attachmentId, { dataDir } = {}) {
  const found = store.object('SELECT raw FROM attachments WHERE id = ?', attachmentId)
  if (!found) throw new Refused(404, 'Attachment not found')
  const place = path.join(filesDir(dataDir), found.objectKey || '')
  if (!found.objectKey || !fs.existsSync(place)) throw new Refused(404, 'This file\'s bytes are not in Botyard\'s files folder')
  return { path: place, type: found.contentType || 'application/octet-stream', name: found.originalFilename || 'file', size: found.byteSize }
}
