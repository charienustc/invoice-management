import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

// Bundle PDF.js companion resources for offline file:// previews (including CJK CMaps).
function pdfResources() {
  const root = resolve('node_modules/pdfjs-dist')
  const folders = ['cmaps', 'standard_fonts', 'wasm']
  return {
    name: 'offline-pdf-resources',
    generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: Buffer }) => void }) {
      for (const folder of folders) for (const file of readdirSync(resolve(root, folder))) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${file}`, source: readFileSync(resolve(root, folder, file)) })
      }
    },
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const match = request.url?.match(/^\/(cmaps|standard_fonts|wasm)\/([\w.-]+)$/)
        if (!match) return next()
        try {
          response.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
          response.end(readFileSync(resolve(root, match[1], match[2])))
        } catch { response.statusCode = 404; response.end() }
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), { name: 'pdf-worker', generateBundle() { this.emitFile({type: 'asset', fileName: 'pdf-worker.mjs', source: readFileSync(resolve('src/main/ocr/pdf-worker.mjs'))}) } }],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'mcp-stdio': resolve('src/main/mcp-stdio.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [vue(), pdfResources()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    worker: {
      format: 'es',
    },
  },
})
