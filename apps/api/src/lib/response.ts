import type { Response } from 'express'

export function sendSuccess<T>(
  res: Response,
  data: T,
  meta: Record<string, unknown> = {},
  statusCode = 200,
): void {
  res.status(statusCode).json({ success: true, data, meta })
}
