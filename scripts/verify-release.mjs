import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import ignore from 'ignore'
import { verifyOcrLicenses } from './verify-ocr-licenses.mjs'

const root = resolve('.')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const pkg = await json('package.json'), lock = await json('package-lock.json')
if (pkg.license !== 'MIT' || lock.packages[''].license !== 'MIT' || pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package version/license mismatch')
if (!(await readFile('LICENSE', 'utf8')).includes('Permission is hereby granted')) throw new Error('MIT license missing')
const rules = ignore().add(await readFile('.gitignore', 'utf8')).add('.git/')
for (const path of ['.qoder-credits/report.json', '.env.local', '.mcp.json', 'invoice.db', 'signing.pfx', 'invoice-files/test.pdf', 'backups/test.zip']) {
  if (!rules.ignores(path)) throw new Error(`Private path is not ignored: ${path}`)
}
if (rules.ignores('.env.example')) throw new Error('Example configuration must be publishable')
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:ghp|github_pat)_[A-Za-z0-9_]{30,}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, /\b26\d{18}\b/]
let scanned = 0
async function scan(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, path = join(directory, entry.name)
    if (rules.ignores(name + (entry.isDirectory() ? '/' : ''))) continue
    if (entry.isSymbolicLink()) throw new Error(`Review source symlink before release: ${name}`)
    if (entry.isDirectory()) await scan(path, name + '/')
    else if (['.ts', '.vue', '.mjs', '.js', '.json', '.md', '.txt', '.py', '.yml', '.yaml', '.xml', '.css', '.html', '.svg', '.toml', '.ini', '.ps1', '.sh', '.spec'].includes(extname(name)) || entry.name === 'LICENSE') {
      const content = await readFile(path, 'utf8'); scanned++
      if (patterns.some(pattern => pattern.test(content))) throw new Error(`Review possible private sample/credential: ${name}`)
    }
  }
}
await scan(root)
const packages = []
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue
  if (!entry.license) throw new Error(`Dependency has no license metadata: ${path}`)
  packages.push({ path, version: entry.version, license: entry.license, integrity: entry.integrity })
}
await mkdir('resources', { recursive: true })
await writeFile('resources/third-party-npm.json', JSON.stringify({ application: pkg.name, version: pkg.version, packages }, null, 2) + '\n')
if (!process.argv.includes('--source-only')) await verifyOcrLicenses(resolve('.tmp/ocr-runtime'))
console.log(`Release checks passed: ${scanned} source files, ${packages.length} production dependency license entries${process.argv.includes('--source-only') ? ' (OCR runtime checked during packaging)' : ', OCR/model licenses verified'}`)
