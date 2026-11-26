/**
 * The desktop app carries only the files its build lists (desktop/package.json, extraResources). Every
 * file Botyard loads must be among them: on 23 Nov 2026 the 2.10.0 app stopped as it started on every
 * Windows computer, because the server imported tools/shots.mjs and the build left it out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = JSON.parse(fs.readFileSync(path.join(studio, '..', 'desktop', 'package.json'), 'utf8')).build
const filter = build.extraResources.find((entry) => entry.to === 'botyard/studio').filter

/** True when a path under studio/ is carried: a plain file named, or a folder/** taken whole. */
function carried(rel) {
  const name = rel.split(path.sep).join('/')
  if (filter.some((f) => f.startsWith('!') && f.endsWith('*.test.mjs')) && name.endsWith('.test.mjs')) return false
  return filter.some((f) => !f.startsWith('!') && (f === name || (f.endsWith('/**') && name.startsWith(f.slice(0, -2)))))
}

/** Every file of this repository a module loads, following relative imports, static and dynamic. */
function loaded(start) {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const next = path.resolve(path.dirname(file), m[1])
      if (next.startsWith(studio + path.sep) && /\.(m?js|json)$/.test(next) && fs.existsSync(next)) walk(next)
    }
  }
  walk(start)
  return [...seen]
}

test('every file the server loads is carried by the desktop app', () => {
  const files = loaded(path.join(studio, 'server', 'studio.mjs')).map((file) => path.relative(studio, file))
  assert.ok(files.length > 20, 'the walk found the server\'s modules')
  const missing = files.filter((rel) => !carried(rel))
  assert.deepEqual(missing, [], `add these to desktop/package.json build.extraResources: ${missing.join(', ')}`)
})
