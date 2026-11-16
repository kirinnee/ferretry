import { z } from 'zod';

/**
 * The card references an ask carries (today's `protocol/src/lib/board-refs.ts`, the part Asks reads). A private copy:
 * Asks is core and may not import the Board plugin's contract, and an ask only names a card, never reads one.
 */

/** A board task id (`F12`). */
const BOARD_TASK_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const BoardTaskIdSchema = z.string().regex(BOARD_TASK_ID_PATTERN);

const MAX_MACHINE_ID_LENGTH = 128;
/** The daemon a card lives on. Opaque to the board; the app's merged view keys on it. */
const MachineIdSchema = z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH);

/** A card, named. Without `machineId` it means "on this machine". */
export const TaskRefSchema = z.strictObject({
  machineId: MachineIdSchema.optional(),
  id: BoardTaskIdSchema,
});
export type TaskRef = z.infer<typeof TaskRefSchema>;

/** The sigil of the `&task` reference kind (`docs/reference-standard.md`). */
const TASK_REF_SIGIL = '&';

/** How a card is written everywhere: `&F412`. The machine is not part of it. */
export const formatTaskRef = (ref: TaskRef): string => `${TASK_REF_SIGIL}${ref.id}`;

/** Files one answer to a card's ask may carry to the card's ferret (the owner's "Not good" composer). */
const MAX_BOARD_REOPEN_ATTACHMENTS = 10;

/** A stored attachment's id: the content address the attachment store gives every file it keeps. */
const BoardAttachmentIdSchema = z.string().regex(/^att_[0-9a-f]{64}$/u);

/**
 * The files the "Not good" composer carries to the card's ferret in an answer to a card's ask. They are uploaded first,
 * through the ordinary attachment route, to `from`; a card-ask answer takes them only from the agenda's own session.
 */
export const BoardReopenAttachmentsSchema = z.strictObject({
  from: z.string().min(1),
  ids: z
    .array(BoardAttachmentIdSchema)
    .min(1)
    .max(MAX_BOARD_REOPEN_ATTACHMENTS)
    .refine(ids => new Set(ids).size === ids.length, 'an attachment is named once'),
});
export type BoardReopenAttachments = z.infer<typeof BoardReopenAttachmentsSchema>;

/**
 * Reads a card reference a person or ferret typed: `&F412` or a bare `F412`, in any case. The CLI's `--task`,
 * `--related` and `--move-cards` read through it. `ok: false` is anything that is not exactly one id.
 */
export const parseTaskRef = (
  input: string,
): { readonly ok: true; readonly value: TaskRef } | { readonly ok: false } => {
  const trimmed = input.trim();
  const bare = trimmed.startsWith(TASK_REF_SIGIL) ? trimmed.slice(1) : trimmed;
  const id = bare.toUpperCase();
  return BOARD_TASK_ID_PATTERN.test(id) ? { ok: true, value: { id } } : { ok: false };
};
