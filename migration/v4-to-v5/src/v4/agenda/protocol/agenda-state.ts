// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/protocol/src/lib/agenda-state.ts, verbatim.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
/**
 * WHERE AN AGENDA ITEM STANDS, AND WHAT IT IS RIGHT NOW (docs/agenda.md § States).
 *
 * An item's STATE is who it waits on, as the owner sees it:
 *
 * - `needs-you`: it waits on the owner. It notifies, and it is in the Needs-you queue (`needsYouQueue`).
 * - `resting`: it waits on work, and it is quiet. `waiting-on-ferret`: the owner replied or answered, and it is
 *   the ferret's turn; the Warden nudges a ferret that stays silent (`AGENDA_REST_NUDGE_MS`). `working`: the
 *   ferret took it on (`fy agenda rest --why`) and asks nothing yet; nobody nudges it.
 * - `snoozed`: the owner put it away until a time.
 * - `done`: closed — by the ferret, or by the owner's explicit done or dismiss. An answer never closes an item.
 *
 * The state is DERIVED, never stored: {@link agendaState} reads it from the fields an item already carries, so
 * every item a daemon ever wrote has one. `parked` stays the field an older app reads (`replied` for every
 * Resting item, `snoozed` for a snooze) and `waitingOn` stays the request for more information; `resting` adds
 * only what they cannot say — the sub-state, what the ferret is doing, and the nudge clock.
 *
 * An item's STAGE is what it needs from the owner right now, as it evolves (`explainer` → `question` → `plan` →
 * `tracker` → `test` → `done`), with every earlier stage kept in `stages`. It is separate from the state: a
 * question can rest, a tracker can need the owner.
 */
import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';

export const AgendaStateSchema = z.enum(['needs-you', 'resting', 'snoozed', 'done']);
export type AgendaState = z.infer<typeof AgendaStateSchema>;

export const AgendaRestSubStateSchema = z.enum(['waiting-on-ferret', 'working']);
export type AgendaRestSubState = z.infer<typeof AgendaRestSubStateSchema>;

/** The longest line a ferret says it is working on (`fy agenda rest --why`). */
export const MAX_AGENDA_REST_WHY_LENGTH = 1_024;

/** How long a `waiting-on-ferret` item may sit silent before the Warden nudges its ferret, the first time. */
export const AGENDA_REST_NUDGE_MS = 30 * 60_000;

/**
 * WHAT A RESTING ITEM WAITS ON, beside the `parked: replied` (or `waitingOn: ferret`) an older app reads. `at` is
 * when it began resting, which is the nudge clock; `nudgedAt` and `nudges` are the Warden's own record of the
 * nudges it sent. `migrated` marks an item that was `parked: replied` before Resting existed: it is nudged once
 * after the upgrade and never again. `nudgeSend` is the send id of a nudge the Warden has decided on and not yet
 * recorded as sent, kept so a restart resumes that very message instead of sending another. An object, not a strict
 * one, so a later field reads in this app too.
 */
export const AgendaRestingSchema = z.object({
  sub: AgendaRestSubStateSchema,
  at: InstantSchema,
  why: z.string().trim().min(1).max(MAX_AGENDA_REST_WHY_LENGTH).optional(),
  nudgedAt: InstantSchema.optional(),
  nudges: PositiveIntegerSchema.optional(),
  nudgeSend: z.string().min(1).max(256).optional(),
  migrated: z.literal(true).optional(),
});
export type AgendaResting = z.infer<typeof AgendaRestingSchema>;

/** What an item needs from the owner right now, as it evolves; `done` once it is closed. */
export const AgendaStageSchema = z.enum(['explainer', 'question', 'plan', 'tracker', 'test', 'done']);
export type AgendaStage = z.infer<typeof AgendaStageSchema>;

/** The most stage changes an item keeps, oldest dropped: an item moves through six stages, so this is generous. */
export const MAX_AGENDA_STAGES = 64;

/** One stage an item entered, and when. */
export const AgendaStageEntrySchema = z.object({ stage: AgendaStageSchema, at: InstantSchema });
export type AgendaStageEntry = z.infer<typeof AgendaStageEntrySchema>;

const EPOCH = '1970-01-01T00:00:00.000Z';

/** What the state is read from: the fields every item has carried since it could park or wait on its ferret. */
export interface AgendaStateSource {
  readonly resolvedAt?: string | undefined;
  readonly notice?: true | undefined;
  readonly parked?: { readonly reason: string; readonly at: string; readonly until?: string } | undefined;
  readonly waitingOn?: 'ferret' | undefined;
  readonly askedAt?: string | undefined;
  readonly resting?: Pick<AgendaResting, 'sub' | 'at'> | undefined;
}

/** An item's state, with what each one needs to be drawn: the sub-state and since when it rests. */
export type AgendaStateView =
  | { readonly state: 'needs-you' }
  | { readonly state: 'resting'; readonly sub: AgendaRestSubState; readonly since: string }
  | { readonly state: 'snoozed' }
  | { readonly state: 'done' };

/**
 * THE ONE STATE FUNCTION: pure and total, so an item from any daemon reads as exactly one state.
 *
 * - Closed, or a notice (it is read, not answered, and never waits on anyone): `done`.
 * - Snoozed: `snoozed`, whatever else it waits on.
 * - Parked as replied (every Resting item mirrors it), or waiting on the ferret for more information: `resting`,
 *   with the sub-state its `resting` names (`waiting-on-ferret` when it names none, which is how an item parked
 *   before Resting existed reads), since its `resting.at`, else the park, else the request.
 * - Anything else: `needs-you`.
 */
export const agendaState = (item: AgendaStateSource): AgendaStateView => {
  if (item.resolvedAt !== undefined || item.notice === true) return { state: 'done' };
  if (item.parked?.reason === 'snoozed') return { state: 'snoozed' };
  const parkedAsReply = item.parked?.reason === 'replied';
  if (!parkedAsReply && item.waitingOn !== 'ferret') return { state: 'needs-you' };
  // `waitingOn` and `askedAt` are set together (the item schema says so); the epoch only keeps the type total.
  const since = item.resting?.at ?? (parkedAsReply ? item.parked?.at : item.askedAt) ?? EPOCH;
  return { state: 'resting', sub: item.resting?.sub ?? 'waiting-on-ferret', since };
};
