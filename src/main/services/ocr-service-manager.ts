import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { DEFAULT_OCR_SETTINGS, type OcrServiceStatus, type OcrSettings } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { BuiltinOcrEngine } from '../ocr/builtin-engine'

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class OcrServiceManager {
  constructor(private readonly builtin?: BuiltinOcrEngine) {}
  private settings: OcrSettings = DEFAULT_OCR_SETTINGS
  private status: OcrServiceStatus = { state: 'unconfigured', message: '尚未检测 OCR 服务', managedByApp: false }
  private child?: ChildProcess
  private startPromise?: Promise<OcrServiceStatus>
  private processError?: Error
  private stopping = false
  private output: string[] = []

  async configure(settings: OcrSettings): Promise<void> {
    const changed = this.settings.engineMode !== settings.engineMode || this.settings.endpoint !== settings.endpoint
      || this.settings.startupExecutable !== settings.startupExecutable
      || this.settings.startupWorkingDirectory !== settings.startupWorkingDirectory
      || JSON.stringify(this.settings.startupArgs) !== JSON.stringify(settings.startupArgs)
    if (changed) await this.stop()
    this.settings = settings
  }

  async ensure(): Promise<OcrServiceStatus> {
    if (this.settings.engineMode === 'builtin') return this.check()
    const current = await this.check()
    if (current.state !== 'online' && this.settings.autoStart) return this.start()
    return current
  }

  async check(): Promise<OcrServiceStatus> {
    if (this.settings.engineMode === 'builtin') return this.builtin ? this.builtin.status() : this.setStatus('error', '内置 OCR 未初始化')
    if (this.startPromise && this.status.state === 'starting') return this.status
    if (!this.settings.endpoint) return this.setStatus('unconfigured', '请填写 OCR 服务地址')
    this.setStatus('checking', '正在检测 OCR 服务')
    const healthy = await this.probe()
    if (healthy) return this.setStatus('online', 'OCR 服务运行正常')
    if (this.child && this.child.exitCode === null) return this.setStatus('starting', '服务进程已启动，等待健康检查通过')
    return this.setStatus('offline', '未检测到可用的 OCR 服务')
  }

  start(): Promise<OcrServiceStatus> {
    if (this.settings.engineMode === 'builtin') return this.startBuiltin()
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => { this.startPromise = undefined })
    }
    return this.startPromise
  }

  private async startBuiltin(): Promise<OcrServiceStatus> {
    if (!this.builtin) throw new AppError('OCR_NOT_AVAILABLE', '内置 OCR 未初始化')
    await this.builtin.start()
    return this.builtin.status()
  }

  private async startInternal(): Promise<OcrServiceStatus> {
    if (!this.settings.endpoint) throw new AppError('OCR_NOT_CONFIGURED', '请先填写 OCR 服务地址')
    if (await this.probe()) return this.setStatus('online', 'OCR 服务已在运行，无需重复启动')
    const url = new URL(this.settings.endpoint)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new AppError('OCR_AUTO_START_NOT_LOCAL', '自动启动仅支持本机 OCR 服务')
    }
    if (!this.settings.startupExecutable || !isAbsolute(this.settings.startupExecutable)) {
      throw new AppError('OCR_STARTUP_INVALID', '请填写启动程序的绝对路径')
    }
    if (this.settings.startupWorkingDirectory && !isAbsolute(this.settings.startupWorkingDirectory)) {
      throw new AppError('OCR_STARTUP_INVALID', '工作目录必须是绝对路径')
    }

    this.processError = undefined
    this.output = []
    this.setStatus('starting', '正在启动 PaddleOCR 服务')
    const child = spawn(this.settings.startupExecutable, this.settings.startupArgs, {
      cwd: this.settings.startupWorkingDirectory || undefined,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.appendOutput(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.appendOutput(chunk))
    child.once('error', (error) => { this.processError = error })
    child.once('exit', (code) => {
      if (this.child === child) this.child = undefined
      if (!this.stopping && this.status.state !== 'error') {
        this.setStatus('offline', `OCR 服务进程已退出（代码 ${code ?? '未知'}）`)
      }
    })

    const deadline = Date.now() + this.settings.startupTimeoutMs
    try {
      while (Date.now() < deadline) {
        const processError = this.processError as Error | undefined
        if (processError) throw new AppError('OCR_START_FAILED', `OCR 启动失败：${processError.message}`)
        if (child.exitCode !== null) {
          throw new AppError('OCR_START_FAILED', `OCR 启动后退出（代码 ${child.exitCode}）${this.output.slice(-3).join('；')}`)
        }
        if (await this.probe()) return this.setStatus('online', 'PaddleOCR 服务已自动启动')
        await delay(1000)
      }
      throw new AppError('OCR_START_TIMEOUT', `等待 OCR 服务就绪超过 ${this.settings.startupTimeoutMs} ms`)
    } catch (error) {
      if (child.exitCode === null) child.kill()
      const message = error instanceof AppError ? error.message : 'OCR 服务启动失败'
      this.setStatus('error', message)
      throw error
    }
  }

  private async probe(): Promise<boolean> {
    if (!this.settings.endpoint) return false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const url = new URL(this.settings.endpoint)
      url.pathname = '/health'
      url.search = ''
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/json' } })
      if (!response.ok) return false
      const result = await response.json() as unknown
      return typeof result === 'object' && result !== null && 'errorCode' in result && result.errorCode === 0
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  private appendOutput(chunk: Buffer): void {
    const lines = chunk.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    this.output.push(...lines)
    this.output = this.output.slice(-20)
  }

  getRecentLogs(): string[] {
    return [...this.output]
  }

  private setStatus(state: OcrServiceStatus['state'], message: string): OcrServiceStatus {
    this.status = {
      state,
      message,
      pid: this.child?.pid,
      managedByApp: Boolean(this.child),
      lastCheckedAt: new Date().toISOString(),
    }
    return this.status
  }

  async stop(): Promise<void> {
    await this.builtin?.stop()
    this.stopping = true
    const child = this.child
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill()
      await Promise.race([exited, delay(5000)])
      this.setStatus('offline', '由应用启动的 OCR 服务已停止')
    }
    this.child = undefined
    this.stopping = false
  }
}
