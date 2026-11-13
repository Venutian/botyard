/**
 * Where Botyard keeps things: the one place a folder name comes from.
 *
 * A yard's home is `$BOTYARD_HOME`, by default `~/.botyard`:
 *
 *   studio.db, runs/, files/   the store and what runs leave behind   dataDir()
 *   run-logs/                  every run's log, and the timetable's    runLogs()
 *   crew/                      bots, instructions, the crew's state    crewDir()
 *   keys/                      pasted keys, readable by you alone      keysDir()
 *   config/                    paired phones, limits, the away link    configDir()
 *   projects/                  projects fetched from an address        projectsDir()
 *
 * Every call makes the folder if it is missing. Nothing here reads what is inside one. A test gets
 * an empty yard by setting `BOTYARD_HOME` to a temp folder.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The repository's own folders: the code, never a yard's data. */
export const studioRoot = () => STUDIO
export const repoRoot = () => path.dirname(STUDIO)
export const crewScripts = () => path.join(repoRoot(), 'crew')

const userHome = (env) => env.HOME || env.USERPROFILE || os.homedir()

function made(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) })
  // mkdir's mode is cut by the umask and does nothing to a folder that was already there.
  if (mode && process.platform !== 'win32') { try { fs.chmodSync(dir, mode) } catch { /* not ours to change */ } }
  return dir
}

/** Where each folder is, without making anything: for a page or a test that only wants to say. */
export function places(env = process.env) {
  const chosen = (env.BOTYARD_HOME || '').trim()
  const root = path.resolve(chosen || path.join(userHome(env), '.botyard'))
  return {
    home: root,
    data: root,
    runLogs: path.join(root, 'run-logs'),
    crew: path.join(root, 'crew'),
    keys: path.join(root, 'keys'),
    config: path.join(root, 'config'),
    projects: path.join(root, 'projects'),
  }
}

export const home = (env = process.env) => made(places(env).home)
/** The store and the map's saved files sit in the home folder itself. */
export const dataDir = (env = process.env) => made(places(env).data)
export const runLogs = (env = process.env) => made(places(env).runLogs)
export const crewDir = (env = process.env) => made(places(env).crew)
/** Keys are for the owner's eyes only: the folder is closed to everyone else on the computer. */
export const keysDir = (env = process.env) => made(places(env).keys, 0o700)
/** Paired phones and the door's own token are in here: closed to everyone else as well. */
export const configDir = (env = process.env) => made(places(env).config, 0o700)
/** Where a project fetched from an address is put, when the person names no folder of their own. */
export const projectsDir = (env = process.env) => made(places(env).projects)
