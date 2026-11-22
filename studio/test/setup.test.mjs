/**
 * The setup checks: what a new yard needs, in which state, and how to fix it. Pinned here: an
 * empty computer is told what to install, free models alone make a yard ready, a key is saved
 * closed and never sent back, and Botyard only ever starts a tool's own sign-in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freeProviderKeys, probes, setupAct, setupState } from '../server/lib/setup.mjs'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-setup-'))

/** A made-up computer: which tools it has and what each answers. */
function computer({ tools = {}, env = {}, files = [], node = '24.1.0', built = true } = {}) {
  const root = temp()
  fs.mkdirSync(path.join(root, 'keys'))
  const studio = path.join(root, 'studio')
  const asked = []
  return {
    root, asked,
    probe: {
      env, home: root, crew: path.join(root, 'crew'), keys: path.join(root, 'keys'), studio, nodeVersion: node,
      which: (name) => (name in tools ? `/usr/bin/${name}` : null),
      exists: (file) => file === path.join(studio, 'dist', 'index.html') ? built : files.includes(file) || fs.existsSync(file),
      run: async (name, args) => {
        asked.push([name, ...args].join(' '))
        const answer = tools[name]?.[args.join(' ')]
        return answer ?? { code: 0, stdout: `${name} 1.2.3` }
      },
    },
  }
}
const by = (state, id) => state.items.find((item) => item.id === id)

test('an empty computer is told what Botyard needs and how to get each thing', async () => {
  const state = await setupState({ probe: computer({ built: false }).probe })
  assert.equal(state.ready, false)
  assert.equal(state.summary, 'Botyard still needs: Git, The built map.')
  assert.equal(by(state, 'node').state, 'ok')
  assert.deepEqual(by(state, 'git').fix, { kind: 'link', label: 'Get Git', url: 'https://git-scm.com/downloads' })
  assert.deepEqual(by(state, 'map').fix, { kind: 'command', label: 'Build the map', command: 'npm run build' })
  assert.deepEqual(by(state, 'opencode').fix, { kind: 'command', label: 'Install OpenCode (free models)', command: 'npm install -g opencode-ai' })
  assert.equal(by(state, 'claude').state, 'missing')
  assert.equal(by(state, 'antigravity').fix.kind, 'link')
  assert.equal(by(state, 'openrouter').fix.kind, 'key')
  for (const item of state.items) {
    assert.ok(item.what.length > 10, `${item.id} says what it is for`)
    assert.ok(['needed', 'ai', 'keys', 'other'].includes(item.group))
    assert.ok(['ok', 'missing', 'signed-out', 'unknown'].includes(item.state))
    assert.equal(item.state === 'ok', item.fix === null, `${item.id}: a fix exactly when something is to be done`)
  }
})

test('free models alone make a yard ready: no key, no account', async () => {
  const state = await setupState({ probe: computer({ tools: { git: {}, opencode: {} } }).probe })
  assert.equal(state.ready, true)
  assert.equal(state.summary, 'Ready. Bots can run on: OpenCode (free models).')
  assert.equal(by(state, 'opencode').detail, 'Found, version 1.2.3. Free models need no sign-in.')
})

test('needed things there but no AI tool: not ready, and told the shortest way', async () => {
  const state = await setupState({ probe: computer({ tools: { git: {} } }).probe })
  assert.equal(state.ready, false)
  assert.match(state.summary, /Install OpenCode to run bots on free models/)
})

test('an old Node is said to be too old', async () => {
  const state = await setupState({ probe: computer({ node: '20.11.0', tools: { git: {}, opencode: {} } }).probe })
  assert.equal(by(state, 'node').state, 'missing')
  assert.match(by(state, 'node').detail, /20\.11\.0 is too old: Botyard needs 22\.13 or newer/)
  assert.equal(state.ready, false)
})

test('each tool is asked for its own sign-in state', async () => {
  const signedOut = computer({ tools: {
    git: {}, opencode: {},
    claude: { 'auth status': { code: 1, stdout: '{"loggedIn":false}' } },
    codex: { 'login status': { code: 1, stdout: 'Not logged in' } },
    gemini: {}, agy: {},
    gh: { 'auth status': { code: 1, stdout: 'You are not logged into any GitHub hosts' } },
  } })
  const state = await setupState({ probe: signedOut.probe })
  assert.equal(by(state, 'claude').state, 'signed-out')
  assert.deepEqual(by(state, 'claude').fix, { kind: 'command', label: 'Sign in to Claude', command: 'claude auth login' })
  assert.equal(by(state, 'codex').state, 'signed-out')
  assert.equal(by(state, 'codex').fix.command, 'codex login')
  assert.equal(by(state, 'gemini').state, 'signed-out')
  assert.equal(by(state, 'antigravity').state, 'unknown')
  assert.match(by(state, 'antigravity').detail, /cannot tell whether it is signed in/)
  assert.equal(by(state, 'github').state, 'signed-out')
  assert.equal(by(state, 'github').fix.command, 'gh auth login')
  assert.ok(signedOut.asked.includes('claude auth status') && signedOut.asked.includes('codex login status') && signedOut.asked.includes('gh auth status'))

  const root = signedOut.root
  const signedIn = computer({ files: [path.join(root, 'none')], tools: {
    git: {}, opencode: {},
    claude: { 'auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' } },
    codex: { 'login status': { code: 0, stdout: 'Logged in' } },
    gh: { 'auth status': { code: 0, stdout: 'Logged in' } },
  } })
  const good = await setupState({ probe: signedIn.probe })
  assert.equal(by(good, 'claude').state, 'ok')
  assert.equal(by(good, 'codex').state, 'ok')
  assert.equal(by(good, 'github').state, 'ok')
  assert.equal(good.summary, 'Ready. Bots can run on: OpenCode (free models), Claude, Codex.')
})

