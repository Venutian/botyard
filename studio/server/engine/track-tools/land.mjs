#!/usr/bin/env node
/**
 * A track's landing step, no AI: put the step's commit into the project's main branch, or say why not.
 * Usage in a script step: node "$BOTYARD_TRACK_TOOLS/land.mjs"
 *
 * It reads the commit (BOTYARD_IN_COMMIT), the project's folder (BOTYARD_IN_REPO, else
 * BOTYARD_PROJECT_FOLDER), the main branch (BOTYARD_MAIN) and, when the request names one, the test
 * command (BOTYARD_IN_TEST_COMMAND). In order:
 *   - a commit already in main is left as it is (a pass);
 *   - the folder must be on its main branch, with no changed tracked file the merge would touch;
 *   - the merge must be clean (git merge-tree), else the conflicts go back as findings;
 *   - the merged tree is checked out apart, and there the repo's own release check (tools/release-check.mjs,
 *     when the repo has one) and the test command must pass;
 *   - then `git merge --no-ff` into main. Nothing is pushed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const env = process.env
const commit = String(env.BOTYARD_IN_COMMIT || '').trim()
const repo = env.BOTYARD_IN_REPO || env.BOTYARD_PROJECT_FOLDER || ''
const main = env.BOTYARD_MAIN || 'main'
const title = String(env.BOTYARD_REQUEST_TITLE || 'a request').replace(/\s+/g, ' ').slice(0, 120)
const testCommand = String(env.BOTYARD_IN_TEST_COMMAND || '').trim()

function done(out) {
  if (env.BOTYARD_STEP_OUT) fs.writeFileSync(env.BOTYARD_STEP_OUT, JSON.stringify(out))
  console.log(out.verdict === 'pass' ? out.summary : out.findings)
  process.exit(0)
}
const refuse = (findings) => done({ verdict: 'fail', findings })
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const ok = (...args) => spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status === 0

if (!/^[0-9a-f]{7,40}$/i.test(commit)) refuse(`No commit to land: "${commit.slice(0, 60)}" is not one.`)
if (!repo || !fs.existsSync(repo)) refuse('The project has no folder to land in.')
if (!ok('cat-file', '-e', `${commit}^{commit}`)) refuse(`Commit ${commit.slice(0, 12)} is not in the project's repository.`)
if (ok('merge-base', '--is-ancestor', commit, main)) done({ verdict: 'pass', leaves: { commit: git('rev-parse', commit) }, summary: `${commit.slice(0, 12)} is already in ${main}.` })

let branch = ''
try { branch = git('symbolic-ref', '--short', 'HEAD') } catch { branch = '' }
if (branch !== main) refuse(`The project's folder is on ${branch || 'no branch'}, not ${main}: nothing was merged.`)
const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
const touched = new Set(git('diff', '--name-only', `${main}...${commit}`).split('\n').filter(Boolean))
const clash = changed.filter((f) => touched.has(f))
if (clash.length) refuse(`The project's folder has changes to files this merge touches: ${clash.slice(0, 10).join(', ')}. Nothing was merged.`)

// The merge, made apart first: conflicts are findings for the builder, and the checks run on what main will be.
const tree = spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', '--name-only', main, commit], { encoding: 'utf8' })
if (tree.status !== 0) refuse(`The commit does not merge cleanly into ${main}. Bring it up to date with ${main} and settle these:\n${tree.stdout.split('\n').slice(1).filter(Boolean).slice(0, 30).join('\n')}`)
const treeId = tree.stdout.split('\n')[0].trim()
const trial = git('commit-tree', treeId, '-p', main, '-p', commit, '-m', 'trial merge')
const place = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-land-'))
let failed = ''
try {
  git('worktree', 'add', '--detach', place, trial)
  const run = (command, args, what) => {
    const r = spawnSync(command, args, { cwd: place, encoding: 'utf8', timeout: 30 * 60_000 })
    if (r.status !== 0) failed = `${what} failed on the merged tree:\n${`${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-3000)}`
  }
  if (fs.existsSync(path.join(place, 'tools', 'release-check.mjs'))) run(process.execPath, ['tools/release-check.mjs'], 'The release check')
  if (!failed && testCommand) run('/bin/sh', ['-c', testCommand], `The tests (${testCommand})`)
} finally {
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', place], { stdio: 'ignore' })
  fs.rmSync(place, { recursive: true, force: true })
}
if (failed) refuse(failed)

const merged = spawnSync('git', ['-C', repo, 'merge', '--no-ff', '--no-edit', '-m', `Merge: ${title}`, commit], { encoding: 'utf8' })
if (merged.status !== 0) {
  spawnSync('git', ['-C', repo, 'merge', '--abort'], { stdio: 'ignore' })
  refuse(`git merge failed: ${`${merged.stdout}\n${merged.stderr}`.trim().slice(-1500)}`)
}
done({ verdict: 'pass', leaves: { commit: git('rev-parse', commit) }, numbers: { merged: 1 }, summary: `Merged ${commit.slice(0, 12)} into ${main} as ${git('rev-parse', '--short', 'HEAD')}. Not pushed.` })
