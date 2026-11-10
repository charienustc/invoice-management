import type { AppErrorPayload } from './contracts'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toAppErrorPayload(error: unknown): AppErrorPayload {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return { code: 'VALIDATION_ERROR', message: error.message }
  }
  return { code: 'INTERNAL_ERROR', message: '操作失败，请查看应用日志或稍后重试' }
}
