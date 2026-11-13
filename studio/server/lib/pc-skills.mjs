/**
 * The skills on this PC, for the Library: the owner's ~/.claude/skills, the Claude plugins switched on and the
 * projects' own, as the crew's setup script lists them in $BOTYARD_HOME/crew/skills-index.json
 * (botyard crew/skill_sets.py), with which bots are given each one, or why none is.
 *
 * They are not in the engine's skill library on purpose: the engine writes a line per library skill into
 * every Claude bot's prompt. So they are read from the index, and are read only here: a skill on the PC
 * is changed in its own folder. Only files inside a skill's folder are read, as text.
 */
import fs from 'node:fs'
import path from 'node:path'
import { crewDir } from './home.mjs'

const INDEX = () => path.join(process.env.BOTYARD_CREW_FOLDER || crewDir(), 'skills-index.json')
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const memo = new Map()

/** Which index a caller reads: its own, none for a caller with its own fetcher (a test), else the PC's. */
const indexOf = (options = {}) => options.skillsIndex ?? (options.fetcher ? '' : INDEX())

/** Every skill in the index, read again only when the file changes. */
export function pcSkills(options = {}) {
  const file = indexOf(options)
  if (!file) return []
  let stat
  try { stat = fs.statSync(file) } catch { return [] }
  const seen = memo.get(file)
  if (seen && seen.mtime === stat.mtimeMs) return seen.rows
  let rows = []
  try {
    const got = JSON.parse(fs.readFileSync(file, 'utf8'))
    rows = (Array.isArray(got?.skills) ? got.skills : []).filter((s) => s && ID.test(s.id || '') && typeof s.name === 'string' && typeof s.dir === 'string' && path.isAbsolute(s.dir))
  } catch { rows = [] }
  memo.set(file, { mtime: stat.mtimeMs, rows })
  return rows
}

export const pcSkill = (id, options) => pcSkills(options).find((s) => s.id === id) || null

const firstNames = (bots) => bots.map((b) => String(b).split(' ')[0]).join(', ')

/** A Library row: who has it where a skill kept by the engine says whether it can change (a short column that does
 * not wrap), and why no bot has it at the end of what it is for. */
export function pcSkillRow(s, cut) {
  const bots = Array.isArray(s.bots) ? s.bots.filter((b) => typeof b === 'string') : []
  const why = bots.length ? '' : ` No bot has it: ${s.leftOut || 'not given'}`
  return {
    id: s.id,
    name: s.name,
    description: cut(s.description || '', 300 - why.length) + why,
    editable: false,
    locked: !bots.length ? 'No bot' : s.everyBot === true ? 'Every bot' : `Given to ${firstNames(bots)}`,
    bots: bots.length,
    files: (Array.isArray(s.files) ? s.files : []).filter((f) => typeof f === 'string').slice(0, 100),
  }
}

/** One file of a PC skill, as text; nothing outside the skill's own folder. */
export function pcSkillFile(s, file, limit) {
  let root, full
  try {
    root = fs.realpathSync(s.dir)
    full = fs.realpathSync(path.join(root, file))
  } catch { return { path: file, content: '', trimmed: false, markdown: /\.md$/i.test(file), editable: false } }
  if (full !== root && !full.startsWith(root + path.sep)) return { path: file, content: '', trimmed: false, markdown: false, editable: false }
  let content = ''
  try {
    if (fs.statSync(full).isFile()) content = fs.readFileSync(full, 'utf8')
  } catch { content = '' }
  return { path: file, content: content.slice(0, limit), trimmed: content.length > limit, markdown: /\.md$/i.test(file), editable: false }
}
