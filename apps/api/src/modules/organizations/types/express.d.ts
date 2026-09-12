// Additive TypeScript declaration merge — SEC-001's apps/api/src/types/express.d.ts
// already declares Express.Request.auth; this file merges req.membership
// alongside it without editing that completed-task file.
declare global {
  namespace Express {
    interface Request {
      membership?: {
        membershipId: string
        organizationId: string
        role: 'OWNER' | 'ADMIN' | 'MEMBER'
      }
    }
  }
}

export {}
