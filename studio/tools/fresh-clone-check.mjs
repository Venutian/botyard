#!/usr/bin/env node
/**
 * The proof that Botyard works for a stranger: clone, install, build, start, and take one job from
 * an empty yard to a commit, on a computer that (as far as this run can see) never had Botyard.
 *
 *   node tools/fresh-clone-check.mjs                 clone this repository's last commit and check it
 *   node tools/fresh-clone-check.mjs --with-changes  lay this folder's uncommitted work over the clone first
 *   node tools/fresh-clone-check.mjs --keep          leave the temp folder behind to look at
 *
 * Everything happens in a temp folder: the clone, an empty home (HOME and BOTYARD_HOME point into
 * it), spare ports, and a small project repository. No real model is called: the bot's "tool" is a
 * stand-in script that makes a commit and closes its job the way a bot does.
 *
 * Each line is `ok`, `wait` (a part another piece of work still has to bring: named, not a failure)
 * or `FAIL`. The run ends with status 1 only on a FAIL.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const studioHere = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoHere = path.dirname(studioHere)
const flags = new Set(process.argv.slice(2))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const tally = { ok: 0, wait: 0, fail: 0 }
const say = (mark, what, why = '') => console.log(`${mark.padEnd(4)} ${what}${why ? `: ${why}` : ''}`)
const ok = (what, detail = '') => { tally.ok++; say('ok', what, detail) }
const wait = (what, who) => { tally.wait++; say('wait', what, `waiting for ${who}`) }
const fail = (what, why) => { tally.fail++; say('FAIL', what, why) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' && command === npm, ...options })
const lastLines = (err) => String(err.stderr || err.stdout || err.message).trim().split('\n').slice(-6).join('\n     ')

async function ask(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* a page, not JSON */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json }
}

/**
 * The stand-in for a bot's tool. It is started the way Claude Code is, in the job's own folder,
 * makes one commit there, closes its job through the API with the run's own pass, and prints what
 * the real tool prints at the end of a good run.
 */
const STAND_IN = `#!/usr/bin/env node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const key = process.env.BOTYARD_API_KEY
if (!key) { console.error('the run was given no pass'); process.exit(2) }
const api = String(process.env.BOTYARD_API_URL || '').replace(/\\/+$/, '')
const job = process.env.BOTYARD_JOB_ID
fs.writeFileSync('made-by-the-bot.txt', 'A bot made this in a fresh studio.\\n')
execFileSync('git', ['add', 'made-by-the-bot.txt'])
execFileSync('git', ['-c', 'user.name=Stand-in bot', '-c', 'user.email=bot@studio.invalid', 'commit', '-q', '-m', 'fresh-clone-check: the first job'])
const res = await fetch(api + '/api/issues/' + job, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ status: 'done', comment: 'Done. One commit made.' }) })
if (!res.ok) { console.error('closing the job answered ' + res.status + ': ' + await res.text()); process.exit(3) }
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '0b0e7c7e-1111-4222-8333-444455556666', model: 'stand-in' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Made the commit and closed the job.', session_id: '0b0e7c7e-1111-4222-8333-444455556666', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }))
`

