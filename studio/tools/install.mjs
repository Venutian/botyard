#!/usr/bin/env node
/**
 * Make Botyard a service of this computer: started when you log in, started again if it stops.
 *
 *   node tools/install.mjs           write and start the one unit, botyard.service (Linux)
 *   node tools/install.mjs --dry     print the unit and change nothing
 *   node tools/install.mjs --remove  stop it and take the unit away
 *
 * The unit stops only Botyard's own process (KillMode=process): every bot's run has a keeper of its
 * own, which goes on through a restart, so restarting Botyard never costs a bot its work.
 * On macOS it writes a launch agent (`~/Library/LaunchAgents/org.botyard.plist`) and says the one
 * command that loads it; `--dry` prints the agent. On Windows it says how to run the shortcut
 * installer, `tools\install-windows.ps1`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const UNIT = 'botyard.service'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A value in a unit file: one line, with `%` doubled so systemd reads it as written. */
const plain = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error('A path with a line break cannot go in a unit file')
  return String(value).replaceAll('%', '%%')
}

/** The unit's text. `variables` are extra `NAME=value` lines (a home or a port chosen by hand). */
export function unitText({ studio = root, node = process.execPath, home = os.homedir(), variables = {} } = {}) {
  // A service has no shell profile: the folders the AI tools are usually installed in are named here.
  const dirs = [path.dirname(node), path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
  const lines = [
    '[Unit]',
    'Description=Botyard: the map, the phone\'s door, the engine and the crew\'s timetable',
    'After=network-online.target',
    '',
    '[Service]',
    `WorkingDirectory=${plain(studio)}`,
    `Environment="PATH=${plain([...new Set(dirs)].join(':'))}"`,
    ...Object.entries(variables).map(([name, value]) => `Environment="${name}=${plain(value)}"`),
    `ExecStart="${plain(node)}" server/studio.mjs`,
    '# Each run has a keeper of its own that must outlive a restart: stop only Botyard itself.',
    'KillMode=process',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ]
  return lines.join('\n')
}

/** Variables worth carrying into the unit when they were set for this install. */
export function carried(env = process.env) {
  const out = {}
  for (const name of ['BOTYARD_HOME', 'PORT', 'BOTYARD_ENGINE_PORT', 'BOTYARD_PHONE_PORT', 'BOTYARD_HOST']) if (env[name]) out[name] = env[name]
  return out
}

const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

export const AGENT = 'org.botyard'
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * macOS: the launch agent that starts Botyard when you log in and starts it again if it stops.
 * Only Botyard's own process is the agent's: each run's keeper is started apart from it, so it goes
 * on through a restart, as on Linux.
 */
export function plistText({ studio = root, node = process.execPath, home = os.homedir(), variables = {} } = {}) {
  const dirs = [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/bin', '/bin']
  const env = { PATH: [...new Set(dirs)].join(':'), ...variables }
  const logs = path.join(variables.BOTYARD_HOME || path.join(home, '.botyard'), 'launcher')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(path.join(studio, 'server', 'studio.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(studio)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'server-error.log'))}</string>
</dict>
</plist>
`
}

/** Windows keeps Botyard going with a shortcut that starts it at login: its own script makes it. */
const onWindows = () => `On Windows, Botyard is started at login by a shortcut. From this folder, in PowerShell:

  powershell -ExecutionPolicy Bypass -File tools\\install-windows.ps1            adds it to the Desktop, the Start menu and login
  powershell -ExecutionPolicy Bypass -File tools\\install-windows.ps1 -Remove    takes them away again

Its log is in the "launcher" folder of your Botyard home (%USERPROFILE%\\.botyard\\launcher).`

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  const known = ['--dry', '--remove']
  if ([...args].some((arg) => !known.includes(arg))) { console.error('Usage: node tools/install.mjs [--dry] [--remove]'); process.exit(1) }
  const text = unitText({ variables: carried() })
  if (process.platform === 'win32') { console.log(onWindows()); process.exit(0) }
  if (process.platform === 'darwin') {
    const plist = plistText({ variables: carried() })
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT}.plist`)
    if (args.has('--dry')) { process.stdout.write(plist); process.exit(0) }
    if (args.has('--remove')) {
      console.log(`To stop Botyard's launch agent and take it away, run these two:\n\n  launchctl unload -w "${file}"\n  rm "${file}"\n\nYour yard's data is untouched.`)
      process.exit(0)
    }
    if (!fs.existsSync(path.join(root, 'node_modules'))) { console.error('Run `npm install` in this folder first.'); process.exit(1) }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.join(carried().BOTYARD_HOME || path.join(os.homedir(), '.botyard'), 'launcher'), { recursive: true })
    fs.writeFileSync(file, plist)
    console.log(`The launch agent is written: ${file}\nStart it now, and at every login, with:\n\n  launchctl load -w "${file}"\n\n  Its log:      ~/.botyard/launcher/server.log\n  Restart it:   launchctl kickstart -k gui/$(id -u)/${AGENT}\n  Take it away: npm run install-service -- --remove`)
    process.exit(0)
  }
  if (args.has('--dry')) { process.stdout.write(text); process.exit(0) }
  if (process.platform !== 'linux') { console.log('This script installs Botyard as a service on Linux, macOS and Windows. Here, start it by hand: npm start'); process.exit(0) }

  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user')
  const file = path.join(dir, UNIT)
  try {
    if (args.has('--remove')) {
      try { systemctl('disable', '--now', UNIT) } catch { /* it was not running */ }
      fs.rmSync(file, { force: true })
      systemctl('daemon-reload')
      console.log(`Botyard's service is stopped and ${file} is gone. Your yard's data is untouched.`)
      process.exit(0)
    }
    if (!fs.existsSync(path.join(root, 'node_modules'))) { console.error('Run `npm install` in this folder first.'); process.exit(1) }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, text)
    systemctl('daemon-reload')
    systemctl('enable', '--now', UNIT)
    console.log(`Botyard is installed as ${UNIT} and running.\n  See it:        systemctl --user status ${UNIT}\n  Its log:       journalctl --user -u ${UNIT} -f\n  Restart it:    systemctl --user restart ${UNIT}\n  Keep it running while you are logged out:  loginctl enable-linger ${os.userInfo().username}`)
  } catch (err) {
    console.error(`The service could not be installed: ${String(err.stderr || err.message).trim()}`)
    process.exit(1)
  }
}
