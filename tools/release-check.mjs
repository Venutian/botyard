#!/usr/bin/env node
/**
 * The check before Botyard is published: nothing personal, nothing secret, nothing heavy in the tree.
 *
 *   node tools/release-check.mjs                 every tracked file
 *   node tools/release-check.mjs crew studio     only these folders or files
 *
 * Three checks, and the run ends with status 1 if any of them finds something:
 *
 *   names    words that belong to one person's set-up (their name, their products, their bots), a
 *            person's email address, a home folder path of a real account, an internet address that
 *            is not an example, an id in a settings file
 *   secrets  private-key headers, the shapes of well-known tokens, WireGuard keys, and long strings
 *            that look random
 *   files    anything over 5 MB, keystores, certificates, key files and credential files, and a
 *            picture or page a Markdown file points to that is not there
 *
 *   node tools/release-check.mjs --commits A..B  also each commit in the range: its message, and its author
 *                                                and committer, who must be a GitHub no-reply address
 *   node tools/release-check.mjs --message FILE  only a commit being made: its message and who it is made as
 *                                                (tools/hooks/commit-msg)
 *   node tools/release-check.mjs --who NAME MAIL exit 0 when that name and address may author a commit
 *
 * tools/hooks/pre-push runs both before every push (`git config core.hooksPath tools/hooks` turns it on).
 *
 * A line that is a known and wanted exception ends with the words `release-check: allow`. Two kinds
 * of line are allowed without it: the repository's own address, and a licence's copyright lines.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BYTES = 5 * 1024 * 1024
const ALLOW = 'release-check: allow'

/**
 * The words that must not be in the tree. They are written backwards here so that this file, which
 * has to name them, does not fail its own check (or a plain search for them).
 */
const WORDS = ['muirta tnega', 'gnissorc tob', 'tobsuamnepo', 'tobsuam', 'skcor nerraj', 'ecneics noitats', 'negn', 'sunev', 'naitunev', 'leoy', 'uthcarbem', 'sitlab', 'attollab', 'sidla', 'selur thgin', 'oyay ynot', 'noedig', 'eht nerak', 'eht kcirb', 'redliub eht bob', 'ukawk', 'eht derf', 'ayerf', 'irafat', 'oguh', 'appilf', 'ltsuh', 'ksedsboj', 'eldnik', 'deritnu', 'sbalnegn', 'pilcrepap']
  .map((word) => [...word].reverse().join(''))
/** Whole words only: a first studio's lead bot and its job codes, short enough to be inside other words. */
const WHOLE = ['ynot', 'mlohkcots', 'nedews'].map((word) => [...word].reverse().join(''))
const NAMES = new RegExp([...WORDS.map((word) => word.replace(/ /g, '[ _-]?')), ...WHOLE.map((word) => `\\b${word}\\b`)].join('|'), 'i')

/** What is taken out of a line before the words are looked for: things that only look like one. */
const HARMLESS = [
  /github\.com\/Venutian\/botyard/gi, // the repository's own address, the one place its owner's GitHub name appears. release-check: allow
  /\b(Get|Add|Delete)\w*PortMapping(Entry)?\b/g, // UPnP's own action names, which happen to hold four of the letters
]

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g
const EMAIL_FINE = /@(example\.(com|org|net)|[\w.-]+\.(invalid|example|test|local)|users\.noreply\.github\.com)$|^git@|^(t@t|a@b|you@|name@|user@|someone@)/i
const HOME_PATH = /(?:(?<![\w.-])\/home\/|(?<![\w.-])\/Users\/|\b[A-Z]:\\Users\\)([A-Za-z][\w.-]*)/g
const HOME_FINE = new Set(['someone', 'user', 'you', 'me', 'name', 'owner', 'o', 'h', 'x', 'runner', 'public', 'shared', 'nonexistent-home', 'username', 'yourname', 'alice', 'bob'])
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g
/** Private, loopback, link-local, carrier and documentation ranges: none of them is anyone's address. */
function exampleAddress(a, b, c, d) {
  if ([a, b, c, d].some((n) => n > 255)) return true // not an address at all
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || (a === 1 && b === 1 && c === 1 && d === 1) || (a === 8 && b === 8) || (a === 255)
}
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
/** Settings files where an id is somebody's account, project or service, not a made-up one for a test. */
const SETTINGS_FILE = /(^|\/)(wrangler\.(json|jsonc|toml)|app\.json|eas\.json|app\.config\.(js|ts)|firebase\.json|\.firebaserc|vercel\.json|netlify\.toml)$/

