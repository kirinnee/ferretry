import type { z } from 'zod';
import { StoredSessionIdSchema } from '../../contract/records.ts';

/** Today's session id; the contract owns its grammar (`StoredSessionIdSchema`), the journal and archive store it. */
export const SessionIdSchema = StoredSessionIdSchema;

export type SessionId = z.infer<typeof SessionIdSchema>;

export function parseSessionId(value: string): SessionId {
  return SessionIdSchema.parse(value);
}
export function tryParseSessionId(value: string): SessionId | undefined {
  const parsed = SessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
