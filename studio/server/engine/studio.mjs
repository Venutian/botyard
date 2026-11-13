/**
 * The studio itself: the one company a store holds. A store with nothing in it becomes a studio the
 * first time the engine opens it, so a new Botyard needs no copy of anything: it starts empty, live,
 * with its owner, and the first project and the first bot are made through the API like any later one.
 */
import { randomUUID } from 'node:crypto'
import { Refused } from './write.mjs'

const iso = (now) => new Date(now).toISOString()
export const OWNER = 'local-board'
const DEFAULT_NAME = 'My studio'
const DEFAULT_PREFIX = 'STU'
const PREFIX = /^[A-Z][A-Z0-9]{1,5}$/

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A job code's letters from a studio's name: "Night Owl Games" → NOG, "Lighthouse" → LIG. */
export function prefixFrom(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  const letters = words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] || '').slice(0, 3)
  return PREFIX.test(letters) ? letters : DEFAULT_PREFIX
}

function newCompany({ name, description, issuePrefix }, now) {
  const title = clean(name, 120) || DEFAULT_NAME
  return {
    id: randomUUID(), name: title, description: clean(description, 4000) || null, status: 'active',
    issuePrefix: issuePrefix || prefixFrom(title), issueCounter: 0, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    defaultResponsibleUserId: OWNER, ownerUserId: OWNER, requireBoardApprovalForNewAgents: false, logoUrl: null,
    createdAt: iso(now), updatedAt: iso(now),
  }
}

/**
 * Make the studio if the store has none.
 * @returns the company made, or null when one was there already
 */
export function ensureStudio(store, { dataDir = '', now = Date.now(), name = '' } = {}) {
  if (store.row('SELECT id FROM company LIMIT 1')) return null
  const company = newCompany({ name, issuePrefix: name ? '' : DEFAULT_PREFIX }, now)
  store.tx(() => {
    store.put('company', company)
    store.setMeta('company_id', company.id)
    store.setMeta('made_here_at', iso(now))
  })
  return company
}

const prefixOr400 = (value) => {
  const prefix = String(value || '').trim().toUpperCase()
  if (!PREFIX.test(prefix)) throw new Refused(400, 'A job code starts with two to six letters or numbers, a letter first')
  return prefix
}

/** POST /companies: only for a store that has no studio yet. A Botyard holds one. */
export function createCompany(store, body = {}, { now = Date.now() } = {}) {
  if (store.row('SELECT id FROM company LIMIT 1')) throw new Refused(409, 'This Botyard already has its studio. Rename it instead')
  if (!clean(body.name, 120)) throw new Refused(400, 'A studio needs a name')
  const company = newCompany({ name: body.name, description: body.description, issuePrefix: body.issuePrefix ? prefixOr400(body.issuePrefix) : '' }, now)
  store.tx(() => {
    store.put('company', company)
    store.setMeta('company_id', company.id)
  })
  return company
}

/** PATCH /companies/:id: its name and what it is for; its job code's letters while no job has one. */
export function patchCompany(store, id, body = {}, { now = Date.now() } = {}) {
  const company = store.object('SELECT raw FROM company WHERE id = ?', id)
  if (!company) throw new Refused(404, 'Company not found')
  const next = { ...company, updatedAt: iso(now) }
  if (body.name !== undefined) { const name = clean(body.name, 120); if (!name) throw new Refused(400, 'A studio needs a name'); next.name = name }
  if (body.description !== undefined) next.description = clean(body.description, 4000) || null
  if (body.issuePrefix !== undefined && prefixOr400(body.issuePrefix) !== company.issuePrefix) {
    if (store.row('SELECT id FROM jobs LIMIT 1')) throw new Refused(409, 'Jobs already carry this code. It can only be changed while there are none')
    next.issuePrefix = prefixOr400(body.issuePrefix)
  }
  store.put('company', next)
  return next
}

/** Whether anything was set up yet: a first project or a first bot. */
export const isSetUp = (store) => Boolean(store.row('SELECT id FROM projects LIMIT 1') || store.row("SELECT id FROM agents WHERE status != 'terminated' LIMIT 1"))
