/**
 * "Sync from GitHub" on the Projects page: runs the crew's github-projects.py, which lists the signed-in
 * account's repositories that look like projects and (with add) makes the missing ones. The sign-in stays
 * inside gh; only repo names, descriptions and visibility come back.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { crewDir } from './home.mjs'

const SCRIPT = () => path.join(process.env.BOTYARD_CREW_FOLDER || crewDir(), 'github-projects.py')

export const syncGithub = ({ add = false } = {}) => new Promise((resolve, reject) => {
  execFile('python3', ['-I', SCRIPT(), '--json', ...(add ? ['--add'] : [])], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    try {
      const out = JSON.parse(stdout)
      return resolve({ add: out.add, drop: out.drop, have: out.have, suggest: out.suggest, summary: out.summary, added: add })
    } catch {
      return reject(Object.assign(new Error(err ? 'GitHub could not be read. Is gh signed in on this computer?' : 'The sync gave no list'), { status: 502 }))
    }
  })
})
