/**
 * The company and the instance, for Settings: its name, who is in it, open invites, the secrets it
 * holds (by name only, never a value), the experimental switches and how long backups are kept.
 *
 * The engine is reached only through `engine.mjs`'s `call`. Secrets come back from the engine
 * with provider settings and references; only the name, what it is for and when it last changed
 * leave this file. An invite's link is shown once, to whoever made it, and never kept here.
 */
import { call, companyId, orElse } from './engine.mjs'

const READ_TTL_MS = 10_000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLES = new Set(['owner', 'admin', 'member', 'viewer', 'operator'])

/** The experimental switches in plain words; any the map does not know keeps its own name. */
const FLAG_NAMES = {
  enableNativeRunner: 'Built-in runner',
  enableIsolatedWorkspaces: 'Isolated workspaces',
  enableIsolatedWorkspacesByDefault: 'Isolated workspaces for every job',
  enableAgentChat: 'Chat with bots',
  enableApps: 'Apps',
  enableMcpAggregators: 'Tool bundles',
  enablePipelines: 'Pipelines',
  enableCases: 'Cases',
  enableEnvironments: 'Environments',
  enableStatusCards: 'Status cards',
  enableSummaries: 'Summaries',
  enableBetaSkills: 'Beta skills',
}

const plainFlag = (key) => FLAG_NAMES[key] || key.replace(/^enable/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
const listOf = (value, key) => (Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [])

/** One company member, without ids or grants: a name, how they sign in, and their role. */
const memberView = (m) => ({
  id: String(m.id || ''),
  name: m.user?.name || m.user?.email || (m.principalType === 'agent' ? 'A bot' : 'Someone'),
  email: m.user?.email || '',
  role: ROLES.has(m.membershipRole) ? m.membershipRole : 'member',
  active: m.status === 'active',
  since: m.createdAt || null,
})

const inviteView = (i) => ({
  id: String(i.id || ''),
  role: i.humanRole || (Array.isArray(i.allowedJoinTypes) ? i.allowedJoinTypes.join(', ') : ''),
  expires: i.expiresAt || null,
  used: Boolean(i.acceptedAt || i.consumedAt),
  revoked: Boolean(i.revokedAt),
})

/** A secret by name only. Nothing that could be or lead to its value is kept. */
const secretView = (s) => ({
  name: String(s.name || s.key || ''),
  about: typeof s.description === 'string' ? s.description.slice(0, 160) : '',
  changed: s.lastRotatedAt || s.updatedAt || null,
  used: Number(s.referenceCount) || 0,
})

let cache = null
/** Everything Settings shows about the company and the instance, read together and kept briefly. */
export async function companySettings(options = {}) {
  const real = !options.fetcher
  if (real && cache && Date.now() - cache.at < READ_TTL_MS) return cache.view
  const id = await companyId(options)
  const [company, members, invites, secrets, general, experimental] = await Promise.all([
    call(`/companies/${id}`, options),
    orElse(call(`/companies/${id}/members`, options), []),
    orElse(call(`/companies/${id}/invites`, options), []),
    orElse(call(`/companies/${id}/secrets`, options), []),
    orElse(call('/instance/settings/general', options), {}),
    orElse(call('/instance/settings/experimental', options), {}),
  ])
  const keep = general?.backupRetention || {}
  const view = {
    name: company?.name || '',
    about: company?.description || '',
    code: company?.issuePrefix || '',
    members: listOf(members, 'members').map(memberView),
    invites: listOf(invites, 'invites').map(inviteView).filter((i) => !i.used && !i.revoked),
    secrets: listOf(secrets, 'secrets').filter((s) => !s.deletedAt).map(secretView).filter((s) => s.name).sort((a, b) => a.name.localeCompare(b.name)),
    flags: Object.entries(experimental || {}).filter(([, on]) => typeof on === 'boolean').map(([key, on]) => ({ key, name: plainFlag(key), on }))
      .sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name)),
    backups: { days: Number(keep.dailyDays) || 0, weeks: Number(keep.weeklyWeeks) || 0, months: Number(keep.monthlyMonths) || 0 },
  }
  if (real) cache = { at: Date.now(), view }
  return view
}

/** A new invite for a person; the answer carries its link once, for the owner to pass on. */
export async function inviteMember({ role = 'member' } = {}, options = {}) {
  if (!ROLES.has(role) || role === 'owner') throw Object.assign(new Error('Pick member, admin or viewer'), { status: 400 })
  const id = await companyId(options)
  const made = await call(`/companies/${id}/invites`, { ...options, method: 'POST', body: { allowedJoinTypes: ['human'], humanRole: role } })
  cache = null
  return { id: made.id, link: made.inviteUrl || made.invitePath || '', expires: made.expiresAt || null }
}

/** Take back an invite nobody has used yet. */
export async function revokeInvite(inviteId, options = {}) {
  if (!ID.test(inviteId || '')) throw Object.assign(new Error('Unknown invite'), { status: 400 })
  await call(`/invites/${inviteId}/revoke`, { ...options, method: 'POST', body: {} })
  cache = null
  return { ok: true }
}
