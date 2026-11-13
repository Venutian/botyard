/**
 * Opening a terminal window with one command in it, for a sign-in. Pinned: the command is only ever
 * a program and its words, each system is asked the way it takes one, and "no" is said in words.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { openTerminal } from '../server/lib/open-terminal.mjs'

/** A stand-in for starting programs: remembers each start, and fails the ones named in `broken`. */
function starter(broken = []) {
  const started = []
  const spawn = (program, args, options) => {
    const child = new EventEmitter()
    child.unref = () => {}
    started.push({ program, args, options })
    queueMicrotask(() => (broken.includes(path.basename(program)) ? child.emit('error', new Error('it fell over')) : child.emit('spawn')))
    return child
  }
  return { started, spawn }
}
const has = (...names) => (name) => (names.includes(name) ? `/usr/bin/${name}` : null)
const SIGN_IN = ['/usr/local/bin/claude', 'auth', 'login']

test('on Linux the first terminal found is given the command, in its folder, and the window waits for Enter', async () => {
  const { started, spawn } = starter()
  const out = await openTerminal(SIGN_IN, '/home/someone', { platform: 'linux', env: { DISPLAY: ':0' }, which: has('konsole', 'xterm'), spawn })
  assert.deepEqual(out, { ok: true })
  assert.equal(started.length, 1)
  assert.equal(started[0].program, '/usr/bin/konsole')
  const [flag, shell, dashC, script, zero, folder, ...words] = started[0].args
  assert.deepEqual([flag, shell, dashC, zero, folder], ['-e', '/bin/sh', '-c', 'botyard', '/home/someone'])
  assert.deepEqual(words, SIGN_IN, 'the command reaches the shell as its own words, never as text to be read again')
  assert.match(script, /^cd "\$1" \|\| exit 1; shift; "\$@"; /)
  assert.match(script, /Press Enter to close this window/)
})

test('each terminal is handed a command the way it takes one', async () => {
  const flagOf = async (name) => { const { started, spawn } = starter(); await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, which: has(name), spawn }); return started[0].args.slice(0, started[0].args.indexOf('/bin/sh')) }
  assert.deepEqual(await flagOf('gnome-terminal'), ['--'])
  assert.deepEqual(await flagOf('xfce4-terminal'), ['-x'])
  assert.deepEqual(await flagOf('kitty'), [])
  assert.deepEqual(await flagOf('wezterm'), ['start', '--'])
  assert.deepEqual(await flagOf('xterm'), ['-e'])
})

test('a terminal the person named goes first; one that will not start gives way to the next', async () => {
  const first = starter()
  await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { DISPLAY: ':0', TERMINAL: '/usr/bin/kitty' }, which: has('gnome-terminal', 'kitty'), spawn: first.spawn })
  assert.equal(first.started[0].program, '/usr/bin/kitty')
  const second = starter(['gnome-terminal'])
  const out = await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { DISPLAY: ':0' }, which: has('gnome-terminal', 'xterm'), spawn: second.spawn })
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(second.started.map((s) => path.basename(s.program)), ['gnome-terminal', 'xterm'])
  // A name that is not a known terminal is not guessed at.
  const third = starter()
  await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { DISPLAY: ':0', TERMINAL: 'my-odd-term' }, which: has('my-odd-term', 'xterm'), spawn: third.spawn })
  assert.equal(third.started[0].program, '/usr/bin/xterm')
})

test('with no screen, no terminal, or nothing that starts, it says which in words and starts nothing more', async () => {
  const none = starter()
  assert.deepEqual(await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: {}, which: has('xterm'), spawn: none.spawn }), { ok: false, error: 'This computer has no screen to open a window on' })
  assert.deepEqual(await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { DISPLAY: ':0' }, which: has(), spawn: none.spawn }), { ok: false, error: 'No terminal program was found on this computer' })
  assert.equal(none.started.length, 0)
  const broken = starter(['xterm'])
  assert.deepEqual(await openTerminal(SIGN_IN, '/w', { platform: 'linux', env: { DISPLAY: ':0' }, which: has('xterm'), spawn: broken.spawn }), { ok: false, error: 'xterm could not be started: it fell over' })
})

test('what is not a program and its words, or not a folder, is refused before anything starts', async () => {
  const { started, spawn } = starter()
  const ask = (command, cwd) => openTerminal(command, cwd, { platform: 'linux', env: { DISPLAY: ':0' }, which: has('xterm'), spawn })
  assert.equal((await ask('claude auth login', '/w')).ok, false)
  assert.equal((await ask(['claude', 'auth'], '/w')).ok, false, 'a program is named by its full path')
  assert.equal((await ask(['/bin/claude', ''], '/w')).ok, false)
  assert.equal((await ask([], '/w')).ok, false)
  assert.equal((await ask(SIGN_IN, 'relative/folder')).ok, false)
  assert.equal(started.length, 0)
})

test('on macOS Terminal is asked to open a small script that holds the command, quoted', async () => {
  const { started, spawn } = starter()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-terminal-'))
  const out = await openTerminal(['/opt/homebrew/bin/gh', 'auth', 'login', "it's"], '/Users/someone/My Yard', { platform: 'darwin', env: {}, spawn, tmp })
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(started[0].args.slice(0, 2), ['-a', 'Terminal'])
  assert.equal(started[0].program, '/usr/bin/open')
  const file = started[0].args[2]
  assert.ok(file.startsWith(tmp) && file.endsWith('Botyard.command'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o700)
  assert.equal(fs.readFileSync(file, 'utf8'), "#!/bin/sh\ncd '/Users/someone/My Yard' || exit 1\n'/opt/homebrew/bin/gh' 'auth' 'login' 'it'\\''s'\nprintf '\\n%s\\n' 'Finished. Press Enter to close this window.'\nread -r _\n")
})

test('on Windows a new Command Prompt window is started that stays open', async () => {
  const { started, spawn } = starter()
  const out = await openTerminal(['C:\\Program Files\\nodejs\\claude.cmd', 'auth', 'login'], 'C:\\Users\\someone', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, spawn })
  // On another system the Windows paths are not "absolute" to Node: the shape is what is pinned here.
  if (process.platform !== 'win32') { assert.equal(out.ok, false); return }
  assert.deepEqual(out, { ok: true })
  assert.equal(started[0].program, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(started[0].args.at(-1), '"start "Botyard" /D C:\\Users\\someone cmd.exe /k "C:\\Program Files\\nodejs\\claude.cmd" auth login"')
})