const SECRETS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ['an OpenRouter key', /\bsk-or-v1-[a-f0-9]{32,}/],
  ['an OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['an AWS key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an NVIDIA key', /\bnvapi-[A-Za-z0-9_-]{32,}/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ['a signed web token', /\beyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/],
  ['an Expo token', /\bexpo_[A-Za-z0-9_-]{30,}/],
  ['a Cloudflare tunnel token', /\beyJhIjoi[A-Za-z0-9_-]{20,}/],
  ['a WireGuard key', /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])/],
]
/** Where long random-looking strings are what the file is for, not a secret. */
const NO_ENTROPY = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.lock|.*\.svg|.*\.min\.(js|css)|.*\.map)$/
const CANDIDATE = /[A-Za-z0-9+/_=-]{40,}/g

/** Bits a character: a key is close to the most its alphabet allows, a word or a path is far below. */
export function entropy(text) {
  const counts = new Map()
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1)
  let bits = 0
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length)
  return bits
}
/** Does this run of characters look made by chance rather than written? */
export function looksRandom(text) {
  if (text.length < 40) return false
  if (/^[0-9a-f]+$/i.test(text)) return text.length >= 48 && entropy(text.toLowerCase()) > 3.6 // hex: 4 bits at most
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((kind) => kind.test(text)).length
  return kinds === 3 && entropy(text) > 4.6
}

