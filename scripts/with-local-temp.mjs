import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [entry, ...args] = process.argv.slice(2)
if (!entry) throw new Error('Usage: node scripts/with-local-temp.mjs <script-path> [args...]')
const temporaryDirectory = resolve('.tmp')
mkdirSync(temporaryDirectory, { recursive: true })
const buildArgs = [...args]
if (entry.includes('electron-builder') && !args.some((arg) => arg.startsWith('--config.directories.output'))) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  buildArgs.push(`--config.directories.output=artifacts/${version}`)
}
const child = spawn(process.execPath, [resolve(entry), ...buildArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