/** Start the clone's Botyard. Resolves with its handle once it says it is up, or with why it stopped. */
async function startStudio(studio, env) {
  const child = spawn(process.execPath, [path.join(studio, 'server', 'studio.mjs')], { cwd: studio, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let code = null
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const exited = new Promise((resolve) => child.once('exit', (c) => { code = c ?? -1; resolve(code) }))
  for (let n = 0; n < 600 && code === null && !out.includes('Botyard →'); n++) await sleep(100)
  return { out: () => out, up: code === null && out.includes('Botyard →'), stop: async () => { if (code === null) child.kill('SIGTERM'); await Promise.race([exited, sleep(10000)]); if (code === null) child.kill('SIGKILL') } }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-check-'))
  const clone = path.join(temp, 'botyard')
  const studio = path.join(clone, 'studio')
  const homeDir = path.join(temp, 'home')
  const studioHome = path.join(homeDir, '.botyard')
  fs.mkdirSync(homeDir)
  let service = null
  console.log(`Fresh-clone check in ${temp}\n`)
  try {
    // ── clone ──
    const head = run('git', ['-C', repoHere, 'rev-parse', '--short', 'HEAD']).trim()
    run('git', ['clone', '--quiet', '--no-local', '--depth', '1', `file://${repoHere}`, clone])
    ok('the repository clones', `commit ${head}`)
    if (flags.has('--with-changes')) {
      const changed = run('git', ['-C', repoHere, 'ls-files', '-z', '--modified', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
      let laid = 0
      for (const file of new Set(changed)) {
        const from = path.join(repoHere, file)
        if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue
        fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true })
        fs.copyFileSync(from, path.join(clone, file))
        laid++
      }
      for (const file of run('git', ['-C', repoHere, 'ls-files', '-z', '--deleted']).split('\0').filter(Boolean)) fs.rmSync(path.join(clone, file), { force: true })
      ok('this folder\'s uncommitted work is laid over the clone', `${laid} files`)
    }
    if (!fs.existsSync(path.join(studio, 'server', 'studio.mjs'))) return fail('the clone has Botyard\'s one entry', 'server/studio.mjs is not in the last commit (try --with-changes)')

    // ── install and build, as the README says ──
    try { run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: studio, timeout: 15 * 60_000 }); ok('npm ci') } catch (err) { return fail('npm ci', lastLines(err)) }
    try { run(npm, ['run', 'build'], { cwd: studio, timeout: 15 * 60_000 }); ok('npm run build') } catch (err) { return fail('npm run build', lastLines(err)) }
    if (!fs.existsSync(path.join(studio, 'dist', 'index.html'))) return fail('the build leaves a page', 'dist/index.html is missing')

    // ── start, in an empty home, on spare ports ──
    const port = await freePort()
    const enginePort = await freePort()
    const env = {
      PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir, BOTYARD_HOME: studioHome,
      PORT: String(port), BOTYARD_ENGINE_PORT: String(enginePort), BOTYARD_PHONE_PORT: String(await freePort()),
      // The crew's helper scripts are not part of this check, and must never be started beside a real yard's.
      BOTYARD_TIMETABLE: 'off', NODE_NO_WARNINGS: '1',
    }
    const at = `http://127.0.0.1:${port}`
    service = await startStudio(studio, env)
    if (!service.up) return fail('node server/studio.mjs starts', service.out().trim().split('\n').slice(-6).join('\n     ') || 'it said nothing')
    ok('node server/studio.mjs starts', `${at}, home ${studioHome}`)

    const page = await ask(at + '/')
    if (page.status === 200 && /text\/html/.test(page.type) && /<div id=|<canvas|<script/.test(page.text)) ok('the page loads')
    else fail('the page loads', `answered ${page.status} ${page.type}`)

    const setup = await ask(at + '/api/studio/setup')
    if (setup.status === 200 && Array.isArray(setup.json?.items)) {
      const by = Object.fromEntries(setup.json.items.map((item) => [item.id, item.state]))
      if (by.node === 'ok' && by.git === 'ok' && by.map === 'ok') ok('setup answers', setup.json.summary)
      else fail('setup answers', `node ${by.node}, git ${by.git}, the built map ${by.map}`)
    } else fail('setup answers', `answered ${setup.status}`)

    const table = await ask(at + '/api/studio/timetable')
    if (table.status === 200 && table.json?.state === 'off' && table.json.jobs?.length) ok('the timetable answers', `${table.json.jobs.length} helpers listed, off for this check`)
    else fail('the timetable answers', `answered ${table.status} ${table.text.slice(0, 120)}`)

    const outside = await ask(at + '/api/companies', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    if (outside.status === 404) ok('the engine is hidden from a caller that came through a tunnel')
    else fail('the engine is hidden from a caller that came through a tunnel', `answered ${outside.status}`)

    // ── an empty yard ──
    const studios = await ask(at + '/api/companies')
    if (studios.status !== 200) return fail('the engine answers under /api', `answered ${studios.status} ${studios.text.slice(0, 160)}`)
    if (!studios.json?.length) return wait('an empty yard is listed', 'the engine (an empty store that starts itself)')
    const mine = studios.json[0]
    const [bots, projects] = await Promise.all([ask(`${at}/api/companies/${mine.id}/agents`), ask(`${at}/api/companies/${mine.id}/projects`)])
    ok('an empty yard is listed', `"${mine.name}", ${bots.json?.length ?? '?'} bots, ${projects.json?.length ?? '?'} projects`)
    if (fs.existsSync(path.join(studioHome, 'studio.db'))) ok('the store is in the home folder', path.join(studioHome, 'studio.db'))
    else fail('the store is in the home folder', 'studio.db is not there')

    // ── a project, a bot, a job, a commit ──
    const repo = path.join(temp, 'first-project')
    fs.mkdirSync(repo)
    run('git', ['-C', repo, 'init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'A first project.\n')
    run('git', ['-C', repo, 'add', '.'])
    run('git', ['-C', repo, '-c', 'user.name=Check', '-c', 'user.email=check@studio.invalid', 'commit', '-q', '-m', 'first'])

    const project = await ask(`${at}/api/companies/${mine.id}/projects`, { method: 'POST', body: { name: 'First project', description: 'Made by the fresh-clone check.', workspace: { cwd: repo } } })
    if (project.status === 404 || project.status === 405) return wait('a project is made through the API', 'the engine (POST /api/companies/:id/projects)')
    if (project.status !== 201 || !project.json?.id) return fail('a project is made through the API', `answered ${project.status} ${project.text.slice(0, 200)}`)
    ok('a project is made through the API', `"${project.json.name}" in ${repo}`)

    if (process.platform === 'win32') return wait('a bot takes a job to a commit', 'a stand-in tool that Windows can start (this part runs on Linux and macOS)')
    const tool = path.join(temp, 'stand-in-tool.mjs')
    fs.writeFileSync(tool, STAND_IN, { mode: 0o755 })
    const bot = await ask(`${at}/api/companies/${mine.id}/agents`, { method: 'POST', body: { name: 'Stand-in Builder', role: 'engineer', title: 'Builds', capabilities: 'Stands in for a model in the fresh-clone check.', adapterType: 'claude_local', adapterConfig: { command: tool, model: 'stand-in', timeoutSec: 120, graceSec: 2 } } })
    if (bot.status !== 201 || !bot.json?.id) return fail('a bot is made through the API', `answered ${bot.status} ${bot.text.slice(0, 200)}`)
    ok('a bot is made through the API', `"${bot.json.name}"`)

    const job = await ask(`${at}/api/companies/${mine.id}/issues`, { method: 'POST', body: { title: 'Make the first commit', description: 'OUTCOME: one new file, committed.', projectId: project.json.id, assigneeAgentId: bot.json.id, status: 'todo' } })
    if (job.status !== 201 || !job.json?.id) return fail('a job is given to the bot', `answered ${job.status} ${job.text.slice(0, 200)}`)
    ok('a job is given to the bot', `${job.json.identifier} "${job.json.title}"`)

    let seen = null
    for (let n = 0; n < 240; n++) {
      seen = (await ask(`${at}/api/issues/${job.json.id}`)).json
      if (seen?.status === 'done') break
      await sleep(500)
    }
    const commits = run('git', ['-C', repo, 'log', '--all', '--format=%s']).split('\n')
    const committed = commits.includes('fresh-clone-check: the first job')
    if (seen?.status === 'done' && committed) ok('the bot takes the job to done, with a commit', `${job.json.identifier} is done; the commit is on the job's own branch`)
    else {
      const runs = (await ask(`${at}/api/issues/${job.json.id}/runs`)).json || []
      fail('the bot takes the job to done, with a commit', `job is ${seen?.status}, commit ${committed ? 'made' : 'not made'}, run ${runs[0]?.status || 'not started'}${runs[0]?.error ? ` (${runs[0].error})` : ''}\n     ${service.out().trim().split('\n').slice(-5).join('\n     ')}`)
    }
  } finally {
    await service?.stop()
    if (flags.has('--keep')) console.log(`\nKept: ${temp}`)
    else fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

await main().catch((err) => fail('the check itself', String(err?.stack || err).split('\n').slice(0, 4).join('\n     ')))
console.log(`\n${tally.ok} ok, ${tally.wait} waiting, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