const KEY_FILE = /\.(jks|keystore|p12|pfx|pem|key|mobileprovision|p8|cer|crt|der)$|(^|\/)(credentials\.json|google-services\.json|GoogleService-Info\.plist|service-account[\w.-]*\.json|\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i

/** Everything wrong with one line of one file → `[{ kind, what }]`. */
export function checkLine(file, line) {
  if (line.includes(ALLOW)) return []
  const hits = []
  {
    const bare = HARMLESS.reduce((text, harmless) => text.replace(harmless, ' '), line)
    const word = NAMES.exec(bare)
    if (word) hits.push({ kind: 'names', what: `"${word[0]}" belongs to one person's set-up` })
    // A lockfile quotes other packages' own notices, with their authors' addresses: those are public and theirs.
    for (const mail of NO_ENTROPY.test(file) ? [] : line.match(EMAIL) || []) if (!EMAIL_FINE.test(mail) && !/\.(png|jpg|svg|js|mjs|json|css|md)$/i.test(mail) && !/^\d/.test(mail.split('@')[1])) hits.push({ kind: 'names', what: `an email address (${mail.replace(/^(.).*@/, '$1…@')})` })
  }
  for (const found of line.matchAll(HOME_PATH)) if (!HOME_FINE.has(found[1].toLowerCase()) && !/^[<${%]/.test(found[1])) hits.push({ kind: 'names', what: `a home folder of a real account (${found[0]})` })
  for (const found of line.matchAll(IPV4)) {
    const [a, b, c, d] = found.slice(1, 5).map(Number)
    // A version number such as 1.2.3.4 in a lockfile or a browser's name is not an address.
    if (!exampleAddress(a, b, c, d) && !/version|chrome|firefox|safari|webkit|"resolved"|integrity|\bv\d/i.test(line)) hits.push({ kind: 'names', what: `an internet address that is not an example (${found[0]})` })
  }
  if (SETTINGS_FILE.test(file) && UUID.test(line)) hits.push({ kind: 'names', what: 'an id of somebody\'s account or service in a settings file' })
  for (const [what, shape] of SECRETS) if (shape.test(line)) hits.push({ kind: 'secrets', what })
  if (!NO_ENTROPY.test(file) && !hits.some((hit) => hit.kind === 'secrets')) {
    for (const run of line.match(CANDIDATE) || []) {
      // A path, a web address or words-joined-by-dashes are long without being random.
      if (/[/]/.test(run) && run.split('/').every((part) => part.length < 40)) continue
      if (looksRandom(run.replace(/=+$/, ''))) { hits.push({ kind: 'secrets', what: `a long random-looking string (${run.slice(0, 6)}…, ${run.length} characters)` }); break }
    }
  }
  return hits
}

/** Everything wrong with one file by its name and size alone. */
export function checkFile(file, size) {
  const hits = []
  if (KEY_FILE.test(file)) hits.push({ kind: 'files', what: 'a keystore, certificate, key or credentials file' })
  if (size > MAX_BYTES) hits.push({ kind: 'files', what: `${(size / 1024 / 1024).toFixed(1)} MB: over 5 MB` })
  return hits
}

/** Pictures and pages of this tree that a Markdown file points to and that are not there. */
export function missingLinks(dir, file, lines) {
  const hits = []
  lines.forEach((text, index) => {
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((found) => found[1])
    for (const target of targets) {
      if (/^([a-z]+:|#|\/\/)/i.test(target)) continue // another site, or a place on this page
      const local = decodeURIComponent(target.split('#')[0].split('?')[0])
      if (local && !fs.existsSync(path.resolve(dir, path.dirname(file), local))) hits.push({ line: index + 1, kind: 'files', what: `points to ${local}, which is not there` })
    }
  })
  return hits
}

function tracked(dir, only) {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files', '-z', '--', ...(only.length ? only : ['.'])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean)
  } catch {
    // Not a git checkout (an exported copy): every file but what is never published.
    const out = []
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', '.expo'].includes(entry.name)) continue
        const next = path.join(rel, entry.name)
        if (entry.isDirectory()) walk(next); else out.push(next)
      }
    }
    for (const start of only.length ? only : ['']) { if (fs.statSync(path.join(dir, start)).isDirectory()) walk(start); else out.push(start) }
    return out
  }
}

/** Check a tree → `{ files, hits: [{ file, line, kind, what }], pictures }`. */
export function check(dir = root, only = []) {
  const hits = []
  let pictures = 0
  const files = tracked(dir, only)
  for (const file of files) {
    const full = path.join(dir, file)
    let stat
    try { stat = fs.statSync(full) } catch { continue } // listed but removed and not yet committed
    if (!stat.isFile()) continue
    for (const hit of checkFile(file, stat.size)) hits.push({ file, line: 0, ...hit })
    for (const hit of checkLine(file, file)) if (hit.kind === 'names') hits.push({ file, line: 0, kind: 'names', what: `in the file's own name: ${hit.what}` })
    if (/\.(png|jpe?g|webp|gif)$/i.test(file)) pictures++
    if (stat.size > MAX_BYTES) continue
    const bytes = fs.readFileSync(full)
    if (bytes.subarray(0, 8192).includes(0)) continue // not text
    const lines = bytes.toString('utf8').split('\n')
    if (/\.md$/i.test(file)) for (const hit of missingLinks(dir, file, lines)) hits.push({ file, ...hit })
    lines.forEach((text, index) => {
      // A line too long to have been written by hand (a built file, an inlined picture) is not read.
      if (text.length > 4000) return
      for (const hit of checkLine(file, text)) hits.push({ file, line: index + 1, ...hit })
    })
  }
  return { files: files.length, hits, pictures }
}

const NO_REPLY = /@users\.noreply\.github\.com$/i

/**
 * What is wrong with one author or committer: an address that is not a GitHub no-reply one, or a name that belongs
 * to one set-up. The account's own GitHub name, as its no-reply address spells it, is who wrote it: that is fine.
 */
export function checkWho(who, mail, role = 'author') {
  const hits = []
  if (!NO_REPLY.test(mail || '')) hits.push({ kind: 'names', what: `its ${role} is not a GitHub no-reply address (${String(mail || '').replace(/^(.).*@/, '$1…@')})` })
  const own = (String(mail || '').match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i) || [])[1]
  const word = own && String(who || '').toLowerCase() === own.toLowerCase() ? null : NAMES.exec(String(who || ''))
  if (word) hits.push({ kind: 'names', what: `its ${role}'s name "${word[0]}" belongs to one person's set-up` })
  return hits
}

