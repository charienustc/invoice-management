<template>
  <div class="preview-panel">
    <div class="preview-header"><span :title="fileName">{{ fileName }}</span><div class="zoom-controls"><button type="button" aria-label="缩小" :disabled="zoom <= .25" @click="zoom = Math.max(.25, zoom - .25)"><el-icon><Minus /></el-icon></button><button type="button" class="zoom-reset" aria-label="适合宽度" @click="fitPage = false; zoom = 1">{{ Math.round(displayZoom * 100) }}%</button><button type="button" aria-label="放大" :disabled="zoom >= 2.5" @click="zoom = Math.min(2.5, zoom + .25)"><el-icon><Plus /></el-icon></button><button type="button" class="fit-page" aria-label="适合整页" :aria-pressed="fitPage" @click="fitPage = true; zoom = 1">整页</button></div></div>
    <div ref="container" v-loading="loading" class="preview-body">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <div v-else class="preview-document" :style="{ width: `${displayZoom * 100}%` }"><div class="preview-media"><img v-if="!isPdf" class="invoice-image" :src="url" :alt="fileName" @load="imageLoaded" /><canvas v-else ref="canvas" class="pdf-canvas" /><svg v-if="highlightPoints" class="evidence-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" :aria-label="`${highlightLabel}识别位置`"><polygon ref="highlightPolygon" :points="highlightPoints" /></svg></div></div>
    </div>
    <div v-if="highlightLabel" class="position-caption" role="status">{{ highlightPoints ? `识别位置 · ${highlightLabel}` : `${highlightLabel}：未提供可定位坐标` }}</div>
    <div v-if="isPdf && pageCount" class="preview-footer"><el-pagination small background layout="prev, pager, next" :total="pageCount" :page-size="1" :current-page="page" @current-change="page = $event" /><span>共 {{ pageCount }} 页</span></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { api } from '@/api'
import { Minus, Plus } from '@element-plus/icons-vue'
import type { OcrFieldEvidence } from '@shared/contracts'
import { MAX_PDF_PAGES, checkPdfDimensions } from '@shared/pdf-limits'

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
const props = defineProps<{ invoiceId: string; fileName: string; mimeType: string; highlight?: OcrFieldEvidence['region']; highlightLabel?: string }>()
const url = computed(() => `invoice-file://invoice/${props.invoiceId}`)
const isPdf = computed(() => props.mimeType === 'application/pdf')
const container = ref<HTMLElement>()
const canvas = ref<HTMLCanvasElement>()
const loading = ref(false)
const error = ref('')
const page = ref(1)
const zoom = ref(1)
const pageCount = ref(0)
const fitPage = ref(true)
const containerSize = ref({ width: 0, height: 0 })
const displayZoom = computed(() => {
  const { width, height } = sourceSize.value
  const availableWidth = containerSize.value.width - 36
  const availableHeight = containerSize.value.height - 36
  const fit = fitPage.value && width > 0 && height > 0 && availableWidth > 0 && availableHeight > 0
    ? Math.min(1, availableHeight / (availableWidth * height / width)) : 1
  return fit * zoom.value
})
const sourceSize = ref({ width: 0, height: 0 })
const highlightPolygon = ref<SVGPolygonElement>()
const highlightPoints = computed(() => {
  const region = props.highlight
  if (!region || region.page !== page.value) return ''
  const width = region.imageWidth || sourceSize.value.width, height = region.imageHeight || sourceSize.value.height
  if (!(width > 0 && height > 0) || region.bbox.length < 4) return ''
  const points = region.bbox.map(([x, y]) => [x / width * 1000, y / height * 1000])
  if (points.some(point => point.some(value => !Number.isFinite(value) || value < 0 || value > 1001))) return ''
  return points.map(point => point.join(',')).join(' ')
})
async function revealHighlight(): Promise<void> {
  await nextTick()
  highlightPolygon.value?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: window.document.documentElement.dataset.motion === 'reduce' ? 'instant' : 'smooth' })
}
function imageLoaded(event: Event): void {
  const image = event.target as HTMLImageElement
  sourceSize.value = { width: image.naturalWidth, height: image.naturalHeight }
  void revealHighlight()
}
let document: PDFDocumentProxy | null = null
let loadVersion = 0
let renderVersion = 0
let renderTask: RenderTask | undefined

