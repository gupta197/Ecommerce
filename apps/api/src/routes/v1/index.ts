import { Router } from 'express'
import { healthRouter } from './health.route.js'

export function createV1Router(): Router {
  const router = Router()
  router.use(healthRouter)
  return router
}
