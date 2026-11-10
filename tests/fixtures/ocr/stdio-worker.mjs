import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
setTimeout(() => console.log(JSON.stringify({ type: 'ready', protocol: 1 })), 30)
for await (const line of createInterface({ input: process.stdin })) {
  const { id, path } = JSON.parse(line)
  const text = await readFile(path, 'utf8')
  if (text === 'crash') process.exit(2)
  if (text === 'hang') continue
  if (text === 'malformed') { console.log('not json'); continue }
  await new Promise((done) => setTimeout(done, 20))
  console.log(JSON.stringify({ id, lines: [{ text }] }))
}
