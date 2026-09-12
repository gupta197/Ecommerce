export type ErrorCode =
  'VALIDATION_ERROR' | 'NOT_FOUND' | 'RATE_LIMITED' | 'NOT_READY' | 'INTERNAL_ERROR'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details?: unknown[]

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown[]) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message)
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown[]) {
    super(422, 'VALIDATION_ERROR', message, details)
    this.name = 'ValidationError'
  }
}
