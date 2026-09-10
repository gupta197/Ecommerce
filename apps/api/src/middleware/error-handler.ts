import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../lib/http-errors.js'
import type { Logger } from '../lib/logger.js'

export function createErrorHandler(logger: Logger) {
  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        logger.error({ err, requestId: req.id }, 'Request failed with server error')
      }
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details ?? [] },
      })
      return
    }

    if (err instanceof ZodError) {
      res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      })
      return
    }

    logger.error({ err, requestId: req.id }, 'Unhandled error')
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: [] },
    })
  }
}