test('a token kept for the crew counts as Claude signed in, and a tool that does not answer is "unknown"', async () => {
  const pc = computer({ tools: { git: {}, claude: { 'auth status': { code: 1, stdout: '{"loggedIn":false}' } }, codex: { 'login status': { code: null, stdout: '' } } } })
  pc.probe.exists = (file) => file === path.join(pc.probe.crew, 'claude-token') || file.endsWith('index.html')
  const state = await setupState({ probe: pc.probe })
  assert.equal(by(state, 'claude').state, 'ok')
  assert.equal(by(state, 'codex').state, 'unknown')
  assert.equal(state.ready, true)
})

test('a key is there when pasted, set for the service, or added in OpenCode: and its value is never in the answer', async () => {
  const secret = 'sk-or-v1-0123456789abcdef'
  const pc = computer({ env: { NVIDIA_API_KEY: secret }, tools: { git: {}, opencode: { 'auth list': { code: 0, stdout: '●  OpenRouter api\n' } } } })
  const state = await setupState({ probe: pc.probe })
  assert.equal(by(state, 'openrouter').detail, 'Added in OpenCode.')
  assert.equal(by(state, 'nvidia').detail, 'Set where the service was started.')
  assert.equal(JSON.stringify(state).includes(secret), false)
})

test('a pasted key is saved closed to others, replaces the old one, and can be forgotten', { skip: process.platform === 'win32' }, async () => {
  const pc = computer({ tools: { git: {}, opencode: {} } })
  const secret = 'nvapi-ABCDEFGH12345678'
  const [status, body] = await setupAct({ action: 'key', id: 'nvidia', key: `  ${secret}\n` }, { probe: pc.probe })
  assert.equal(status, 200)
  assert.equal(JSON.stringify(body).includes(secret), false)
  assert.equal(by(body.state, 'nvidia').state, 'ok')
  assert.equal(by(body.state, 'nvidia').detail, 'Saved in Botyard.')
  const file = path.join(pc.probe.keys, 'nvidia.key')
  assert.equal(fs.readFileSync(file, 'utf8'), `${secret}\n`)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(pc.probe.keys), ['nvidia.key'])

  await setupAct({ action: 'key', id: 'nvidia', key: 'nvapi-SECONDKEY0000' }, { probe: pc.probe })
  assert.equal(fs.readFileSync(file, 'utf8'), 'nvapi-SECONDKEY0000\n')
  const [, gone] = await setupAct({ action: 'forget', id: 'nvidia' }, { probe: pc.probe })
  assert.equal(fs.existsSync(file), false)
  assert.equal(by(gone.state, 'nvidia').state, 'missing')
})

test('what is not a key is refused, and so is a key for something Botyard does not keep', async () => {
  const pc = computer({ tools: { git: {} } })
  assert.equal((await setupAct({ action: 'key', id: 'openrouter', key: 'short' }, { probe: pc.probe }))[0], 400)
  assert.equal((await setupAct({ action: 'key', id: 'openrouter', key: 'two words in a key' }, { probe: pc.probe }))[0], 400)
  assert.equal((await setupAct({ action: 'key', id: 'openrouter' }, { probe: pc.probe }))[0], 400)
  assert.equal((await setupAct({ action: 'key', id: 'claude', key: 'sk-ant-0123456789' }, { probe: pc.probe }))[0], 404)
  assert.equal((await setupAct({ action: 'key', id: '../../etc/passwd', key: 'sk-ant-0123456789' }, { probe: pc.probe }))[0], 404)
  assert.deepEqual(fs.readdirSync(pc.probe.keys), [])
  assert.equal((await setupAct({ action: 'dance' }, { probe: pc.probe }))[0], 400)
})

