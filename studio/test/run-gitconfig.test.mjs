// A run's git reads its own copy of the sandbox gitconfig, so a bot's `git config --global` never reaches the shared file.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runGitConfig } from '../server/engine/runner.mjs'

const STUDIO = '12345+example@users.noreply.github.com'

test("a bot's git config --global changes only its run's copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-gitconfig-'))
  try {
    const shared = path.join(dir, 'shared-gitconfig')
    fs.writeFileSync(shared, `[user]\n\tname = Botyard bot\n\temail = ${STUDIO}\n`)
    const scratch = fs.mkdtempSync(path.join(dir, 'botyard-run-x-'))
    const copy = runGitConfig(scratch, shared)
    assert.equal(path.dirname(copy), scratch)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: copy }
    execFileSync('git', ['config', '--global', 'user.email', 't@users.noreply.github.com'], { env })
    execFileSync('git', ['config', '--global', 'user.name', 't'], { env })
    assert.match(fs.readFileSync(copy, 'utf8'), /t@users\.noreply\.github\.com/)
    assert.equal(fs.readFileSync(shared, 'utf8'), `[user]\n\tname = Botyard bot\n\temail = ${STUDIO}\n`)
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('with no shared file the variable is left as given', () => {
  assert.equal(runGitConfig('/nowhere', '/no/such/gitconfig'), '/no/such/gitconfig')
  assert.equal(runGitConfig('/nowhere', ''), '')
})
