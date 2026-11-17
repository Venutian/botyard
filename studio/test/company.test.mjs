/**
 * Settings' company part, against a fake engine: secrets leave by name only, used and revoked
 * invites are not listed, the switches read plainly, and the two writes go where they should.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { companySettings, inviteMember, revokeInvite } from '../server/lib/company.mjs'

const CO = '11111111-2222-3333-4444-555555555555'
const INVITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function engine(calls = []) {
  const answers = {
    '/companies': [{ id: CO, status: 'active' }],
    [`/companies/${CO}`]: { id: CO, name: 'Acme Yard', description: 'Studio', issuePrefix: 'YRD', budgetMonthlyCents: 0 },
    [`/companies/${CO}/members`]: [
      { id: 'm1', principalType: 'user', status: 'active', membershipRole: 'owner', user: { name: 'Owner', email: 'o@example.com' }, grants: ['all'] },
      { id: 'm2', principalType: 'user', status: 'archived', membershipRole: 'odd', user: null },
    ],
    [`/companies/${CO}/invites`]: { invites: [
      { id: 'i1', humanRole: 'member', expiresAt: '2026-11-20T00:00:00Z' },
      { id: 'i2', humanRole: 'member', acceptedAt: '2026-11-10T00:00:00Z' },
      { id: 'i3', humanRole: 'admin', revokedAt: '2026-11-10T00:00:00Z' },
    ] },
    [`/companies/${CO}/secrets`]: [
      { name: 'ZETA_KEY', description: 'Store', latestVersion: { value: 'sk-live-should-never-leave' }, providerMetadata: { token: 'x' }, referenceCount: 2, updatedAt: '2026-11-01' },
      { name: 'ALPHA', deletedAt: null, externalRef: 'vault://x' },
      { name: 'GONE', deletedAt: '2026-11-02' },
    ],
    '/instance/settings/general': { backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } },
    '/instance/settings/experimental': { enableAgentChat: true, enablePipelines: false, enableNewThing: true, notAFlag: 'x' },
  }
  const fetcher = async (url, init = {}) => {
    const path = url.replace(/^.*\/api/, '')
    calls.push([init.method || 'GET', path, init.body ? JSON.parse(init.body) : undefined])
    if ((init.method || 'GET') === 'POST' && path === `/companies/${CO}/invites`) return new Response(JSON.stringify({ id: 'new', inviteUrl: 'http://127.0.0.1:3100/invite/t', token: 't', expiresAt: 'soon' }), { status: 201 })
    if ((init.method || 'GET') === 'POST' && path === `/invites/${INVITE}/revoke`) return new Response('{}', { status: 200 })
    if (!(path in answers)) return new Response('{"error":"nope"}', { status: 404 })
    return new Response(JSON.stringify(answers[path]), { status: 200 })
  }
  return { fetcher, calls }
}

test('company settings keep secrets to their names and list only open invites', async () => {
  const view = await companySettings(engine())
  assert.equal(view.name, 'Acme Yard')
  assert.deepEqual(view.secrets.map((s) => s.name), ['ALPHA', 'ZETA_KEY'])
  const text = JSON.stringify(view)
  for (const leak of ['sk-live', 'vault://', '"token"', 'grants']) assert.ok(!text.includes(leak), leak)
  assert.deepEqual(view.invites.map((i) => i.id), ['i1'])
  assert.equal(view.members[0].role, 'owner')
  assert.equal(view.members[1].role, 'member')
  assert.equal(view.members[1].active, false)
  assert.deepEqual(view.backups, { days: 7, weeks: 4, months: 1 })
  assert.deepEqual(view.flags.map((f) => [f.name, f.on]), [['Chat with bots', true], ['New Thing', true], ['Pipelines', false]])
})

test('an invite is for a person with a real role, and revoking takes a real invite id', async () => {
  const fake = engine()
  const made = await inviteMember({ role: 'admin' }, fake)
  assert.equal(made.link, 'http://127.0.0.1:3100/invite/t')
  assert.deepEqual(fake.calls.find(([m]) => m === 'POST')[2], { allowedJoinTypes: ['human'], humanRole: 'admin' })
  await assert.rejects(inviteMember({ role: 'owner' }, fake), /Pick member/)
  await assert.rejects(inviteMember({ role: 'god' }, fake), /Pick member/)
  await revokeInvite(INVITE, fake)
  assert.ok(fake.calls.some(([m, p]) => m === 'POST' && p === `/invites/${INVITE}/revoke`))
  await assert.rejects(revokeInvite('../companies', fake), /Unknown invite/)
})
