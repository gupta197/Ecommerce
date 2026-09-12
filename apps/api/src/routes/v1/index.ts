import { Router } from 'express'
import { healthRouter } from './health.route.js'
import { readyRouter } from './ready.route.js'

export function createV1Router(): Router {
  const router = Router()
  router.use(healthRouter)
  router.use(readyRouter)
  return router
}
