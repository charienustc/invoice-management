import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OcrServiceStatus } from '@shared/contracts'
import { AppError } from '@shared/errors'

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024
type Pending = { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
class BuiltinOcrError extends AppError { readonly retryable = true }

/** One local worker, serialized requests, no HTTP listener or model downloads. */
export class BuiltinOcrEngine {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private startupTimer?: NodeJS.Timeout
  private pending?: Pending
  private output = ''
  private serial: Promise<unknown> = Promise.resolve()
  private sequence = 0
  private generation = 0
  private lastError?: string
  private online = false

  constructor(private readonly executable: string, private readonly temporaryRoot: string, private readonly workerArgs: string[] = []) {}

  async status(): Promise<OcrServiceStatus> {
    let available = true
    try { await access(this.executable) } catch { available = false }
    return {
      state: !available || this.lastError ? 'error' : this.online ? 'online' : this.child ? 'starting' : 'offline',
      message: !available ? '内置 OCR 文件缺失，请重新安装应用' : this.lastError ?? (this.online ? '内置 OCR 已就绪' : this.child ? '正在加载识别模型' : '模型已内置，首次识别时启动'),
      pid: this.child?.pid, managedByApp: Boolean(this.child), lastCheckedAt: new Date().toISOString(),
    }
  }

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.lastError = undefined
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    for (const key of Object.keys(env)) if (/^(PYTHONPATH|PYTHONHOME|CONDA)/i.test(key)) delete env[key as keyof typeof env]
    const child = spawn(this.executable, this.workerArgs, { cwd: dirname(this.executable), windowsHide: true, shell: false, stdio: 'pipe', env })
    this.child = child
    this.startupTimer = setTimeout(() => this.fail(child, new BuiltinOcrError('OCR_START_TIMEOUT', '内置 OCR 模型加载超时，请重试')), 60_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      this.output += chunk
      if (Buffer.byteLength(this.output) > MAX_OUTPUT_BYTES) { this.fail(child, new AppError('OCR_RESPONSE_TOO_LARGE', '内置 OCR 响应过大')); return }
      let end: number
      while ((end = this.output.indexOf('\n')) >= 0) {
        const line = this.output.slice(0, end).trim()
        this.output = this.output.slice(end + 1)
        if (!line) continue
        try {
          const value = JSON.parse(line) as { type?: string; id?: number; error?: string; lines?: unknown[] }
          if (value.type === 'ready') {
            clearTimeout(this.startupTimer)
            this.online = true
            this.readyResolve?.()
          } else if (this.pending && value.id === this.pending.id) {
            const pending = this.pending
            this.pending = undefined
            clearTimeout(pending.timer)
            if (value.error) pending.reject(new AppError('OCR_RECOGNITION_FAILED', '内置 OCR 未能读取图片，请检查文件后重试'))
            else if (!Array.isArray(value.lines)) pending.reject(new AppError('OCR_INVALID_RESPONSE', '内置 OCR 返回格式错误'))
            else pending.resolve(value)
          } else throw new Error('Unexpected worker message')
        } catch { this.fail(child, new AppError('OCR_INVALID_RESPONSE', '内置 OCR 通信异常，请重试')); return }
      }
    })
    // Drain stderr without persisting image paths or recognition text in application logs.
    child.stderr.resume()
    child.stdin.on('error', () => this.fail(child, new BuiltinOcrError('OCR_PROCESS_EXITED', '内置 OCR 连接已断开，请重试')))
    child.once('error', () => this.fail(child, new AppError('OCR_START_FAILED', '内置 OCR 无法启动，请检查安装文件')))
    child.once('exit', () => this.fail(child, new BuiltinOcrError('OCR_PROCESS_EXITED', '内置 OCR 已退出，请重试')))
    return this.ready
  }

  recognize(data: Buffer, timeoutMs: number): Promise<unknown> {
    const generation = this.generation
    const result = this.serial.then(async () => {
      if (generation !== this.generation) throw new AppError('OCR_STOPPED', '识别引擎已切换，请重试')
      await this.start()
      await mkdir(this.temporaryRoot, { recursive: true })
      const directory = await mkdtemp(join(this.temporaryRoot, 'request-'))
      try {
        const path = join(directory, 'image.png')
        await writeFile(path, data)
        if (generation !== this.generation || !this.child) throw new AppError('OCR_STOPPED', '识别引擎已停止，请重试')
        const child = this.child
        const id = ++this.sequence
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => this.fail(child, new BuiltinOcrError('OCR_TIMEOUT', '内置 OCR 识别超时，请重试')), timeoutMs)
          this.pending = { id, resolve, reject, timer }
          child.stdin.write(`${JSON.stringify({ id, path })}\n`)
        })
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
    this.serial = result.catch(() => undefined)
    return result
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return
    this.lastError = error.message
    this.online = false
    clearTimeout(this.startupTimer)
    this.readyReject?.(error)
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error) }
    this.pending = undefined
    this.ready = undefined
    this.readyResolve = undefined
    this.readyReject = undefined
    this.output = ''
    this.child = undefined
    child.kill()
  }

  async stop(): Promise<void> {
    this.generation++
    const child = this.child
    if (child) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      this.fail(child, new AppError('OCR_STOPPED', '内置 OCR 已停止'))
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000) })])
      clearTimeout(timer)
    }
    this.lastError = undefined
  }
}
