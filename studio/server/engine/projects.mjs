/**
 * Projects and the folders they are worked in. A project is a name, what it is for (its goal lives
 * in that text, where the lead reads it) and one or more repositories on this computer; a job's own
 * worktree is cut from the first ("primary") one. A project is never deleted, because its jobs name
 * it: it is archived, and can be brought back.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Refused, note } from './write.mjs'

const iso = (now) => new Date(now).toISOString()
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const STATUSES = new Set(['backlog', 'planned', 'in_progress', 'paused', 'completed', 'cancelled'])
const COLOR = /^#[0-9a-f]{6}$/i

const projectOf = (store, id) => store.object('SELECT raw FROM projects WHERE id = ?', id)
const positionOf = (store, id) => store.row('SELECT position FROM projects WHERE id = ?', id)?.position ?? 0
const foldersOf = (store, projectId) => store.objects('SELECT raw FROM project_workspaces WHERE project_id = ? ORDER BY is_primary DESC, rowid', projectId)

/** A name as it is written in an address: "Tide Tables" → tide-tables, and -2 when that is taken. */
function urlKeyFor(store, name, exceptId) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  for (let n = 1; ; n++) {
    const key = n === 1 ? base : `${base}-${n}`
    const taken = store.row('SELECT id FROM projects WHERE url_key = ?', key)
    if (!taken || taken.id === exceptId) return key
  }
}

/** Write the project with its folders as they are now, so its own page and every list agree. */
function save(store, project, now) {
  const folders = foldersOf(store, project.id)
  // A project whose folders were never listed apart keeps the ones written on it.
  if (!folders.length && (project.primaryWorkspace || project.workspaces?.length)) {
    const kept = { ...project, updatedAt: iso(now) }
    store.put('projects', kept, { position: positionOf(store, project.id) })
    return kept
  }
  const primary = folders.find((f) => f.isPrimary) || folders[0] || null
  const next = {
    ...project, workspaces: folders, primaryWorkspace: primary,
    codebase: primary ? { workspaceId: primary.id, repoUrl: primary.repoUrl || null, repoRef: primary.repoRef || null, defaultRef: primary.defaultRef || null, repoName: primary.repoUrl ? path.basename(String(primary.repoUrl)).replace(/\.git$/, '') : null, localFolder: primary.cwd, managedFolder: primary.cwd, effectiveLocalFolder: primary.cwd, origin: 'local_folder' } : null,
    updatedAt: iso(now),
  }
  store.put('projects', next, { position: positionOf(store, project.id) })
  return next
}

/** A folder's fields from a request, checked. `cwd` must be a folder that is there. */
function folderFields(body, before = null) {
  const out = {}
  if (body.cwd !== undefined || !before) {
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
    if (!cwd || !path.isAbsolute(cwd)) throw new Refused(400, 'Give the folder\'s whole path on this computer')
    let stat = null
    try { stat = fs.statSync(cwd) } catch { /* not there */ }
    if (!stat?.isDirectory()) throw new Refused(400, 'That folder is not on this computer')
    out.cwd = path.resolve(cwd)
  }
  if (body.name !== undefined) out.name = text(body.name, 120).trim() || path.basename(out.cwd || before?.cwd || 'folder')
  else if (!before) out.name = path.basename(out.cwd)
  if (body.repoUrl !== undefined) out.repoUrl = text(body.repoUrl, 500).trim() || null
  if (body.repoRef !== undefined) out.repoRef = text(body.repoRef, 200).trim() || null
  return out
}

function addFolder(store, project, body, now) {
  const fields = folderFields(body)
  const folders = foldersOf(store, project.id)
  if (folders.some((f) => f.cwd === fields.cwd)) throw new Refused(409, 'This project already has that folder')
  const first = !folders.length || body.isPrimary === true
  if (first) for (const f of folders) if (f.isPrimary) store.put('project_workspaces', { ...f, isPrimary: false, updatedAt: iso(now) })
  const folder = {
    id: randomUUID(), companyId: project.companyId, projectId: project.id, sourceType: 'local_path', repoUrl: null, repoRef: null, defaultRef: null,
    visibility: 'default', metadata: null, ...fields, isPrimary: first, createdAt: iso(now), updatedAt: iso(now),
  }
  store.put('project_workspaces', folder)
  return folder
}

