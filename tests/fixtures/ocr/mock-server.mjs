import { createServer } from 'node:http'

const port = Number(process.argv[2])
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ logId: 'test', errorCode: 0, errorMsg: 'Healthy' }))
    return
  }
  if (request.url === '/ocr' && request.method === 'POST') {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const bytes = Buffer.from(body.file, 'base64')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        logId: 'test',
        errorCode: 0,
        errorMsg: 'Success',
        result: {
          ocrResults: [{ prunedResult: { rec_texts: [`模拟识别 ${bytes.length} 字节`], rec_scores: [0.99] } }],
          dataInfo: {},
        },
      }))
    })
    return
  }
  response.writeHead(404).end()
})
server.listen(port, '127.0.0.1', () => console.log(`Mock OCR listening on ${port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
