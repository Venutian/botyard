#!/usr/bin/env node
/**
 * Give each project its job letters (BAL for Baltis, ...), matched by project name. Safe to run again:
 * a project that already has its letters is left alone, and one the table does not name is only listed.
 *   node tools/set-project-codes.mjs [--engine http://127.0.0.1:3210] [--company ID] [--dry]
 * "Baltis and Ballotta" (the project NGE-949 splits) is given BAL until the split; Baltis and Ballotta
 * get BAL and BLT once they exist, and the combined one is then let go of its letters.
 */
export const CODES = new Map([
  ['baltis', 'BAL'], ['ballotta', 'BLT'], ['aldis', 'ALD'], ['fasten', 'FAS'], ['untired', 'UNT'],
  ['ngen website', 'WEB'], ['night rules', 'NR'], ['ngen studio', 'STU'], ['botyard', 'STU'], ['sprint delta', 'SPD'], ['sandbox', 'BOX'],
  // Not in the owner's list; given letters too so no job falls back to the studio's own.
  ['income', 'INC'], ['graded prompts', 'GRP'], ['godot assets', 'GDA'], ['ngen tools', 'TLS'], ['ngen own', 'OWN'],
])
const COMBINED = 'baltis and ballotta'

/** The plan: [project, wanted letters or null]. Pure, so it is tested without an engine. */
export function plan(projects) {
  const names = new Set(projects.map((p) => p.name.trim().toLowerCase()))
  const split = names.has('baltis') && names.has('ballotta')
  return projects.map((p) => {
    const name = p.name.trim().toLowerCase()
    if (name === COMBINED) return [p, split ? null : 'BAL']
    return [p, CODES.get(name) || undefined]
  })
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const base = opt('--engine', process.env.BOTYARD_API_URL || 'http://127.0.0.1:3210').replace(/\/$/, '')
  const dry = args.includes('--dry')
  const call = async (method, p, body) => {
    const res = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${out.error || ''}`)
    return out
  }
  const company = opt('--company', process.env.BOTYARD_ID) || (await call('GET', '/companies'))[0].id
  const projects = await call('GET', `/companies/${company}/projects`)
  // Letting go of the combined project's letters first frees BAL for Baltis.
  const steps = plan(projects).sort((a, b) => (a[1] === null ? -1 : 0) - (b[1] === null ? -1 : 0))
  for (const [p, want] of steps) {
    if (want === undefined) { if (!p.code) console.log(`no letters for "${p.name}" (not in the table)`); continue }
    if ((p.code || null) === want) { console.log(`${p.name}: ${want} already`); continue }
    console.log(`${p.name}: ${p.code || '-'} -> ${want || '-'}`)
    if (!dry) await call('PATCH', `/projects/${p.id}`, { code: want })
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err.message); process.exit(1) })
