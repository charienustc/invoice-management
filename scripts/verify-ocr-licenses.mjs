import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
export async function verifyOcrLicenses(root) {
  for (const name of ['licenses/PYTHON-LICENSE.txt', 'licenses/onnxruntime/LICENSE', 'licenses/onnxruntime/ThirdPartyNotices.txt', 'THIRD_PARTY_NOTICES.txt']) {
    if ((await readFile(join(root, name), 'utf8')).length < 100) throw new Error(`Missing OCR license: ${name}`)
  }
  const licenses = await readdir(join(root, 'licenses'))
  const rapid = licenses.find(name => /^rapidocr-.*\.dist-info$/.test(name))
  if (!rapid) throw new Error('RapidOCR/model licenses missing')
  for (const file of ['LICENSE', 'MODEL_LICENSES.md']) {
    if ((await readFile(join(root, 'licenses', rapid, 'licenses', file), 'utf8')).length < 100) throw new Error(`Missing RapidOCR license: ${file}`)
  }
}