/** POST /companies/:id/projects. `workspace: { cwd }` attaches its repository in the same call. */
export function createProject(store, companyId, body = {}, { now = Date.now(), actor } = {}) {
  const company = store.object('SELECT raw FROM company WHERE id = ?', companyId)
  if (!company) throw new Refused(404, 'Company not found')
  const name = text(body.name, 200).trim()
  if (!name) throw new Refused(400, 'A project needs a name')
  if (store.objects('SELECT raw FROM projects WHERE name = ?', name).some((p) => !p.archivedAt)) throw new Refused(409, 'Another project already has that name')
  if (body.status !== undefined && !STATUSES.has(body.status)) throw new Refused(400, `A project is ${[...STATUSES].join(', ')}`)
  if (body.color !== undefined && body.color !== null && !COLOR.test(body.color)) throw new Refused(400, 'A colour is written like #3366ff')
  return store.tx(() => {
    const project = {
      id: randomUUID(), companyId, goalId: null, name, description: text(body.description, 200_000) || null, status: body.status || 'in_progress', leadAgentId: null,
      targetDate: null, color: body.color || null, icon: null, archivedAt: null, urlKey: urlKeyFor(store, name), goalIds: [], goals: [],
      workspaces: [], primaryWorkspace: null, codebase: null, createdAt: iso(now), updatedAt: iso(now),
    }
    store.put('projects', project, { position: store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects').n })
    if (body.workspace) addFolder(store, project, body.workspace, now)
    note(store, 'project.created', { type: 'project', id: project.id }, actor, {}, now)
    return save(store, project, now)
  })
}

/** PATCH /projects/:id: its name, its text, its state, its colour; `archived` puts it away or brings it back. */
export function patchProject(store, id, body = {}, { now = Date.now(), actor } = {}) {
  const project = projectOf(store, id)
  if (!project) throw new Refused(404, 'Project not found')
  const next = { ...project }
  if (body.name !== undefined) {
    const name = text(body.name, 200).trim()
    if (!name) throw new Refused(400, 'A project needs a name')
    if (name !== project.name) {
      if (store.objects('SELECT raw FROM projects WHERE name = ?', name).some((p) => p.id !== id && !p.archivedAt)) throw new Refused(409, 'Another project already has that name')
      next.name = name
      next.urlKey = urlKeyFor(store, name, id)
    }
  }
  if (body.description !== undefined) next.description = text(body.description, 200_000)
  if (body.status !== undefined) next.status = text(body.status, 40)
  if (body.color !== undefined) { if (body.color !== null && !COLOR.test(body.color)) throw new Refused(400, 'A colour is written like #3366ff'); next.color = body.color }
  const archive = body.archived !== undefined ? Boolean(body.archived) : body.archivedAt !== undefined ? Boolean(body.archivedAt) : null
  if (archive !== null) next.archivedAt = archive ? project.archivedAt || iso(now) : null
  return store.tx(() => {
    note(store, archive === true && !project.archivedAt ? 'project.archived' : 'project.updated', { type: 'project', id }, actor, {}, now)
    return save(store, next, now)
  })
}

/** DELETE /projects/:id puts the project away; nothing of it is deleted. */
export const archiveProject = (store, id, ctx) => patchProject(store, id, { archived: true }, ctx)

function folderOr404(store, projectId, folderId) {
  const folder = store.object('SELECT raw FROM project_workspaces WHERE id = ? AND project_id = ?', folderId, projectId)
  if (!folder) throw new Refused(404, 'That folder is not on this project')
  return folder
}

/** POST /projects/:id/workspaces: attach a repository folder. The first one is the primary. */
export function addWorkspace(store, projectId, body = {}, { now = Date.now(), actor } = {}) {
  const project = projectOf(store, projectId)
  if (!project) throw new Refused(404, 'Project not found')
  return store.tx(() => {
    const folder = addFolder(store, project, body, now)
    save(store, project, now)
    note(store, 'project.workspace_added', { type: 'project', id: projectId }, actor, { workspaceId: folder.id }, now)
    return folder
  })
}

/** PATCH /projects/:id/workspaces/:wid: where it is, what it is called, which one is the primary. */
export function patchWorkspace(store, projectId, folderId, body = {}, { now = Date.now(), actor } = {}) {
  const project = projectOf(store, projectId)
  if (!project) throw new Refused(404, 'Project not found')
  const before = folderOr404(store, projectId, folderId)
  const fields = folderFields(body, before)
  if (fields.cwd && foldersOf(store, projectId).some((f) => f.id !== folderId && f.cwd === fields.cwd)) throw new Refused(409, 'This project already has that folder')
  if (body.isPrimary === false && before.isPrimary) throw new Refused(400, 'Make another folder the primary one instead')
  return store.tx(() => {
    if (body.isPrimary === true && !before.isPrimary) for (const f of foldersOf(store, projectId)) if (f.isPrimary) store.put('project_workspaces', { ...f, isPrimary: false, updatedAt: iso(now) })
    const next = { ...before, ...fields, isPrimary: body.isPrimary === true ? true : before.isPrimary, updatedAt: iso(now) }
    store.put('project_workspaces', next)
    save(store, project, now)
    note(store, 'project.workspace_updated', { type: 'project', id: projectId }, actor, { workspaceId: folderId }, now)
    return next
  })
}

/** DELETE /projects/:id/workspaces/:wid: the project forgets the folder. The folder itself is not touched. */
export function removeWorkspace(store, projectId, folderId, { now = Date.now(), actor } = {}) {
  const project = projectOf(store, projectId)
  if (!project) throw new Refused(404, 'Project not found')
  const before = folderOr404(store, projectId, folderId)
  return store.tx(() => {
    store.drop('project_workspaces', folderId)
    // The next folder, if there is one, becomes the one jobs are cut from.
    const left = foldersOf(store, projectId)
    if (before.isPrimary && left.length) store.put('project_workspaces', { ...left[0], isPrimary: true, updatedAt: iso(now) })
    save(store, project, now)
    note(store, 'project.workspace_removed', { type: 'project', id: projectId }, actor, { workspaceId: folderId }, now)
    return { ok: true }
  })
}
