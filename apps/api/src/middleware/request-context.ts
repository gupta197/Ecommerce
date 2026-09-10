import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

const REQUEST_ID_HEADER = 'x-request-id'

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER]
  const requestId = typeof incoming === 'string' && incoming.trim() !== '' ? incoming : randomUUID()
  req.id = requestId
  res.setHeader('X-Request-Id', requestId)
  next()
}
