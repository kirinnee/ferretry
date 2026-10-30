import { type AgendaId, AgendaIdSchema } from '@ferretry/protocol';

/** Sigils an agenda reference may be written with; a bare `A3` is accepted too. */
const SIGILS = /^[?!]/u;

/** How an agenda item is cited in prose and in the listing. */
export function agendaReference(id: AgendaId): string {
  return `!${id}`;
}

/**
 * Read what a human typed as an agenda id.
 *
 * `!A3`, `?A3` and `A3` all name the same item — both sigils are in circulation, and rejecting one of
 * them would only punish whoever copied the wrong style out of a chat log.
 */
export function parseAgendaReference(value: string): AgendaId {
  const candidate = value.trim().replace(SIGILS, '');
  const parsed = AgendaIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`"${value.trim()}" is not an agenda reference — they look like !A3 (see \`agenda ls\`)`);
  }
  return parsed.data;
}

/** The ordinal inside an agenda id, for ordering items the daemon returned. */
export function agendaOrdinal(id: AgendaId): number {
  return Number(id.slice(1));
}
