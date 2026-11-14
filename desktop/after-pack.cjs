/**
 * After the app is packed, before the installer is made: on macOS, sign it ad hoc.
 *
 * Botyard's releases are not signed with an Apple Developer ID, and an Apple Silicon Mac refuses to
 * start an app with no signature at all. An ad-hoc signature (`codesign --sign -`) is enough for it
 * to start once the owner has allowed it (see the release notes); it proves nothing about who made it.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
