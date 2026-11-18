#!/usr/bin/env node
/**
 * A track's brief check, no AI: the request's words become the brief when they hold every section the
 * track asks for. Usage in a script step: node "$BOTYARD_TRACK_TOOLS/brief.mjs" [SECTION ...]
 * A section is found as a line that starts with its name and a colon or as a heading ("## OUTCOME").
 * It passes and leaves `brief`, or fails and names what is missing, so the track can hand the request
 * to a bot that writes the brief.
 */
import fs from 'node:fs'

const words = process.env.BOTYARD_IN_BRIEF || process.env.BOTYARD_IN_WORDS || ''
const sections = process.argv.slice(2).map((s) => s.trim()).filter(Boolean)
const has = (name) => new RegExp(`^\\s*(#+\\s*)?[*_]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[*_]*\\s*(:|$)`, 'im').test(words)
const missing = sections.filter((name) => !has(name))
const out = !words.trim()
  ? { verdict: 'fail', findings: 'The request has no words to brief from.' }
  : missing.length
    ? { verdict: 'fail', findings: `The brief is missing: ${missing.join(', ')}.` }
    : { verdict: 'pass', leaves: { brief: words }, numbers: { sections: sections.length } }
if (process.env.BOTYARD_STEP_OUT) fs.writeFileSync(process.env.BOTYARD_STEP_OUT, JSON.stringify(out))
console.log(out.verdict === 'pass' ? `The brief has ${sections.length ? `all ${sections.length} sections` : 'words'}.` : out.findings)
process.exit(0)
