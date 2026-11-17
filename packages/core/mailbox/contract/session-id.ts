import { type FerretId, FerretIdSchema } from '@ferretry/core-ferrets/contract';

/** A ferret's id. The ported send code still says `SessionId` for the id it keys its files by; it is the ferret's. */
export type SessionId = FerretId;

export function parseSessionId(value: string): SessionId {
  return FerretIdSchema.parse(value);
}

export function tryParseSessionId(value: string): SessionId | undefined {
  const parsed = FerretIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
