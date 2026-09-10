import { Router } from 'express'
import { sendSuccess } from '../../lib/response.js'

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  sendSuccess(res, { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() })
})
