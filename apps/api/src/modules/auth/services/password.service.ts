import { hash, verify } from '@node-rs/argon2'

// Current OWASP-recommended Argon2id minimums. Hardcoded constants, not env
// vars — these are security parameters that shouldn't be casually weakened
// via configuration.
const ARGON2_OPTIONS = {
  memoryCost: 19_456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS)
}

export async function verifyPassword(
  passwordHash: string,
  plainPassword: string,
): Promise<boolean> {
  return verify(passwordHash, plainPassword)
}
