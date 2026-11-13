/**
 * The check before publishing. Pinned: what it must catch (a person's things, secrets, heavy or key
 * files) and what it must let through (examples, the repository's address).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, checkFile, checkLine, entropy, looksRandom, missingLinks } from '../../tools/release-check.mjs'

const kinds = (file, line) => checkLine(file, line).map((hit) => hit.kind)
// Made here from pieces, so this file holds nothing the check itself would stop.
const join = (...parts) => parts.join('')

test('a word of one person\'s set-up is caught, in any case, and the repository\'s address is not', () => {
  assert.deepEqual(kinds('a.md', join('Ask the ', 'nG', 'en', ' crew')), ['names'])
  assert.deepEqual(kinds('a.md', join('built for ', 'NIGHT', '_', 'RULES')), ['names'])
  assert.deepEqual(kinds('a.md', join('git clone https://github.com/', 'Venu', 'tian', '/botyard.git')), [])
  assert.deepEqual(kinds('a.md', join('git clone https://github.com/', 'Venu', 'tian', '/another.git')), ['names'])
  assert.deepEqual(kinds('tools/away.mjs', 'ask(router, \'GetSpecificPortMappingEntry\', {})'), [], 'a standard\'s own word is not a name')
  assert.deepEqual(kinds('a.md', 'A plain line about bots, yards and engines.'), [])
})

test('no licence line is let through: every file of the tree is ours', () => {
  const credit = join('Copyright (c) 2026 Someone', ' (', 'Agent', ' Atr', 'ium)')
  assert.deepEqual(kinds('LICENSE', credit), ['names'])
  assert.deepEqual(kinds('README.md', credit), ['names'])
  assert.deepEqual(kinds('LICENSE', join('Made at ', 'nG', 'en', ' Labs')), ['names'])
  assert.deepEqual(kinds('LICENSE', 'Copyright (c) 2026 Botyard contributors'), [])
})

test('a person\'s email, home folder and internet address are caught; examples are not', () => {
  assert.deepEqual(kinds('a.md', join('write to jane.doe', '@', 'gmail.com')), ['names'])
  assert.deepEqual(kinds('a.md', 'write to someone@example.com or bot@studio.invalid'), [])
  assert.deepEqual(kinds('a.sh', 'git clone git@github.com:someone/thing.git'), [])
  assert.deepEqual(kinds('a.mjs', join('const dir = "/home/', 'jane', '/projects"')), ['names'])
  assert.deepEqual(kinds('a.mjs', 'const dir = "/home/someone/projects"; const b = "/home/${user}/x"'), [])
  assert.deepEqual(kinds('a.mjs', join('fetch("http://', '81.2', '.69.142', ':5288")')), ['names'])
  assert.deepEqual(kinds('a.mjs', 'fetch("http://192.168.0.15:5288"); fetch("http://10.88.0.1"); fetch("http://203.0.113.9")'), [])
  assert.deepEqual(kinds('a.mjs', 'fetch("http://127.0.0.1:3210/api/health")'), [])
})

test('an id in a settings file is somebody\'s account; the same shape in a test is a made-up one', () => {
  const id = '01a1a181-2a22-78e0-824a-97c347c4ac91'
  assert.deepEqual(kinds('edge/wrangler.json', `{ "service_id": "${id}" }`), ['names'])
  assert.deepEqual(kinds('app.json', `"projectId": "${id}"`), ['names'])
  assert.deepEqual(kinds('test/engine.test.mjs', `const run = '${id}'`), [])
  assert.deepEqual(kinds('edge/wrangler.json', '{ "service_id": "PUT-THE-DOOR-SERVICE-ID-HERE" }'), [])
})

test('the shapes of real keys are caught', () => {
  const hex = 'a3f9c2e17b4d8f0612ce95ab37d0e4f8'
  assert.deepEqual(kinds('a.env', join('KEY=sk-or-', 'v1-', hex, hex)), ['secrets'])
  assert.deepEqual(kinds('a.env', join('KEY=sk-ant-', 'api03-Zx9Qw2Lm7Tn4Vb8Kc1Hd5Rf3')), ['secrets'])
  assert.deepEqual(kinds('a.env', join('TOKEN=gh', 'p_', 'Zx9Qw2Lm7Tn4Vb8Kc1Hd5Rf3Gj6Ys0Pa4Ue')), ['secrets'])
  assert.deepEqual(kinds('a.pem', join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----')), ['secrets'])
  assert.deepEqual(kinds('pc.conf', join('PrivateKey = ', 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBm', 'k=')), ['secrets']) // release-check: allow
  assert.deepEqual(kinds('a.json', join('"gate": "', hex, '9c41d7e2ab05f6381e7d2c94b6a0f513', '"')), ['secrets'], 'a long random hex string')
  assert.deepEqual(kinds('a.mjs', join('const t = "', 'Zx9Qw2Lm7Tn4Vb8Kc1Hd5Rf3Gj6Ys0Pa4UeWi8Ot2Nb5Mq7', '"')), ['secrets'], 'a long random mixed string') // release-check: allow
})

test('what is long but written by a person is let through', () => {
  assert.deepEqual(kinds('a.mjs', 'import { something } from "../../server/engine/very/long/path/to/a/module/that/goes/on.mjs"'), [])
  assert.deepEqual(kinds('a.mjs', 'const names = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'), [])
  assert.deepEqual(kinds('a.mjs', 'const example = "sk-or-v1-0123456789abcdef"; const other = "nvapi-ABCDEFGH12345678"'), [], 'too short to be a real key')
  assert.deepEqual(kinds('a.md', 'the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-going-on'), [])
  assert.deepEqual(kinds('package-lock.json', '"integrity": "sha512-Zx9Qw2Lm7Tn4Vb8Kc1Hd5Rf3Gj6Ys0Pa4UeWi8Ot2Nb5Mq7Zx9Qw2Lm7Tn4Vb8Kc1Hd5Rf3Gj6Ys0Pa4UeWi8Ot2Nb5Mq7=="'), []) // release-check: allow
  assert.ok(entropy('aaaaaaaa') < 0.1)
  assert.equal(looksRandom('short'), false)
})

test('a line that is a wanted exception says so itself', () => {
  assert.deepEqual(kinds('a.md', join('the ', 'nG', 'en', ' example  <!-- release-check: allow -->')), [])
})

test('keystores, credentials and heavy files are not for the tree', () => {
  for (const file of ['release.jks', 'android/app/debug.keystore', 'credentials.json', '.env', 'config/.env.local', 'keys/server.pem', 'ios/dist.p12', 'google-services.json', 'id_ed25519']) {
    assert.equal(checkFile(file, 100)[0]?.kind, 'files', file)
  }
  for (const file of ['README.md', 'src/keys.ts', 'crew/timetable.json', 'studio/server/lib/setup.mjs', 'docs/environment.md']) assert.deepEqual(checkFile(file, 100), [], file)
  assert.match(checkFile('public/big.glb', 6 * 1024 * 1024)[0].what, /over 5 MB/)
  assert.deepEqual(checkFile('public/small.glb', 4 * 1024 * 1024), [])
})

test('a whole folder is checked: every hit says its file and line, binary files are not read as text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'A clean page.\n')
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), join('const ok = 1\nconst where = "/home/', 'jane', '/x"\n'))
  fs.writeFileSync(path.join(dir, 'src', 'picture.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), Buffer.from(join('/home/', 'jane'))]))
  fs.writeFileSync(path.join(dir, 'release.keystore'), 'x')
  const out = check(dir)
  assert.equal(out.files, 4)
  assert.equal(out.pictures, 1)
  assert.deepEqual(out.hits.map((hit) => [hit.file, hit.line, hit.kind]).sort(), [['release.keystore', 0, 'files'], [path.join('src', 'a.mjs'), 2, 'names']])
  assert.deepEqual(check(dir, ['README.md']).hits, [])
})

test('a page that points to a picture or page that is not there is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-links-'))
  fs.mkdirSync(path.join(dir, 'docs', 'images'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'images', 'here.png'), 'x')
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), 'x')
  const lines = ['<img src="docs/images/here.png" alt="">', '<img src="docs/images/gone.png" alt="">', 'See [the guide](docs/guide.md#start), [nothing](docs/none.md) and [a site](https://example.com/x.png), [above](#top).']
  assert.deepEqual(missingLinks(dir, 'README.md', lines), [
    { line: 2, kind: 'files', what: 'points to docs/images/gone.png, which is not there' },
    { line: 3, kind: 'files', what: 'points to docs/none.md, which is not there' },
  ])
  assert.deepEqual(missingLinks(dir, 'docs/guide.md', ['![x](images/here.png) and [up](../docs/guide.md)']), [])
})
