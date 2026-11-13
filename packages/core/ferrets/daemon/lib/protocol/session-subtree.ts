/**
 * A LEAD'S ONE-TABLE VIEW OF ITS SUB-FERRETS — `GET /v1/sessions/:sessionId/subtree` and `fy status --subtree`
 * (docs/pack-mode.md § Checking on your sub-ferrets).
 *
 * Each live descendant of a session is one row: who, on what model, in what state, on which card and PR, and the
 * one line it last said (its card's newest note or its newest message to the asking lead). The daemon builds the
 * rows from what it already holds — the sessions registry, the board's cards and PR cache, each ferret's outbox —
 * so a lead reads state it did not have to carry in its context.
 *
 * This file also owns the SUBTREE WALK over session records, shared by `fy stop` and the route: lineage is read
 * from the registry's `parent` links, never from a request.
 */
import { z } from 'zod';
import { PrChecksSchema, PrStateSchema } from './board.ts';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';
import type { SessionConfig, SessionState, SessionView } from './session.ts';
import { SessionStatusSchema } from './session-base.ts';

/** The longest a row's last line may be, in characters (code points, so an emoji is one), ellipsis included. */
export const SUBTREE_LAST_LINE_MAX = 100;

/** How many characters a row's last line has — the one rule the daemon cuts by and the schema checks by. */
export const lastLineLength = (text: string): number => [...text].length;

/** The four settled terminal states have no live work left; `kill_failed` is not one — it is still to be dealt with. */
export const SESSION_ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/** How a row's session is doing, in a lead's words. */
const SubtreeStateSchema = z.enum(['running', 'waiting', 'needs-you', 'ended']);

/** Where a row's last line came from: a note on its card, or a message it sent to the asking lead. */
const SubtreeLastSourceSchema = z.enum(['note', 'message']);

export const SubtreeRowSchema = z.strictObject({
  id: z.string().min(1),
  /** The ferret's callsign; its task name when it has none. */
  callsign: z.string().min(1),
  parent: z.string().min(1).optional(),
  /** 1 for a child of the asked session, 2 for a grandchild, and so on. */
  depth: PositiveIntegerSchema,
  model: z.string().min(1),
  state: SubtreeStateSchema,
  /** The session's own status, for a reader who needs more than the four-way state. */
  status: SessionStatusSchema,
  /** The card it works on (`&F767`) and that card's lane; absent for a ferret with no card. */
  card: z.strictObject({ ref: z.string().min(1), lane: z.string().min(1).optional() }).optional(),
  /** The card's PR — the open one when there are several, else the newest — as the board's PR cache last read it. */
  pr: z
    .strictObject({
      number: PositiveIntegerSchema,
      url: z.string().min(1),
      state: PrStateSchema,
      draft: z.boolean(),
      checks: PrChecksSchema,
    })
    .optional(),
  /** The newest of the card's last note and the last message it sent to the asking lead, cut to one line. */
  last: z
    .strictObject({
      at: InstantSchema,
      source: SubtreeLastSourceSchema,
      text: z
        .string()
        .min(1)
        .refine(text => lastLineLength(text) <= SUBTREE_LAST_LINE_MAX, {
          message: `at most ${SUBTREE_LAST_LINE_MAX} characters`,
        }),
    })
    .optional(),
  /** When it ended; present exactly on an `ended` row. */
  endedAt: InstantSchema.optional(),
});

// ── The walk ─────────────────────────────────────────────────────────────────────────────────────

/** The session's parent, trimmed; a blank one is none. */
export function parentOf(view: SessionView): string | undefined {
  const parent = view.config.parent?.trim();
  return parent ? parent : undefined;
}

/** Sessions keyed by their trimmed id; the first record of a repeated id wins. */
export function sessionsById(sessions: readonly SessionView[]): Map<string, SessionView> {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) {
    const id = view.config.id.trim();
    if (id && !byId.has(id)) byId.set(id, view);
  }
  return byId;
}

/**
 * Breadth-first subtree walk: every session at or under `rootId`, with how deep it sits (the root is 0). The
 * visited set makes a malformed parent cycle terminate.
 */
export function subtreeDepths(byId: ReadonlyMap<string, SessionView>, rootId: string): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const view of byId.values()) {
    const parent = parentOf(view);
    const childId = view.config.id.trim();
    if (!parent || !childId) continue;
    const existing = children.get(parent);
    if (existing) existing.push(childId);
    else children.set(parent, [childId]);
  }

  const depth = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    if (depth.has(next.id)) continue;
    depth.set(next.id, next.depth);
    for (const child of children.get(next.id) ?? []) {
      if (!depth.has(child)) queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return depth;
}

/**
 * The model a session is actually running, for display.
 *
 * Precedence: what the harness reported > the configured model > the wrapper's declared hint.
 */
export function displayModel(
  config: Pick<SessionConfig, 'model' | 'modelHint'>,
  state: Pick<SessionState, 'observedModel'>,
): string {
  return state.observedModel?.trim() || config.model?.trim() || config.modelHint.trim() || 'default';
}
