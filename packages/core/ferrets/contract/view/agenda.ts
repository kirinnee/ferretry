import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';

/**
 * The agenda wire pieces a session row carries, cut from today's `protocol/src/lib/agenda.ts` (Agenda's). Ferrets is
 * core and cannot import the Agenda plugin's contract (§2.1 core-closed), so the session row keeps a copy of exactly
 * the schemas it embeds.
 */

/** @pending ferrets: Info tabs Agenda, Tasks, Context, Surfaces and Warden are not ported */
export const MAX_AGENDA_SUBJECT_LENGTH = 240;

const singleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\r\n]*$/u, 'must be a single line');

export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);

/**
 * A session's open Attention, as its list row carries it: what makes a conversation read as UNREAD
 * until the owner has dealt with it. The daemon rewrites it after every board change that moves the
 * open set, and removes it when nothing is open — so its absence means "nothing waits on the owner",
 * never "unknown". The board itself (`GET /v1/sessions/:id/agenda`) has every item in full.
 */
export const SessionAgendaSummarySchema = z.object({
  /** How many items are open. */
  open: PositiveIntegerSchema,
  /** The oldest open item — the one a row opens to. */
  first: AgendaIdSchema,
  /** That item's one-line ask, for a row's preview. */
  ask: singleLine(MAX_AGENDA_SUBJECT_LENGTH),
  /** When the NEWEST open item was raised: "newest needing you first" sorts by it. */
  latestAt: InstantSchema,
  /**
   * How many of the `open` items are in discussion (`waitingFor: 'discussion'`): still being talked through
   * in the ferret's chat, not on the owner's queue, so they are not counted as needing the owner. Absent
   * when none is.
   */
  discussing: PositiveIntegerSchema.optional(),
  /** The ferret works in AGENDA MODE (a switchable instruction section, off by default): the chat draws its agenda. */
  agendaMode: z.literal(true).optional(),
  /** The ferret is STOPPED on the owner: idle, with at least one item on the owner's turn. */
  stopped: z.literal(true).optional(),
});
/** @pending ferrets: Info tabs Agenda, Tasks, Context, Surfaces and Warden are not ported */
export type SessionAgendaSummary = z.infer<typeof SessionAgendaSummarySchema>;
