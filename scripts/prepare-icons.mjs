import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFile } from 'node:fs/promises'

// Keep the supplied artwork intact; encode Windows' common icon sizes.
const source = await loadImage('resources/icons/app.png')
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const images = sizes.map(size => {
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, size, size)
  return canvas.toBuffer('image/png')
})
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
images.forEach((image, index) => {
  const entry = 6 + index * 16, size = sizes[index]
  header[entry] = header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += image.length
})
await writeFile('resources/icons/app.ico', Buffer.concat([header, ...images]))
console.log(`Application icon ready: ${sizes.join(', ')} px`)
