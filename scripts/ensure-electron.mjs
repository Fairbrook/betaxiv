// Make sure the Electron binary is actually downloaded.
//
// The `electron` package fetches its binary in its own postinstall script. That step
// is skipped when a package manager blocks dependency scripts (pnpm >= 10, bun) and
// is lost when another dependency's install script fails mid-install. Then
// `npm run dev` fails with "Error: Electron uninstall". The root package's own
// postinstall still runs in those cases, so repair the download from here.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.warn('[betaxiv] electron is not installed; skipping binary check')
  process.exit(0)
}

const pathFile = join(electronDir, 'path.txt')
const binaryOk = () =>
  existsSync(pathFile) && existsSync(join(electronDir, 'dist', readFileSync(pathFile, 'utf8').trim()))

if (binaryOk()) process.exit(0)

console.log('[betaxiv] Electron binary missing — downloading it now…')
const res = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit', cwd: electronDir })
if (res.status !== 0 || !binaryOk()) {
  console.error(
    '[betaxiv] Could not download the Electron binary. Check your network/proxy, then run:\n' +
      `  node ${join('node_modules', 'electron', 'install.js')}`
  )
  process.exit(1)
}
console.log('[betaxiv] Electron binary installed.')