/** What is wrong with a commit message, line by line. A message still being written leaves out git's comment lines. */
export function checkMessage(body, { writing = false } = {}) {
  const hits = []
  String(body || '').split('\n').forEach((text, index) => {
    if (writing && text.startsWith('#')) return
    for (const hit of checkLine('COMMIT_EDITMSG', text)) hits.push({ line: index + 1, ...hit })
  })
  return hits
}

/** Each commit in `range` (git's A..B): its message read like a file's lines, and who wrote and committed it. */
export function checkCommits(dir, range) {
  const out = execFileSync('git', ['log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', range], { cwd: dir, encoding: 'utf8' })
  const hits = []
  for (const record of out.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
    const [sha, an, ae, cn, ce, body] = record.split('\x1f')
    const file = `commit ${sha.slice(0, 7)}`
    for (const [who, mail, role] of [[an, ae, 'author'], [cn, ce, 'committer']]) {
      for (const hit of checkWho(who, mail, role)) hits.push({ file, line: 0, ...hit })
    }
    for (const hit of checkMessage(body)) hits.push({ file, ...hit })
  }
  return hits
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  // A commit being made (tools/hooks/commit-msg): its message and who it is made as, so a word the push would refuse
  // is refused here, before it sits under every commit after it (18 and 20 Nov 2026: one such commit held back
  // every push of main for days).
  if (args[0] === '--message') {
    const ident = (name) => { try { return execFileSync('git', ['var', name], { encoding: 'utf8' }).trim() } catch { return '' } }
    const split = (line) => { const m = line.match(/^(.*?) <([^>]*)>/); return m ? [m[1], m[2]] : ['', ''] }
    const hits = [...checkMessage(fs.readFileSync(args[1], 'utf8'), { writing: true }).map((hit) => ({ file: 'message', ...hit }))]
    for (const [name, role] of [['GIT_AUTHOR_IDENT', 'author'], ['GIT_COMMITTER_IDENT', 'committer']]) {
      const [who, mail] = split(ident(name))
      for (const hit of checkWho(who, mail, role)) hits.push({ file: 'commit', line: 0, ...hit })
    }
    for (const hit of hits) console.error(`  ${hit.file}${hit.line ? `:${hit.line}` : ''}  ${hit.what}`)
    if (hits.length) console.error('commit refused: the push check would refuse this commit, and every push after it. Reword the message (no job codes, no names of one set-up).')
    process.exit(hits.length ? 1 : 0)
  }
  // Would this name and address pass as a commit's author? (the bots' git asks before it commits here)
  if (args[0] === '--who') process.exit(checkWho(args[1], args[2]).length ? 1 : 0)
  const at = args.indexOf('--commits')
  const range = at >= 0 ? args[at + 1] : ''
  const only = args.filter((arg, i) => !arg.startsWith('--') && !(at >= 0 && i === at + 1))
  const { files, hits, pictures } = check(root, only)
  if (range) hits.push(...checkCommits(root, range))
  const titles = { names: 'Personal or belonging to one set-up', secrets: 'Looks like a secret', files: 'Should not be tracked' }
  for (const kind of Object.keys(titles)) {
    const mine = hits.filter((hit) => hit.kind === kind)
    if (!mine.length) continue
    console.log(`\n${titles[kind]} (${mine.length}):`)
    for (const hit of mine) console.log(`  ${hit.file}${hit.line ? `:${hit.line}` : ''}  ${hit.what}`)
  }
  console.log(`\n${files} files checked: ${hits.length ? `${hits.length} to fix. A wanted exception ends its line with "${ALLOW}".` : 'nothing personal, nothing secret, nothing heavy.'}`)
  if (pictures) console.log(`${pictures} pictures are tracked. A script cannot read a picture: look at each before publishing.`)
  process.exit(hits.length ? 1 : 0)
}
