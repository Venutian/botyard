/**
 * The owner's notes vault, read for the Brain view: any folder of markdown notes (an Obsidian-style vault),
 * read-only. Botyard never writes to it; editing stays in the files.
 *
 * Which folder: `BOTYARD_BRAIN_DIR`, else `config/brain.json` `{ "folder": "..." }` (set from the page by the
 * person at this computer), else, in the demo yard, the made-up vault in `studio/demo/brain/`.
 *
 * What a note is: a `.md` file outside hidden folders and `templates/`. Its frontmatter (simple `key: value`
 * lines and `[a, b]` lists) gives `type`, `date`/`updated`, `status`, `area`, `tags`, `supersedes`,
 * `superseded_by`, `private` and `source`. Its `[[links]]` are lines on the map. A note in a folder other than
 * decisions/, preferences/ and inbox/ is in that folder's area, and those areas are private by default.
 */
import fs from 'node:fs'
import path from 'node:path'
import { configDir, studioRoot } from './home.mjs'

export const DEMO_BRAIN = () => path.join(studioRoot(), 'demo', 'brain')
const KINDS_FOLDERS = new Set(['decisions', 'preferences', 'inbox', 'notes', ''])
const SKIP_DIRS = new Set(['templates', 'node_modules'])
const MAX_NOTES = 2000
const MAX_BYTES = 256 * 1024
/** Folder names that hold personal notes wherever they appear (lib and crew/brain.py agree on this list). */
export const PERSONAL_AREAS = new Set(['life', 'career', 'money', 'investments', 'finance', 'health', 'family', 'personal', 'private'])

const settingsFile = (env = process.env) => path.join(configDir(env), 'brain.json')

/** The folder the view reads, or '' when none is set. */
export function brainFolder(env = process.env) {
  if (env.BOTYARD_BRAIN_DIR) return path.resolve(env.BOTYARD_BRAIN_DIR)
  try {
    const folder = JSON.parse(fs.readFileSync(settingsFile(env), 'utf8')).folder
    if (typeof folder === 'string' && folder.trim()) return path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME || ''))
  } catch { /* not set */ }
  return env.BOTYARD_DEMO === '1' ? DEMO_BRAIN() : ''
}

/** Set the folder (the person at this computer, from the page). It must be a folder with markdown in it. */
export function setBrainFolder(folder, env = process.env) {
  const chosen = path.resolve(String(folder || '').trim().replace(/^~(?=$|\/)/, process.env.HOME || ''))
  if (!folder || !fs.existsSync(chosen) || !fs.statSync(chosen).isDirectory()) throw Object.assign(new Error('That folder is not there'), { status: 400 })
  if (!listNotes(chosen).length) throw Object.assign(new Error('That folder has no markdown notes'), { status: 400 })
  const file = settingsFile(env)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ folder: chosen }, null, 1), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
  return { folder: chosen }
}

function listNotes(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= MAX_NOTES) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1) } else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

/** Frontmatter of a note: `{ data, body }`. Only the simple shapes a notes vault uses. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    if (/^\[.*\]$/.test(v) && !/^\[\[[^\]]*\]\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else v = v.replace(/^["']|["']$/g, '')
    data[kv[1].toLowerCase()] = v
  }
  return { data, body: text.slice(m[0].length) }
}

const linkTargets = (text) => [...String(text).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim())
const bare = (v) => (Array.isArray(v) ? v : [v]).map((s) => String(s || '').replace(/^\[+|\]+$/g, '').split('|')[0].trim()).filter(Boolean)
const DAY = /^(\d{4}-\d{2}-\d{2})/

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')

let cache = { key: '', value: null }

/**
 * The whole vault as the view draws it: notes (no bodies), links, areas, and the date span.
 * Read again only when a file's name, size or time changed.
 */
