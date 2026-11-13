/**
 * What the page keeps between visits, as one document on disk: its settings, and whatever layout a
 * person arranged. The page owns what is in it; the server keeps it whole and stamps each save.
 *
 * Two windows can be open at once, so a save says which version it started from (`baseUpdatedAt`).
 * A save from an older version is not written: the answer is what is on disk now, and the page
 * that sent it decides what to keep. A save that changes nothing is not written either, so a page
 * that saves as it loads does not make every other window's copy old.
 */
import fs from 'node:fs'
import path from 'node:path'

export const SAVED_MAX_BYTES = 1024 * 1024
const isDocument = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** The same keys in the same order whatever order they were sent in, so two equal documents compare equal. */
const ordered = (value) => (Array.isArray(value) ? value.map(ordered) : isDocument(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value)
const without = (doc, ...keys) => Object.fromEntries(Object.entries(doc).filter(([key]) => !keys.includes(key)))

/**
 * The store for one file.
 * @returns {{ read: () => object, save: (sent: object) => Promise<{ status: number, body: object }> }}
 */
export function savedStore(file, { now = Date.now } = {}) {
  const read = () => {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      return isDocument(doc) ? { ...doc, updatedAt: Number(doc.updatedAt) || 0 } : { updatedAt: 0 }
    } catch { return { updatedAt: 0 } } // none yet, or one a person broke by hand: the page starts afresh
  }
  let turn = Promise.resolve()
  let writes = 0
  /** One save at a time: reading the version and writing the next must not be split by another save. */
  const save = (sent) => {
    const mine = turn.then(() => {
      if (!isDocument(sent)) return { status: 400, body: { error: 'A save is one object' } }
      const next = without(sent, 'baseUpdatedAt', 'updatedAt')
      if (Buffer.byteLength(JSON.stringify(next)) > SAVED_MAX_BYTES) return { status: 413, body: { error: 'That is more than the page may keep (1 MB)' } }
      const current = read()
      if (current.updatedAt && JSON.stringify(ordered(next)) === JSON.stringify(ordered(without(current, 'updatedAt')))) return { status: 200, body: current }
      const base = Number(sent.baseUpdatedAt) || 0
      // A first save (no version yet) and a save sent with no version at all are both written.
      if (base && current.updatedAt && base !== current.updatedAt) return { status: 409, body: current }
      const saved = { ...next, updatedAt: Math.max(now(), current.updatedAt + 1) }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const half = `${file}.${process.pid}.${++writes}.part`
      try {
        fs.writeFileSync(half, JSON.stringify(saved, null, 1))
        fs.renameSync(half, file)
      } finally { fs.rmSync(half, { force: true }) }
      return { status: 200, body: saved }
    })
    turn = mine.catch(() => {})
    return mine
  }
  return { read, save }
}
