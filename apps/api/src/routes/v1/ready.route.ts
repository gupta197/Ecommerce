import { Router } from 'express'
import { isDatabaseReady } from '../../db/connection.js'
import { sendSuccess } from '../../lib/response.js'
import type { ErrorCode } from '../../lib/http-errors.js'

export const readyRouter = Router()

readyRouter.get('/ready', (_req, res) => {
  if (!isDatabaseReady()) {
    const code: ErrorCode = 'NOT_READY'
    res.status(503).json({
      success: false,
      error: { code, message: 'Database connection is not ready', details: [] },
    })
    return
  }
  sendSuccess(res, { status: 'ok', mongo: 'connected' })
})