test('"start" opens the tool\'s own sign-in in a terminal, and gives the command when none opens', async () => {
  const pc = computer({ tools: { git: {}, opencode: {}, claude: { 'auth status': { code: 1, stdout: '{"loggedIn":false}' } }, gemini: {} } })
  const opened = []
  const open = async (argv, cwd) => { opened.push({ argv, cwd }); return { ok: true } }
  const [status, body] = await setupAct({ action: 'start', id: 'claude' }, { probe: pc.probe, open })
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, opened: true, command: 'claude auth login', note: 'A terminal has opened on the computer. Finish there, then check again.' })
  assert.deepEqual(opened, [{ argv: ['/usr/bin/claude', 'auth', 'login'], cwd: pc.root }])

  const [, gemini] = await setupAct({ action: 'start', id: 'gemini' }, { probe: pc.probe, open })
  assert.match(gemini.note, /asks you to sign in the first time/)

  const [, headless] = await setupAct({ action: 'start', id: 'claude' }, { probe: pc.probe, open: async () => ({ ok: false, error: 'No graphical display' }) })
  assert.equal(headless.opened, false)
  assert.equal(headless.command, 'claude auth login')
  assert.match(headless.note, /Run the command there yourself/)

  // An install whose own installer is missing cannot be started: the command is still given.
  const [, install] = await setupAct({ action: 'start', id: 'codex' }, { probe: pc.probe, open })
  assert.equal(install.opened, false)
  assert.equal(install.command, 'npm install -g @openai/codex')
  assert.equal(opened.length, 2)
})

test('"start" is refused for what needs nothing, what is fixed another way, and what is not there', async () => {
  const pc = computer({ tools: { git: {}, opencode: {} } })
  const open = async () => assert.fail('nothing should open')
  assert.match((await setupAct({ action: 'start', id: 'git' }, { probe: pc.probe, open }))[1].error, /Git needs nothing done/)
  assert.match((await setupAct({ action: 'start', id: 'openrouter' }, { probe: pc.probe, open }))[1].error, /not fixed by a command/)
  assert.equal((await setupAct({ action: 'start', id: 'nobody' }, { probe: pc.probe, open }))[0], 404)
})

test('the key boxes come from the free providers file: a keyless provider has none, a bad entry is left out', () => {
  const dir = temp()
  const file = path.join(dir, 'free-providers.json')
  fs.writeFileSync(file, JSON.stringify({ providers: [
    { id: 'acme', name: 'Acme AI', env: 'ACME_API_KEY', signup: 'https://acme.example/keys', free: 'Free daily.' },
    { id: 'open', name: 'Open', env: '', signup: 'https://open.example' },
    { id: 'bad id', name: 'Bad', env: 'BAD_KEY', signup: 'https://bad.example' },
    { id: 'plain', name: 'Plain', env: 'PLAIN_KEY', signup: 'http://not-https.example' },
  ] }))
  const keys = freeProviderKeys(file)
  assert.deepEqual(keys.map((k) => [k.id, k.env, k.url]), [['acme', 'ACME_API_KEY', 'https://acme.example/keys']])
  assert.match(keys[0].what, /Acme AI's free models.*Free daily\./)
  assert.ok(keys[0].opencode.test('●  Acme AI api'), 'found in OpenCode\'s own sign-ins by its name')
  assert.deepEqual(freeProviderKeys(path.join(dir, 'none.json')).map((k) => k.id), ['openrouter', 'nvidia'], 'no file: the two it always had')
})

test('on this computer the real checks answer in the same shape', async () => {
  const root = temp()
  const state = await setupState({ probe: probes({ env: { ...process.env, BOTYARD_HOME: root } }) })
  assert.deepEqual(state.items.map((item) => item.id), ['node', 'git', 'map', 'opencode', 'claude', 'codex', 'gemini', 'antigravity', 'github', 'python', 'openrouter', 'nvidia', 'google', 'mistral', 'sambanova', 'cohere'], 'a key box for every keyed provider in crew/free-providers.json')
  assert.equal(by(state, 'node').state, 'ok')
  assert.equal(by(state, 'git').state, 'ok')
  assert.equal(typeof state.ready, 'boolean')
  assert.equal(fs.statSync(path.join(root, 'keys')).isDirectory(), true)
})

test('pictures of the demo get a made-up computer: the real page, nothing of the one that took them', async () => {
  const { sampleProbe } = await import('../server/lib/setup.mjs')
  const state = await setupState({ probe: sampleProbe() })
  assert.equal(state.ready, true)
  assert.deepEqual(Object.fromEntries(state.items.map((item) => [item.id, item.state])), {
    node: 'ok', git: 'ok', map: 'ok', opencode: 'ok', claude: 'signed-out', codex: 'missing', gemini: 'missing', antigravity: 'missing', github: 'ok', python: 'ok', openrouter: 'missing', nvidia: 'missing', google: 'missing', mistral: 'missing', sambanova: 'missing', cohere: 'missing',
  })
  process.env.BOTYARD_SETUP = 'sample'
  try {
    assert.deepEqual((await setupState()).items.map((item) => item.state), state.items.map((item) => item.state))
    const [status, body] = await setupAct({ action: 'key', id: 'openrouter', key: 'sk-or-v1-0123456789abcdef' })
    assert.equal(status, 409)
    assert.match(body.error, /sample yard/)
    assert.equal((await setupAct({ action: 'check' }))[0], 200)
  } finally { delete process.env.BOTYARD_SETUP }
})
