import { z } from 'zod';

export const SessionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'session id must be 1-128 lowercase ASCII path-safe characters')
  .brand<'SessionId'>();

export type SessionId = z.infer<typeof SessionIdSchema>;

export function parseSessionId(value: string): SessionId {
  return SessionIdSchema.parse(value);
}
export function tryParseSessionId(value: string): SessionId | undefined {
  const parsed = SessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
