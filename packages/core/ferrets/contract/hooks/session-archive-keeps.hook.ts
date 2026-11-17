import { type FerretId, defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema } from '../ids.ts';

// ─── what keeps a finished ferret live (the session archive, docs/session-archive.md) ──────────────────────────────

/**
 * One card as the archive's keep rule reads it (Board's answer): who owns and holds it, whether it was dropped, and
 * the category of its lane as Board resolved it. A category Ferrets does not know, or none, reads as "in flight".
 * `owner` and `assignee` are FERRET IDS, never callsigns: the rule matches them against the ids it is deciding about,
 * so a callsign would keep nobody.
 */
export interface ArchiveTaskStanding {
  /** The ferret id that owns the card (never a callsign). */
  readonly owner: FerretId;
  /** The ferret id the card is assigned to (never a callsign), or `null` for nobody. */
  readonly assignee: FerretId | null;
  readonly dropped: boolean;
  readonly category: string | undefined;
}

/**
 * Board's whole answer exactly as {@link ArchiveCardStanding} types it, which Ferrets parses at its boundary: anything
 * else (an owner that is not a ferret id, a `dropped` that is not a boolean, an extra key) is unreadable, never a guess,
 * and one bad standing makes the whole answer unreadable. Board parses its own answer with it too, so the two cannot drift.
 */
export const ArchiveCardStandingsSchema = z.array(
  z.strictObject({
    owner: FerretIdSchema,
    assignee: FerretIdSchema.nullable(),
    dropped: z.boolean(),
    category: z.string().optional(),
  }),
);

/**
 * A fact another plugin owns that keeps a finished ferret in the live set. Ferrets imports no plugin, so each owner
 * contributes its half: Board says which ferrets own or hold a card still in flight, Agenda says whether a ferret's own
 * board holds an item still open. A source that throws, or that nobody contributes, keeps every ferret live.
 */
export type ArchiveKeepSource =
  | { readonly kind: 'board'; cards(): Promise<readonly ArchiveTaskStanding[]> }
  | { readonly kind: 'agenda'; hasOpenItem(ferret: FerretId): Promise<boolean> };

/** Whether a contributed item is a keep source at all: a known kind with its answering function. */
const isArchiveKeepSource = (value: unknown): value is ArchiveKeepSource => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { readonly kind?: unknown; readonly cards?: unknown; readonly hasOpenItem?: unknown };
  if (item.kind === 'board') return typeof item.cards === 'function';
  if (item.kind === 'agenda') return typeof item.hasOpenItem === 'function';
  return false;
};

/**
 * Board and Agenda add what keeps a ferret live. FAIL SAFE: the archive runs only while BOTH kinds are contributed
 * (an absent answer is "keep live"), and a source that fails keeps every ferret it was asked about. An item that is
 * not a keep source is left out by the kernel, which reads as that kind not answering; and every ANSWER a source gives
 * is parsed by Ferrets (`daemon/modules/archive.ts`), so an answer of the wrong shape keeps every ferret too.
 */
export const ArchiveKeeps = defineHook('session.archive-keeps', {
  mode: 'contribute',
  item: z.custom<ArchiveKeepSource>(
    isArchiveKeepSource,
    'a keep source is a board that lists its tasks or an agenda with hasOpenItem()',
  ),
});
