import type { Types } from 'mongoose'
import {
  LoginAttemptModel,
  type LoginAttemptDocument,
  type LoginAttemptReason,
} from '../models/login-attempt.model.js'

export interface CreateLoginAttemptData {
  email: string
  userId?: Types.ObjectId
  success: boolean
  reason?: LoginAttemptReason
  ipAddress?: string
  userAgent?: string
}

export async function create(data: CreateLoginAttemptData): Promise<LoginAttemptDocument> {
  return LoginAttemptModel.create(data)
}
