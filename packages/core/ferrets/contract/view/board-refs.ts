/**
 * HOW A CARD IS NAMED: the board's task id and the reference to one.
 *
 * A LEAF ON PURPOSE. `attention.ts` links an agenda item to the card it belongs to, and `session.ts`
 * imports `attention.ts` while `tasks.ts` imports `session.ts`. So anything the agenda imports must
 * import neither, or the modules load in a cycle and a schema is read before it exists. This file
 * depends on zod alone.
 *
 * The id keeps the shape the owner already cites (`F412`: a kind prefix and a number), but the number
 * comes from ONE counter per machine instead of one per session, so an id is unique on its daemon.
 * The machine is never part of how a ferret writes it: `machineId` is there for the app's merged view,
 * and a cross-machine written form (`&F412@mac`) is a declared GAP of `docs/reference-standard.md`.
 */
import { z } from 'zod';

/**
 * A board task id. The same shape as the v1 per-session id (`TaskIdSchema` in `tasks.ts`), stated again
 * only because this leaf may not import that module; `board-refs.test.ts` pins the two together, and
 * U18 deletes the v1 copy.
 */
const BOARD_TASK_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const BoardTaskIdSchema = z.string().regex(BOARD_TASK_ID_PATTERN);

const MAX_MACHINE_ID_LENGTH = 128;
/**
 * The daemon a card lives on. Opaque to the board; the app's merged view keys on it.
 */
const MachineIdSchema = z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH);

/**
 * A board's identity: a registered project's id, or the one machine-wide board for work with no project.
 * Here rather than beside the lanes because a session's config names its project, and `session.ts` may
 * import only this leaf.
 */
const UNFILED_PROJECT_ID = 'unfiled';
export const BoardProjectIdSchema = z.union([z.uuid(), z.literal(UNFILED_PROJECT_ID)]);
export type BoardProjectId = z.infer<typeof BoardProjectIdSchema>;

/** A card, named. Without `machineId` it means "on this machine". */
export const TaskRefSchema = z.strictObject({
  machineId: MachineIdSchema.optional(),
  id: BoardTaskIdSchema,
});

/**
 * The longest reason a card-less turn is recorded with: the same bound as a card's own reasons.
 */
const MAX_BOARD_SKIP_REASON_LENGTH = 2 * 1024;

/**
 * A session's decision that its work needs no card (`fy task skip "<why>"`, `board-design.md` §3.4): chit-chat,
 * or the owner said not to track it. Kept as `config.boardSkip`, because the session owns the decision. While
 * it stands the turn-end check stays quiet; taking a card (a new `config.focusTask`) clears it, so a later ask
 * is checked afresh. Here rather than in `board.ts` because `session.ts` reads it (see the file header).
 */
export const BoardSkipSchema = z.strictObject({
  reason: z.string().trim().min(1).max(MAX_BOARD_SKIP_REASON_LENGTH),
  at: z.iso.datetime({ offset: true }),
});
