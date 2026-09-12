declare global {
  namespace Express {
    interface Request {
      id: string
      auth?: {
        userId: string
        sessionId: string
      }
    }
  }
}

export {}
