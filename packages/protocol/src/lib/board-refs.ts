/**
 * HOW A CARD IS NAMED: the board's task id, the reference to one, and the result type its helpers return.
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

/** Two rails and nothing else: a value, or the reason there is none. Board helpers never throw. */
export type BoardResult<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const boardOk = <T>(value: T): BoardResult<T, never> => ({ ok: true, value });
export const boardErr = <E>(error: E): BoardResult<never, E> => ({ ok: false, error });

/**
 * A board task id. The same shape as the v1 per-session id (`TaskIdSchema` in `tasks.ts`), stated again
 * only because this leaf may not import that module; `board-refs.test.ts` pins the two together, and
 * U18 deletes the v1 copy.
 */
export const BOARD_TASK_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const BoardTaskIdSchema = z.string().regex(BOARD_TASK_ID_PATTERN);
export type BoardTaskId = z.infer<typeof BoardTaskIdSchema>;

export const MAX_MACHINE_ID_LENGTH = 128;
/** The daemon a card lives on. Opaque to the board; the app's merged view keys on it. */
export const MachineIdSchema = z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH);

/**
 * A board's identity: a registered project's id, or the one machine-wide board for work with no project.
 * Here rather than beside the lanes because a session's config names its project, and `session.ts` may
 * import only this leaf.
 */
export const UNFILED_PROJECT_ID = 'unfiled';
export const BoardProjectIdSchema = z.union([z.uuid(), z.literal(UNFILED_PROJECT_ID)]);
export type BoardProjectId = z.infer<typeof BoardProjectIdSchema>;

/** A card, named. Without `machineId` it means "on this machine". */
export const TaskRefSchema = z.strictObject({
  machineId: MachineIdSchema.optional(),
  id: BoardTaskIdSchema,
});
export type TaskRef = z.infer<typeof TaskRefSchema>;

/** The sigil of the `&task` reference kind (`docs/reference-standard.md`). */
export const TASK_REF_SIGIL = '&';
/** The retired sigil: still accepted as input for one release, never printed. */
export const LEGACY_TASK_REF_SIGIL = '#';

/** How a card is written everywhere: `&F412`. The machine is not part of it (see the file header). */
export const formatTaskRef = (ref: TaskRef): string => `${TASK_REF_SIGIL}${ref.id}`;

export type TaskRefParseError = { readonly code: 'empty' } | { readonly code: 'malformed'; readonly input: string };

/**
 * Reads a card reference a person or ferret typed: `&F412`, the retired `#F412`, or a bare `F412`, in
 * any case. Surrounding space is ignored; anything else that is not exactly one id is `malformed`.
 */
export const parseTaskRef = (input: string): BoardResult<TaskRef, TaskRefParseError> => {
  const trimmed = input.trim();
  if (trimmed === '') return boardErr({ code: 'empty' });
  const bare =
    trimmed.startsWith(TASK_REF_SIGIL) || trimmed.startsWith(LEGACY_TASK_REF_SIGIL) ? trimmed.slice(1) : trimmed;
  const id = bare.toUpperCase();
  return BOARD_TASK_ID_PATTERN.test(id) ? boardOk({ id }) : boardErr({ code: 'malformed', input });
};

const CARD_REF_IN_TEXT = /(?<![\w&])&([BFIC][1-9][0-9]{0,8})(?!\w)/u;

/** The first `&F412`-style card reference in free text (a brief), or `undefined` when it names none. */
export const firstTaskRefIn = (text: string): TaskRef | undefined => {
  const found = CARD_REF_IN_TEXT.exec(text)?.[1];
  return found === undefined ? undefined : { id: found };
};

/** The longest reason a card-less turn is recorded with: the same bound as a card's own reasons. */
export const MAX_BOARD_SKIP_REASON_LENGTH = 2 * 1024;

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
export type BoardSkip = z.infer<typeof BoardSkipSchema>;

/**
 * How an `owner` actor acted, when it was not the owner's own app: `admin-token` is the host's admin token with
 * no ferret's own credential behind it. The daemon cannot tell the owner at the machine from a ferret that called
 * `fy` without its session, so it says which one it KNOWS — the token ({@link ADMIN_TOKEN_ACTOR_WORDS}) — and a
 * surface never shows it as the owner. Only a paired device's act is plainly `owner`.
 *
 * IT IS A SIBLING FIELD ON PURPOSE — `actorVia` on an event, `createdByVia` on a card, `byVia` on a clarification,
 * `confirmedVia` on a lane set — never a member of the board actor union: those parents are plain objects, so an older app, CLI or a downgraded
 * daemon drops the field it does not know and reads the act as the owner's, as it always did, instead of
 * refusing the board.
 */
export const BoardActorViaSchema = z.literal('admin-token');
export type BoardActorVia = z.infer<typeof BoardActorViaSchema>;

/** What an `admin-token` board actor may be: the truth, which is that it could be either. */
export const ADMIN_TOKEN_ACTOR_NOTE = 'the owner at this machine, or a ferret without its own credential';

/** What every surface says for an `admin-token` board actor in a sentence: the token, and what it may be. */
export const ADMIN_TOKEN_ACTOR_WORDS = `the admin token (${ADMIN_TOKEN_ACTOR_NOTE})`;