async function renderPage(): Promise<void> {
  if (!document || !canvas.value || !container.value) return
  const version = ++renderVersion
  const load = loadVersion
  renderTask?.cancel()
  await renderTask?.promise.catch(() => {})
  if (version !== renderVersion || !document) return
  loading.value = true
  error.value = ''
  try {
    const pdfPage = await document.getPage(page.value)
    if (version !== renderVersion || load !== loadVersion || !canvas.value) return
    const base = pdfPage.getViewport({ scale: 1 })
    checkPdfDimensions(base.width, base.height)
    const ocrScale = Math.min(2, 2200 / base.width)
    sourceSize.value = { width: Math.ceil(base.width * ocrScale), height: Math.ceil(base.height * ocrScale) }
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const cssWidth = Math.max(1, container.value.clientWidth - 36) * displayZoom.value
    const viewport = pdfPage.getViewport({ scale: cssWidth / base.width * ratio })
    checkPdfDimensions(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const target = canvas.value
    target.width = Math.floor(viewport.width)
    target.height = Math.floor(viewport.height)
    target.style.width = '100%'
    target.style.height = 'auto'
    const context = target.getContext('2d')
    if (!context) throw new Error('无法创建 PDF 画布')
    renderTask = pdfPage.render({ canvas: target, canvasContext: context, viewport })
    await renderTask.promise
    if (version === renderVersion && load === loadVersion) await revealHighlight()
  } catch (reason) { if (version === renderVersion && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) error.value = reason instanceof Error ? reason.message : 'PDF 渲染失败' } finally { if (version === renderVersion) loading.value = false }
}

async function loadDocument(): Promise<void> {
  const version = ++loadVersion
  renderVersion++
  renderTask?.cancel()
  await document?.loadingTask.destroy()
  document = null
  page.value = 1
  zoom.value = 1
  fitPage.value = true
  pageCount.value = 0
  sourceSize.value = { width: 0, height: 0 }
  error.value = ''
  loading.value = false
  if (!isPdf.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await api.getInvoiceFileData(props.invoiceId)
    const resourceUrl = new URL('./pdfjs/', window.location.href).href
    const loaded = await pdfjs.getDocument({ data, cMapUrl: `${resourceUrl}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${resourceUrl}standard_fonts/`, wasmUrl: `${resourceUrl}wasm/`, useSystemFonts: true }).promise
    if (version !== loadVersion) { await loaded.loadingTask.destroy(); return }
    if (loaded.numPages > MAX_PDF_PAGES) { await loaded.loadingTask.destroy(); throw new Error('单个 PDF 最多支持 20 页') }
    document = loaded
    pageCount.value = document.numPages
    page.value = Math.min(props.highlight?.page ?? 1, document.numPages)
    await nextTick()
    await renderPage()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : 'PDF 加载失败' } finally { loading.value = false }
}

watch(url, loadDocument, { immediate: true })
watch(page, () => void renderPage())
watch([zoom, fitPage], () => void renderPage())
let resizeObserver: ResizeObserver | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    if (Math.abs(width - containerSize.value.width) < 1 && Math.abs(height - containerSize.value.height) < 1) return
    containerSize.value = { width, height }
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => void renderPage(), 100)
  })
  if (container.value) resizeObserver.observe(container.value)
})
watch(() => props.highlight, async (region) => {
  if (isPdf.value && region && region.page <= pageCount.value && region.page !== page.value) page.value = region.page
  else await revealHighlight()
})
onBeforeUnmount(() => { resizeObserver?.disconnect(); clearTimeout(resizeTimer); loadVersion++; renderVersion++; renderTask?.cancel(); void document?.loadingTask.destroy() })
</script>

<style scoped>
.preview-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: light-dark(#edf1f5, #292a2f); }
.preview-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: light-dark(#fff, #242529); font-size: 12px; }
.preview-header > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-body { flex: 1; min-height: 0; overflow: auto; padding: 18px; text-align: center; }
.invoice-image { max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 4px 18px #1a254222; }
.pdf-canvas { display: block; max-width: 100%; height: auto; margin: 0 auto; box-shadow: 0 4px 18px #1a254222; }
.preview-footer { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px; border-top: 1px solid var(--border); background: light-dark(#fff, #242529); color: var(--muted); font-size: 12px; }
.preview-document { margin: 0 auto; transform-origin: top left; }
.preview-media { position: relative; width: 100%; }
.invoice-image { display: block; width: 100%; }
.evidence-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.evidence-overlay polygon { fill: #007aff24; stroke: var(--primary); stroke-width: 2; vector-effect: non-scaling-stroke; }
.position-caption { flex: none; padding: 8px 12px; text-align: center; font-size: 11px; color: var(--muted); background: var(--el-bg-color); border-top: 1px solid var(--border); }
.zoom-controls { display: flex; align-items: center; flex: none; border: 1px solid light-dark(#dcdce1, #393b43); border-radius: 6px; background: light-dark(#fff, #242529); }
.zoom-controls button { display: grid; place-items: center; width: 28px; height: 24px; border: 0; background: transparent; color: light-dark(#666670, #e4e4eb); cursor: pointer; }
.zoom-controls button:hover:enabled { background: light-dark(#eeeef2, #292a2f); }
.zoom-controls button:disabled { opacity: .35; cursor: default; }
.zoom-controls .zoom-reset { width: 44px; font-size: 10px; font-variant-numeric: tabular-nums; }
</style>

<style scoped>
.zoom-controls .fit-page { width: 38px; font-size: 11px; border-left: 1px solid var(--border); }
.zoom-controls .fit-page[aria-pressed="true"] { color: var(--primary); }
</style>