export function readBrain(folder = brainFolder()) {
  if (!folder) return { on: false, why: 'No notes folder is set.' }
  if (!fs.existsSync(folder)) return { on: false, why: `The notes folder is not there: ${folder}` }
  const files = listNotes(folder)
  const stats = files.map((f) => { try { const s = fs.statSync(f); return [f, s.size, s.mtimeMs] } catch { return [f, 0, 0] } })
  const key = folder + JSON.stringify(stats)
  if (cache.key === key) return cache.value
  const raw = []
  let pinned = new Set()
  for (const [file, size, mtime] of stats) {
    const rel = path.relative(folder, file).split(path.sep).join('/')
    const id = path.basename(file, '.md')
    if (size > MAX_BYTES) continue
    const text = fs.readFileSync(file, 'utf8')
    if (/^index$/i.test(id) && !rel.includes('/')) { pinned = new Set(linkTargets(text)); continue }
    if (/^readme$/i.test(id)) continue
    const { data, body } = frontmatter(text)
    const top = rel.includes('/') ? rel.split('/')[0] : ''
    const title = (/^#\s+(.+)$/m.exec(body)?.[1] || id.replace(DAY, '').replace(/^-/, '').replace(/-/g, ' ')).trim()
    const date = [data.date, data.updated, DAY.exec(id)?.[1]].map((d) => DAY.exec(String(d || ''))?.[1]).find(Boolean) || new Date(mtime).toISOString().slice(0, 10)
    const kindWord = String(data.type || top.replace(/s$/, '') || 'note').toLowerCase()
    const tags = (Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : []).map(words).filter(Boolean)
    const personalFolder = top && !KINDS_FOLDERS.has(top)
    const firstLine = body.replace(/^#.*$/m, '').split(/\r?\n/).map((l) => l.replace(/^[-*>\s]+|\*\*/g, '').trim()).find((l) => l && !l.startsWith('<!--') && !/^#/.test(l)) || ''
    raw.push({
      id, path: rel, title, date, folder: top,
      kind: ['decision', 'preference', 'fact', 'inbox'].includes(kindWord) ? kindWord : 'note',
      status: String(data.status || (top === 'inbox' ? 'unsorted' : 'accepted')).toLowerCase(),
      supersedes: bare(data.supersedes), supersededBy: bare(data.superseded_by),
      tags, areaWord: personalFolder ? words(top) : words(String(data.area || '').split(/[,(]/)[0]),
      private: String(data.private).toLowerCase() === 'true' || PERSONAL_AREAS.has(words(top)) || personalFolder,
      imported: String(data.source || '').toLowerCase() === 'imported',
      links: [...new Set(linkTargets(body))],
      excerpt: firstLine.slice(0, 220),
      words: body.split(/\s+/).filter(Boolean).length,
    })
  }
  // Areas: personal folders first, then the tags and area words most notes share (up to nine).
  const count = new Map()
  for (const n of raw) for (const t of new Set([n.areaWord, ...n.tags].filter(Boolean))) if (!n.folder || KINDS_FOLDERS.has(n.folder)) count.set(t, (count.get(t) || 0) + 1)
  const folders = [...new Set(raw.filter((n) => n.folder && !KINDS_FOLDERS.has(n.folder)).map((n) => words(n.folder)))]
  const common = [...count.entries()].filter(([t, c]) => c >= 2 && !folders.includes(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  // Greedy: the commonest tag takes its notes, the next takes what is left, so each band holds a real share.
  const areaOf = new Map()
  const chosen = []
  for (const n of raw) if (n.folder && !KINDS_FOLDERS.has(n.folder)) areaOf.set(n.id, words(n.folder))
  for (const [tag] of common) {
    if (chosen.length >= 9) break
    const takers = raw.filter((n) => !areaOf.has(n.id) && (n.areaWord === tag || n.tags.includes(tag)))
    if (takers.length < 2) continue
    chosen.push(tag)
    for (const n of takers) areaOf.set(n.id, tag)
  }
  for (const n of raw) if (!areaOf.has(n.id)) areaOf.set(n.id, n.folder === 'inbox' ? 'inbox' : 'other')
  const ids = new Map(raw.map((n) => [n.id.toLowerCase(), n.id]))
  const resolve = (t) => ids.get(String(t).toLowerCase()) || ids.get(path.basename(String(t)).toLowerCase())
  const notes = raw.map(({ areaWord, ...n }) => ({
    ...n,
    area: areaOf.get(n.id),
    pinned: pinned.has(n.id),
    links: n.links.map(resolve).filter((t) => t && t !== n.id),
    supersedes: n.supersedes.map(resolve).filter(Boolean),
    supersededBy: n.supersededBy.map(resolve).filter(Boolean),
  }))
  // A note named in another's superseded_by is the newer one; a note that names one in supersedes replaced it.
  const byId = new Map(notes.map((n) => [n.id, n]))
  for (const n of notes) for (const s of n.supersedes) { const old = byId.get(s); if (old && !old.supersededBy.includes(n.id)) old.supersededBy.push(n.id) }
  for (const n of notes) if (n.supersededBy.length && n.status === 'accepted') n.status = 'superseded'
  const areaIds = [...folders, ...chosen, ...['inbox', 'other'].filter((a) => notes.some((n) => n.area === a))]
  const areas = areaIds.map((id) => ({ id, name: id.replace(/-/g, ' '), count: notes.filter((n) => n.area === id).length, private: folders.includes(id) && notes.filter((n) => n.area === id).every((n) => n.private) }))
  const dates = notes.map((n) => n.date).sort()
  const value = { on: true, folder, name: path.basename(folder), notes: notes.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), areas, from: dates[0] || '', to: dates.at(-1) || '' }
  cache = { key, value }
  return value
}

/** One note's text for the side panel: its body without frontmatter, and what the map knows of it. */
export function brainNote(id, folder = brainFolder()) {
  const brain = readBrain(folder)
  if (!brain.on) throw Object.assign(new Error(brain.why), { status: 404 })
  const note = brain.notes.find((n) => n.id === id)
  if (!note) throw Object.assign(new Error('There is no note by that name'), { status: 404 })
  const file = path.join(folder, note.path)
  // Never outside the vault, whatever the name says.
  if (!path.resolve(file).startsWith(path.resolve(folder) + path.sep)) throw Object.assign(new Error('Not in the vault'), { status: 400 })
  const { data, body } = frontmatter(fs.readFileSync(file, 'utf8'))
  return { ...note, meta: data, text: body.trim() }
}

/**
 * The Brain view's answers, for the owner only: a call with a bot's pass, a script's key, or one made by a
 * process that runs for a bot is refused (BOTYARD_REFUSE_BOTS=off is for a test server only). The bots read
 * the vault through crew/brain.py, which keeps personal notes from free models; never through here.
 *
 *   GET  <base>            the map: notes without their text, areas, date span
 *   GET  <base>/note?id=   one note's text
 *   POST <base>/folder     { folder }: where the notes are (the person at this computer only)
 *
 * Answers true when it answered.
 */
export async function brainRoute(req, res, { pathname, query, base, send, readBody, local, botBehind }) {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return false
  const refuse = process.env.BOTYARD_REFUSE_BOTS !== 'off'
  if (req.headers['x-botyard-script'] || refuse && (botBehind?.(req) || /^Bearer\s/i.test(String(req.headers.authorization || '')) && base.startsWith('/api'))) {
    send(res, 403, { error: 'The notes are the owner\'s, not a bot\'s' })
    return true
  }
  try {
    if (pathname === base && req.method === 'GET') send(res, 200, readBrain())
    else if (pathname === `${base}/note` && req.method === 'GET') send(res, 200, brainNote(String(query.get('id') || '')))
    else if (pathname === `${base}/folder` && req.method === 'POST') {
      if (!local) send(res, 403, { error: 'The notes folder is set at the computer it is on' })
      else send(res, 200, setBrainFolder((await readBody(req)).folder))
    } else send(res, 405, { error: 'Not here' })
  } catch (err) {
    send(res, err.status || 500, { error: err.message })
  }
  return true
}
