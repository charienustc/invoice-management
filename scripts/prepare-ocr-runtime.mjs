import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'

const root = resolve('.tmp/ocr-runtime')
const sources = ['scripts/prepare-ocr-runtime.mjs', 'scripts/verify-ocr-licenses.mjs', 'scripts/ocr/worker.py', 'scripts/ocr/InvoiceOcr.spec', 'scripts/ocr/requirements.txt', 'scripts/ocr/models.json', 'scripts/ocr/THIRD_PARTY_NOTICES.txt']
import { verifyOcrLicenses } from './verify-ocr-licenses.mjs'
const hash = (data) => createHash('sha256').update(data).digest('hex')
const sourceHash = hash(Buffer.concat(await Promise.all(sources.map((path) => readFile(path)))))
const models = JSON.parse(await readFile('scripts/ocr/models.json', 'utf8'))

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}
try {
  const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'))
  if (manifest.sourceHash !== sourceHash) throw new Error('OCR source changed')
  for (const file of manifest.files) {
    const path = resolve(root, file.path)
    if (!path.startsWith(root + '\\') || hash(await readFile(path)) !== file.sha256) throw new Error('OCR file mismatch')
  }
  await verifyOcrLicenses(root)
  console.log('Verified bundled OCR runtime and models')
} catch {
  if (!process.env.INVOICE_OCR_PYTHON) throw new Error('内置 OCR 尚未构建。按 scripts/ocr/README.md 配置 INVOICE_OCR_PYTHON 后重试。')
  const modelDirectory = resolve('.tmp/ocr-models')
  await mkdir(modelDirectory, { recursive: true })
  for (const model of models) {
    const target = join(modelDirectory, model.name)
    let data
    try { data = await readFile(target) } catch {}
    if (!data || hash(data) !== model.sha256) {
      // Download only during a developer build, never from the installed application.
      const response = await fetch(model.url)
      if (!response.ok) throw new Error(`Model download failed: ${response.status}`)
      data = Buffer.from(await response.arrayBuffer())
      if (hash(data) !== model.sha256) throw new Error(`Model checksum mismatch: ${model.name}`)
      await writeFile(target, data)
    }
  }
  await new Promise((done, reject) => {
    const child = spawn(process.env.INVOICE_OCR_PYTHON, ['-m', 'PyInstaller', '--noconfirm', '--distpath', resolve('.tmp/ocr-dist'), '--workpath', resolve('.tmp/ocr-build'), 'scripts/ocr/InvoiceOcr.spec'], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, INVOICE_OCR_MODELS: modelDirectory },
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`OCR build exited: ${code}`)))
  })
  // Copy into a stable resource path. Old versioned installer directories are untouched.
  const built = resolve('.tmp/ocr-dist/InvoiceOcr')
  if (dirname(root) !== resolve('.tmp')) throw new Error('Unexpected OCR cache directory')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (const path of await files(built)) {
    const target = join(root, relative(built, path))
    await mkdir(resolve(target, '..'), { recursive: true })
    await copyFile(path, target)
  }
  const sitePackages = resolve(dirname(process.env.INVOICE_OCR_PYTHON), '../Lib/site-packages')
  for (const name of ['LICENSE', 'ThirdPartyNotices.txt']) {
    const target = join(root, 'licenses', 'onnxruntime', name)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(sitePackages, 'onnxruntime', name), target)
  }
  for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
    const directory = join(sitePackages, entry.name)
    for (const path of await files(directory)) {
      if (!/(license|copying|notice)/i.test(path)) continue
      const target = join(root, 'licenses', entry.name, relative(directory, path))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(path, target)
    }
  }
  await copyFile('scripts/ocr/THIRD_PARTY_NOTICES.txt', join(root, 'THIRD_PARTY_NOTICES.txt'))
  const { stdout } = await promisify(execFile)(process.env.INVOICE_OCR_PYTHON, ['-c', 'import sys;print(sys.base_prefix)'], { windowsHide: true })
  let pythonLicense
  for (const name of ['LICENSE_PYTHON.txt', 'LICENSE.txt', 'LICENSE']) {
    try { pythonLicense = await readFile(join(stdout.trim(), name)); break } catch {}
  }
  if (!pythonLicense) throw new Error('Python redistribution license is missing')
  await mkdir(join(root, 'licenses'), { recursive: true })
  await writeFile(join(root, 'licenses/PYTHON-LICENSE.txt'), pythonLicense)
  await verifyOcrLicenses(root)
  const entries = []
  for (const path of await files(root)) {
    if (path.endsWith('runtime-manifest.json')) continue
    entries.push({ path: relative(root, path), sha256: hash(await readFile(path)) })
  }
  await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify({ sourceHash, engine: 'PP-OCRv6 small / ONNX Runtime CPU', files: entries }, null, 2))
  console.log('Built bundled OCR runtime')
}
