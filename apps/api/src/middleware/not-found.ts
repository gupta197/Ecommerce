import type { NextFunction, Request, Response } from 'express'
import { NotFoundError } from '../lib/http-errors.js'

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`))
}
