import { type AttentionId, AttentionIdSchema } from '@ferretry/protocol';

/** Sigils an attention reference may be written with; a bare `A3` is accepted too. */
const SIGILS = /^[?!]/u;

/** How an attention item is cited in prose and in the listing. */
export function attentionReference(id: AttentionId): string {
  return `!${id}`;
}

/**
 * Read what a human typed as an attention id.
 *
 * `!A3`, `?A3` and `A3` all name the same item — both sigils are in circulation, and rejecting one of
 * them would only punish whoever copied the wrong style out of a chat log.
 */
export function parseAttentionReference(value: string): AttentionId {
  const candidate = value.trim().replace(SIGILS, '');
  const parsed = AttentionIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`"${value.trim()}" is not an attention reference — they look like !A3 (see \`attention ls\`)`);
  }
  return parsed.data;
}

/** The ordinal inside an attention id, for ordering items the daemon returned. */
export function attentionOrdinal(id: AttentionId): number {
  return Number(id.slice(1));
}
