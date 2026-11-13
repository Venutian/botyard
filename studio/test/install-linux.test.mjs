import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { installLinux, desktopQuote, shellQuote } from '../tools/install-linux.mjs'

test('Linux installer safely quotes paths, creates XDG entries and removes only its own files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-linux-install-'))
  const home = path.join(root, 'home'), configHome = path.join(root, 'config'), dataHome = path.join(root, 'share')
  const desktopDir = path.join(home, 'Desktop'), nodeBin = path.join(root, 'node bin')
  try {
    const result = await installLinux({ root, home, configHome, dataHome, desktopDir, nodeBin })
    assert.match(await fsp.readFile(result.launcher, 'utf8'), /exec bash/)
    assert.match(await fsp.readFile(result.launcher, 'utf8'), /export PATH='[^']*node bin':"\$PATH"/)
    assert.match(await fsp.readFile(result.app, 'utf8'), /Terminal=false/)
    assert.match(await fsp.readFile(result.shortcut, 'utf8'), /Name=Botyard\n/)
    assert.match(await fsp.readFile(result.startup, 'utf8'), /--headless/)
    await fsp.writeFile(path.join(root, 'keep.txt'), 'untouched')
    await installLinux({ root, home, configHome, dataHome, desktopDir, remove: true })
    assert.equal(await fsp.readFile(path.join(root, 'keep.txt'), 'utf8'), 'untouched')
    assert.equal(await fsp.stat(result.app).catch(() => null), null)
    assert.equal(await fsp.stat(result.shortcut).catch(() => null), null)
    assert.match(desktopQuote('/srv/a $b/100%/app'), /\\\\\$/)
    assert.match(desktopQuote('/srv/a $b/100%/app'), /100%%/)
    assert.throws(() => desktopQuote('/srv/a\nother'))
    assert.equal(shellQuote("a'b"), "'a'\\''b'")
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})
