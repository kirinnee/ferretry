/**
 * HOW A CARD IS NAMED: the card id, the reference to one, and the result type the board's pure helpers return.
 * Copied from today's `protocol/src/lib/board-refs.ts` with the words renamed (task -> card, session -> ferret) and the
 * retired `#` sigil dropped (clean slate). A leaf: it depends on zod alone.
 *
 * The id keeps the shape the owner already cites (`F412`: a kind prefix and a number); the number comes from ONE counter
 * per machine, so an id is unique on its daemon.
 */
import { z } from 'zod';

/** Two rails and nothing else: a value, or the reason there is none. Board helpers never throw. */
export type BoardResult<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const boardOk = <T>(value: T): BoardResult<T, never> => ({ ok: true, value });
export const boardErr = <E>(error: E): BoardResult<never, E> => ({ ok: false, error });

/** `B12`, `F412`, `I3`, `C9`: the kind's letter and a number. Shown as `&F412`. */
export const CARD_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const CardIdSchema = z.string().regex(CARD_ID_PATTERN);
export type CardId = z.infer<typeof CardIdSchema>;

export const MAX_MACHINE_ID_LENGTH = 128;
/** The daemon a card lives on. Opaque to the board; the app's merged view keys on it. */
export const MachineIdSchema = z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH);

/** A ferret's id as the board stores it: plain text; Ferrets owns what a good one looks like. */
export const FerretRefSchema = z.string().min(1);

/** A board's identity: a registered project's id, or the one machine-wide board for work with no project. */
export const UNFILED_PROJECT_ID = 'unfiled';
export const BoardProjectIdSchema = z.union([z.uuid(), z.literal(UNFILED_PROJECT_ID)]);
export type BoardProjectId = z.infer<typeof BoardProjectIdSchema>;

/** A card, named. Without `machineId` it means "on this machine". */
export const CardRefSchema = z.strictObject({
  machineId: MachineIdSchema.optional(),
  id: CardIdSchema,
});
export type CardRef = z.infer<typeof CardRefSchema>;

/** The sigil of the `&card` reference kind (`docs/reference-standard.md`). */
export const CARD_REF_SIGIL = '&';

/** How a card is written everywhere: `&F412`. The machine is not part of it. */
export const formatCardRef = (ref: CardRef): string => `${CARD_REF_SIGIL}${ref.id}`;

export type CardRefParseError = { readonly code: 'empty' } | { readonly code: 'malformed'; readonly input: string };

/** Reads a card reference a person or ferret typed: `&F412` or a bare `F412`, in any case. Anything else is `malformed`. */
export const parseCardRef = (input: string): BoardResult<CardRef, CardRefParseError> => {
  const trimmed = input.trim();
  if (trimmed === '') return boardErr({ code: 'empty' });
  const bare = trimmed.startsWith(CARD_REF_SIGIL) ? trimmed.slice(1) : trimmed;
  const id = bare.toUpperCase();
  return CARD_ID_PATTERN.test(id) ? boardOk({ id }) : boardErr({ code: 'malformed', input });
};

const CARD_REF_IN_TEXT = /(?<![\w&])&([BFIC][1-9][0-9]{0,8})(?!\w)/u;

/** The first `&F412`-style card reference in free text (a brief), or `undefined` when it names none. */
export const firstCardRefIn = (text: string): CardRef | undefined => {
  const found = CARD_REF_IN_TEXT.exec(text)?.[1];
  return found === undefined ? undefined : { id: found };
};

/** The longest reason a card-less turn is recorded with: the same bound as a card's own reasons. */
export const MAX_BOARD_SKIP_REASON_LENGTH = 2 * 1024;

/**
 * A ferret's decision that its work needs no card (`fy card skip "<why>"`). While it stands the turn-end check stays
 * quiet; taking a card clears it, so a later ask is checked afresh.
 */
export const BoardSkipSchema = z.strictObject({
  reason: z.string().trim().min(1).max(MAX_BOARD_SKIP_REASON_LENGTH),
  at: z.iso.datetime({ offset: true }),
});
export type BoardSkip = z.infer<typeof BoardSkipSchema>;

/**
 * How an `owner` actor acted, when it was not the owner's own app: `admin-token` is the host's admin token with no
 * ferret's own credential behind it. The daemon cannot tell the owner at the machine from a ferret that called `fy`
 * without its credential, so it says which one it KNOWS — the token — and a surface never shows it as the owner.
 *
 * IT IS A SIBLING FIELD ON PURPOSE — `actorVia` on an event, `createdByVia` on a card, `byVia` on a clarification,
 * `confirmedVia` on a lane set — never a member of the actor union.
 */
export const CardActorViaSchema = z.literal('admin-token');
export type CardActorVia = z.infer<typeof CardActorViaSchema>;

/** What an `admin-token` actor may be: the truth, which is that it could be either. */
export const ADMIN_TOKEN_ACTOR_NOTE = 'the owner at this machine, or a ferret without its own credential';

/** What every surface says for an `admin-token` actor in a sentence: the token, and what it may be. */
export const ADMIN_TOKEN_ACTOR_WORDS = `the admin token (${ADMIN_TOKEN_ACTOR_NOTE})`;

/** Files one move back may carry to the card's ferret (the owner's "Not good" composer). */
export const MAX_BOARD_REOPEN_ATTACHMENTS = 10;

/** A stored attachment's id: the content address the attachment store gives every file it keeps. */
export const BoardAttachmentIdSchema = z.string().regex(/^att_[0-9a-f]{64}$/u);

/**
 * The files the "Not good" composer carries to the card's ferret, in a board move back (`move`, `reopen`) and in an
 * answer to a card's ask. They are uploaded first, through the ordinary attachment route, to `from`; the daemon carries
 * them on to the ferret that is told.
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
