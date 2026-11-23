/** Starting a bot's tool on Windows (engine/start-tool.mjs): an npm-installed tool is a .cmd file that Node cannot start by name. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { findTool, launchable, notStarted, stopTree, windowsEnv } from '../server/engine/start-tool.mjs'

const WIN = { platform: 'win32' }
const winEnv = { Path: 'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }
const on = (...files) => ({ ...WIN, exists: (f) => files.includes(f) })

test('on Windows the .cmd npm made is found, never the bare script for Unix shells beside it', () => {
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm\\'
  assert.equal(findTool('opencode', winEnv, on(`${npm}opencode`, `${npm}opencode.cmd`)), `${npm}opencode.cmd`)
  assert.equal(findTool('opencode', winEnv, on()), null)
})

test('a .cmd tool is started through cmd.exe with every word quoted, so Node does not fail with ENOENT', () => {
  const file = 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd'
  const start = launchable('opencode', ['run', '--dir', 'C:\\My Work\\yard', '--model', 'opencode/big "pickle"'], winEnv, on(file))
  assert.equal(start.found, true)
  assert.equal(start.command, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(start.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(start.args[3], `""${file}" "run" "--dir" "C:\\My Work\\yard" "--model" "opencode/big ""pickle""""`)
  assert.equal(start.options.windowsVerbatimArguments, true)
})

test('an .exe is started as itself, and a tool not on the computer is said so', () => {
  const exe = 'C:\\Users\\me\\.opencode\\bin\\opencode.exe'
  const start = launchable('opencode', ['run'], winEnv, on(exe))
  assert.deepEqual([start.command, start.args, start.found], [exe, ['run'], true])
  assert.equal(launchable('opencode', [], winEnv, on()).found, false)
  assert.match(notStarted('opencode', { code: 'ENOENT' }), /^opencode is not installed on this computer.*Setup page/)
})

test('on macOS and Linux the command is left as it is', () => {
  assert.deepEqual(launchable('opencode', ['run'], { PATH: '/usr/bin' }, { platform: 'linux' }), { command: 'opencode', args: ['run'], options: {}, found: true })
})

test('a run on Windows keeps the variables Windows programs need; elsewhere none are added', () => {
  const env = windowsEnv({ ...winEnv, SystemRoot: 'C:\\Windows', SECRET: 'x' }, 'win32')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.USERPROFILE, 'C:\\Users\\me')
  assert.equal(env.SECRET, undefined)
  assert.deepEqual(windowsEnv(winEnv, 'linux'), {})
})

test('on Windows a run is stopped with taskkill over its whole tree', () => {
  const calls = []
  stopTree(42, 'SIGTERM', { platform: 'win32', run: (cmd, words) => calls.push([cmd, ...words]) })
  assert.deepEqual(calls, [['taskkill', '/pid', '42', '/T', '/F']])
})

test('"auto" on OpenCode itself is the best free model it lists, read once an hour', async () => {
  const { autoFreeModel, forgetFreeList } = await import('../server/engine/start-tool.mjs')
  forgetFreeList()
  let asked = 0
  const list = async () => { asked++; return 'opencode/big-pickle\nopencode/mimo-v2.6-flash-free\nopencode/gpt-paid\nopencode/deepseek-v4.1-flash-free\n' }
  assert.equal(await autoFreeModel('opencode', {}, { now: 1000, list }), 'opencode/deepseek-v4.1-flash-free')
  assert.equal(await autoFreeModel('opencode', {}, { now: 2000, list }), 'opencode/deepseek-v4.1-flash-free')
  assert.equal(asked, 1)
  forgetFreeList()
  assert.equal(await autoFreeModel('opencode', {}, { now: 3000, list: async () => '' }), null)
  forgetFreeList()
})
