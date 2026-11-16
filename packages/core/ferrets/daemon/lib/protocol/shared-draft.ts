/**
 * THE SHARED DRAFT — one person's unsent composer, live on every one of their devices.
 *
 * The owner composes a message on a phone, picks it up on a laptop, and both screens show the same
 * words and the same attached files while either is typed into. The daemon is the ONE sequencer:
 * every edit names the revision it was made against, the daemon transforms it past whatever landed
 * since, applies it, and hands the result to everybody. That is operational transformation in its
 * plainest, central-server form ("Jupiter", the model ot.js ships), and it is all two or three devices
 * typing into one field need — no CRDT, no tombstones, no second sync protocol to secure.
 *
 * NOT THE AGENT'S COMPOSER. `ComposerDraft*` and `composer_occupied` (session.ts) are the text sitting
 * typed in the AGENT's own terminal input. This is the person's draft in the app, which no agent ever
 * sees until it is sent, so it is named apart: `SharedDraft`.
 *
 * POSITIONS ARE UTF-16 CODE UNITS — exactly what a JavaScript string index and a textarea's
 * `selectionStart` count — so a browser can turn a keystroke into an operation with no conversion.
 *
 * ONE DRAFT PER SLOT. A session has a CHAT draft — the box under its conversation — and one draft for each
 * Inbox item the owner is replying to (`SharedDraftSlot`). They are separate drafts that never read each
 * other's words: typing a reply under `!A5` in the Inbox must not show up in the ferret's chat box, and the
 * chat box must not leak into the card. A draft is addressed by (machine, session, slot); the slot is
 * `chat` when it is not named, which is what every draft on disk and every client before slots meant.
 *
 * Everything here is pure: the daemon uses it to sequence, and the app uses the same functions to
 * keep its own pending edits in step, so the two ends cannot disagree about what an edit means.
 */
import { z } from 'zod';
import { AgendaIdSchema } from './agenda.ts';
import { NonNegativeIntegerSchema } from './common.ts';

/** The same bound the browser's own draft store has always had (`pwa/src/lib/drafts.ts`). */
const SHARED_DRAFT_MAX_CHARS = 16_000;
/** Files and locations one draft may hold. */
const SHARED_DRAFT_MAX_ITEMS = 20;
/** Components one text operation may carry: far more than any real keystroke batch needs. */
const SHARED_DRAFT_MAX_OP_COMPONENTS = 1_024;

/** Ids and labels an item carries are shown to a person, so they are bounded like any other label. */
const SHARED_DRAFT_ID_MAX = 128;

const SHARED_DRAFT_GENERATION_MAX = 64;

// ── Slots: which of a session's drafts ───────────────────────────────────────────────────────────

// ── Text operations ──────────────────────────────────────────────────────────────────────────────

const TextOpComponentSchema = z.union([
  z
    .number()
    .int()
    .refine(value => value !== 0, 'a retain or delete counts at least one character'),
  z.string().min(1).max(SHARED_DRAFT_MAX_CHARS),
]);

/**
 * Every insert together is held to the size of a whole draft, so one request cannot make the daemon
 * build a string many times longer than any draft before the length check refuses it.
 */
const TextOpSchema = z
  .array(TextOpComponentSchema)
  .max(SHARED_DRAFT_MAX_OP_COMPONENTS)
  .readonly()
  .refine(
    op =>
      op.reduce<number>((total, component) => total + (typeof component === 'string' ? component.length : 0), 0) <=
      SHARED_DRAFT_MAX_CHARS,
    `an edit inserts at most ${SHARED_DRAFT_MAX_CHARS} characters`,
  );

// ── Items: the files and locations riding with the draft ─────────────────────────────────────────

const SharedDraftIdSchema = z.string().min(1).max(SHARED_DRAFT_ID_MAX);

// ── The draft and an edit to it ──────────────────────────────────────────────────────────────────

/**
 * Which life of the daemon's in-memory draft revisions belong to. A fresh one is minted every time a
 * draft is loaded into memory, so after a restart — which may have lost the last second of edits — a
 * device still holding a revision number from before is refused rather than merged: the same number
 * may now name different text.
 */
const SharedDraftGenerationSchema = z.string().min(1).max(SHARED_DRAFT_GENERATION_MAX);

/**
 * What a send takes out of the shared draft, carried WITH the send: the position the composer saw when
 * the person pressed send, and the edit that removes exactly what was sent from there. The daemon applies
 * it once the send is accepted — transformed past anything typed since, so later words stay — and keys it
 * to the send's request id, so a retried send, or the composer's own clear, never applies it twice. It
 * travels with the send because the send can land with no composer left to clear anything: the page
 * closed, the outbox sent it later, or the person moved to another session meanwhile.
 */
export const SharedDraftSentSchema = z.strictObject({
  /**
   * The draft the send takes its words out of: left out for the chat draft, the item's id for a reply sent
   * from under an Inbox item. A send names its own slot so it can never empty another box's words.
   */
  slot: AgendaIdSchema.optional(),
  generation: SharedDraftGenerationSchema,
  epoch: NonNegativeIntegerSchema,
  base: NonNegativeIntegerSchema,
  text: TextOpSchema,
  remove: z.array(SharedDraftIdSchema).max(SHARED_DRAFT_MAX_ITEMS).readonly().optional(),
});

// ── The live stream: every open composer for one session, kept in step ───────────────────────────
