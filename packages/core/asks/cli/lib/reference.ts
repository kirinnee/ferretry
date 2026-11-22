import { type AgendaId, AgendaIdSchema, askReference, stripAskReferenceSigil } from '@ferretry/core-asks/contract';

/** How an agenda item is cited in prose and in the listing. */
export function agendaReference(id: AgendaId): string {
  return askReference(id);
}

/**
 * Read what a human typed as an agenda id.
 *
 * `^A3`, the older `!A3`, `?A3` and `A3` all name the same item — several sigils are in circulation, and rejecting
 * one of them would only punish whoever copied the wrong style out of a chat log. Only `^A3` is ever written.
 */
export function parseAgendaReference(value: string): AgendaId {
  const parsed = AgendaIdSchema.safeParse(stripAskReferenceSigil(value));
  if (!parsed.success) {
    throw new Error(
      `"${value.trim()}" is not an agenda reference — they look like ${askReference('A3')} (see \`agenda ls\`)`,
    );
  }
  return parsed.data;
}

/** The ordinal inside an agenda id, for ordering items the daemon returned. */
export function agendaOrdinal(id: AgendaId): number {
  return Number(id.slice(1));
}
