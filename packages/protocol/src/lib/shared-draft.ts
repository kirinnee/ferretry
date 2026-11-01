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
 * Everything here is pure: the daemon uses it to sequence, and the app uses the same functions to
 * keep its own pending edits in step, so the two ends cannot disagree about what an edit means.
 */
import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

export const SHARED_DRAFT_SCHEMA_VERSION = 1 as const;
/** The same bound the browser's own draft store has always had (`pwa/src/lib/drafts.ts`). */
export const SHARED_DRAFT_MAX_CHARS = 16_000;
/** Files and locations one draft may hold. */
export const SHARED_DRAFT_MAX_ITEMS = 20;
/** Components one text operation may carry: far more than any real keystroke batch needs. */
export const SHARED_DRAFT_MAX_OP_COMPONENTS = 1_024;
/** Edits the daemon remembers to transform a late edit past; an older base must re-read the draft. */
export const SHARED_DRAFT_HISTORY_LIMIT = 200;
/** Ids and labels an item carries are shown to a person, so they are bounded like any other label. */
const SHARED_DRAFT_ID_MAX = 128;
const SHARED_DRAFT_LABEL_MAX = 255;
const SHARED_DRAFT_GENERATION_MAX = 64;

// ── Text operations ──────────────────────────────────────────────────────────────────────────────

/**
 * One step of a text operation, walked from the start of the document:
 *
 *   - a POSITIVE integer RETAINS that many characters,
 *   - a NEGATIVE integer DELETES that many,
 *   - a non-empty STRING INSERTS itself.
 *
 * The JSON is the operation, so there is no envelope to parse twice.
 */
export type TextOpComponent = number | string;
export type TextOp = readonly TextOpComponent[];

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
export const TextOpSchema = z
  .array(TextOpComponentSchema)
  .max(SHARED_DRAFT_MAX_OP_COMPONENTS)
  .readonly()
  .refine(
    op =>
      op.reduce<number>((total, component) => total + (typeof component === 'string' ? component.length : 0), 0) <=
      SHARED_DRAFT_MAX_CHARS,
    `an edit inserts at most ${SHARED_DRAFT_MAX_CHARS} characters`,
  );

const isRetain = (component: TextOpComponent | undefined): component is number =>
  typeof component === 'number' && component > 0;
const isDelete = (component: TextOpComponent | undefined): component is number =>
  typeof component === 'number' && component < 0;
const isInsert = (component: TextOpComponent | undefined): component is string => typeof component === 'string';

/** A text operation that cannot be applied, composed or transformed as asked. */
export class TextOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextOpError';
  }
}

/**
 * Builds an operation in CANONICAL form: no zero steps, neighbours of one kind merged, and an insert
 * always ahead of a delete at the same place. Two operations that do the same thing therefore have the
 * same components, which is what lets a test (or a person reading a log) compare them.
 */
class TextOpBuilder {
  readonly #components: TextOpComponent[] = [];

  retain(count: number): this {
    if (count <= 0) return this;
    const last = this.#components.at(-1);
    if (isRetain(last)) this.#components[this.#components.length - 1] = last + count;
    else this.#components.push(count);
    return this;
  }

  insert(text: string): this {
    if (text === '') return this;
    const size = this.#components.length;
    const last = this.#components[size - 1];
    if (isInsert(last)) {
      this.#components[size - 1] = last + text;
    } else if (isDelete(last)) {
      const before = this.#components[size - 2];
      if (isInsert(before)) this.#components[size - 2] = before + text;
      else {
        this.#components[size - 1] = text;
        this.#components.push(last);
      }
    } else this.#components.push(text);
    return this;
  }

  delete(count: number): this {
    if (count <= 0) return this;
    const last = this.#components.at(-1);
    if (isDelete(last)) this.#components[this.#components.length - 1] = last - count;
    else this.#components.push(-count);
    return this;
  }

  build(): TextOp {
    // A trailing retain is kept: it is what makes an operation's base length checkable.
    return [...this.#components];
  }
}

/** Rewrites any valid operation into canonical form. */
export const normalizeTextOp = (op: TextOp): TextOp => {
  const builder = new TextOpBuilder();
  for (const component of op) {
    if (isRetain(component)) builder.retain(component);
    else if (isDelete(component)) builder.delete(-component);
    else if (isInsert(component)) builder.insert(component);
  }
  return builder.build();
};

/** How long a document must be for this operation to apply to it. */
export const textOpBaseLength = (op: TextOp): number =>
  op.reduce<number>((total, component) => total + (typeof component === 'number' ? Math.abs(component) : 0), 0);

/** How long the document is after this operation. */
export const textOpTargetLength = (op: TextOp): number =>
  op.reduce<number>(
    (total, component) => total + (isRetain(component) ? component : isInsert(component) ? component.length : 0),
    0,
  );

/** An operation that changes nothing. */
export const isNoopTextOp = (op: TextOp): boolean => op.every(isRetain);

/** Applies `op` to `text`, or throws {@link TextOpError} when it was made for a different length. */
export const applyTextOp = (text: string, op: TextOp): string => {
  if (textOpBaseLength(op) !== text.length)
    throw new TextOpError(
      `the edit was made for ${textOpBaseLength(op)} characters, and the draft holds ${text.length}`,
    );
  let cursor = 0;
  let out = '';
  for (const component of op) {
    if (isRetain(component)) {
      out += text.slice(cursor, cursor + component);
      cursor += component;
    } else if (isDelete(component)) cursor -= component;
    else if (isInsert(component)) out += component;
  }
  return out;
};

/** A cursor over an operation that can hand out part of a step and keep the rest for later. */
class TextOpCursor {
  readonly #op: TextOp;
  #index = 0;
  #current: TextOpComponent | undefined;

  // No parameter property: this package is also loaded in Node's strip-only TypeScript mode.
  constructor(op: TextOp) {
    this.#op = op;
    this.#current = op[0];
  }

  get current(): TextOpComponent | undefined {
    return this.#current;
  }

  /** Consumes the whole current step. */
  next(): void {
    this.#index += 1;
    this.#current = this.#op[this.#index];
  }

  /** Consumes `count` characters of the current retain, delete or insert. */
  take(count: number): void {
    const current = this.#current;
    const size = typeof current === 'string' ? current.length : Math.abs(current ?? 0);
    if (count >= size) {
      this.next();
      return;
    }
    if (typeof current === 'string') this.#current = current.slice(count);
    else if (current !== undefined) this.#current = current > 0 ? current - count : current + count;
  }
}

const size = (component: TextOpComponent): number =>
  typeof component === 'string' ? component.length : Math.abs(component);

/**
 * Runs `first` and then `second` as ONE operation. `second` must have been made for the document
 * `first` produces. A client folds its unsent keystrokes together with this, so it only ever has one
 * edit waiting behind the one in flight.
 */
export const composeTextOps = (first: TextOp, second: TextOp): TextOp => {
  if (textOpTargetLength(first) !== textOpBaseLength(second))
    throw new TextOpError('the second edit was not made for the text the first one leaves');
  const out = new TextOpBuilder();
  const a = new TextOpCursor(first);
  const b = new TextOpCursor(second);
  for (;;) {
    const left = a.current;
    const right = b.current;
    if (left === undefined && right === undefined) break;
    if (isDelete(left)) {
      out.delete(-left);
      a.next();
      continue;
    }
    if (isInsert(right)) {
      out.insert(right);
      b.next();
      continue;
    }
    // The length check above means both run out together; this only narrows the types.
    if (left === undefined || right === undefined) break;
    const count = Math.min(size(left), size(right));
    if (isRetain(left) && isRetain(right)) out.retain(count);
    else if (isInsert(left) && isDelete(right)) {
      // Typed and then erased before anyone saw it: nothing of it survives.
    } else if (isInsert(left)) out.insert(left.slice(0, count));
    else out.delete(count);
    a.take(count);
    b.take(count);
  }
  return out.build();
};

/**
 * Two edits made against the SAME text, rewritten so each can follow the other:
 * `apply(apply(text, a), bPrime) === apply(apply(text, b), aPrime)`.
 *
 * `a` WINS A TIE: where both insert at the same place, `a`'s text comes first. The daemon passes the
 * edit it already sequenced as `a`, so the order a person sees is the order the daemon received them.
 * A CLIENT MUST DO THE SAME: `transformTextOps(sequencedByDaemon, myPending)`, the daemon's edit
 * first. Passing them the other way round breaks every tie the other way, and the devices diverge.
 */
export const transformTextOps = (a: TextOp, b: TextOp): readonly [TextOp, TextOp] => {
  if (textOpBaseLength(a) !== textOpBaseLength(b))
    throw new TextOpError('the two edits were made for drafts of different lengths');
  const aPrime = new TextOpBuilder();
  const bPrime = new TextOpBuilder();
  const left = new TextOpCursor(a);
  const right = new TextOpCursor(b);
  for (;;) {
    const x = left.current;
    const y = right.current;
    if (x === undefined && y === undefined) break;
    if (isInsert(x)) {
      aPrime.insert(x);
      bPrime.retain(x.length);
      left.next();
      continue;
    }
    if (isInsert(y)) {
      aPrime.retain(y.length);
      bPrime.insert(y);
      right.next();
      continue;
    }
    // The length check above means both run out together; this only narrows the types.
    if (x === undefined || y === undefined) break;
    const count = Math.min(size(x), size(y));
    if (isRetain(x) && isRetain(y)) {
      aPrime.retain(count);
      bPrime.retain(count);
    } else if (isDelete(x) && isRetain(y)) aPrime.delete(count);
    else if (isRetain(x) && isDelete(y)) bPrime.delete(count);
    // Both deleted the same characters: each has already done the other's work.
    left.take(count);
    right.take(count);
  }
  return [aPrime.build(), bPrime.build()];
};

/**
 * The smallest operation that turns `before` into `after`: keep the common start and end, replace the
 * middle. One textarea `input` event is one contiguous change, so this is exact for typing, pasting
 * and dictation alike.
 */
export const diffToTextOp = (before: string, after: string): TextOp => {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < shortest - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  )
    end += 1;
  return new TextOpBuilder()
    .retain(start)
    .delete(before.length - start - end)
    .insert(after.slice(start, after.length - end))
    .retain(end)
    .build();
};

/**
 * Where a caret at `index` lands once `op` has run. A caret exactly at an insert stays BEFORE it when
 * `own` is false — somebody else's typing pushes from behind — and moves past it when it is the
 * caret's own edit.
 */
export const transformTextIndex = (index: number, op: TextOp, own = false): number => {
  let cursor = 0;
  let moved = index;
  for (const component of op) {
    if (cursor > index) break;
    if (isRetain(component)) cursor += component;
    else if (isInsert(component)) {
      if (cursor < index || own) moved += component.length;
    } else if (isDelete(component)) {
      const count = -component;
      moved -= Math.min(count, index - cursor);
      cursor += count;
    }
  }
  return Math.max(0, moved);
};

// ── Items: the files and locations riding with the draft ─────────────────────────────────────────

const SharedDraftIdSchema = z.string().min(1).max(SHARED_DRAFT_ID_MAX);
const LabelSchema = z.string().min(1).max(SHARED_DRAFT_LABEL_MAX);

/** A file already on the daemon. The bytes stay in the attachment store; the draft only names them. */
export const SharedDraftAttachmentSchema = z.strictObject({
  kind: z.literal('attachment'),
  /** The attachment id the upload route returned, which is also this item's id. */
  id: SharedDraftIdSchema,
  name: LabelSchema,
  mime: LabelSchema,
  bytes: NonNegativeIntegerSchema,
});
export type SharedDraftAttachment = z.infer<typeof SharedDraftAttachmentSchema>;

/** A location the person chose to share with this message. */
export const SharedDraftLocationSchema = z.strictObject({
  kind: z.literal('location'),
  id: SharedDraftIdSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  capturedAt: NonNegativeIntegerSchema,
  place: z.string().max(80).optional(),
});
export type SharedDraftLocation = z.infer<typeof SharedDraftLocationSchema>;

export const SharedDraftItemSchema = z.discriminatedUnion('kind', [
  SharedDraftAttachmentSchema,
  SharedDraftLocationSchema,
]);
export type SharedDraftItem = z.infer<typeof SharedDraftItemSchema>;

// ── The draft and an edit to it ──────────────────────────────────────────────────────────────────

/**
 * Which life of the daemon's in-memory draft revisions belong to. A fresh one is minted every time a
 * draft is loaded into memory, so after a restart — which may have lost the last second of edits — a
 * device still holding a revision number from before is refused rather than merged: the same number
 * may now name different text.
 */
const SharedDraftGenerationSchema = z.string().min(1).max(SHARED_DRAFT_GENERATION_MAX);

export const SharedDraftSnapshotSchema = z.strictObject({
  v: z.literal(SHARED_DRAFT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  generation: SharedDraftGenerationSchema,
  /**
   * Bumped each time a send empties the draft. An edit from an older epoch was typed into a message
   * that has already gone, so it is refused rather than folded into the next one.
   */
  epoch: NonNegativeIntegerSchema,
  /** How many edits this epoch has applied. An edit names the revision it was made against. */
  rev: NonNegativeIntegerSchema,
  text: z.string().max(SHARED_DRAFT_MAX_CHARS),
  items: z.array(SharedDraftItemSchema).max(SHARED_DRAFT_MAX_ITEMS).readonly(),
  updatedAt: InstantSchema,
});
export type SharedDraftSnapshot = z.infer<typeof SharedDraftSnapshotSchema>;

/**
 * One edit: any of a text change, items added, items removed — applied together as one revision.
 *
 * `sent` marks the edit a send makes to take its own words and files out of the draft. When nothing
 * is left afterwards the epoch moves on; when somebody typed after the sender looked, what they typed
 * is still there, because the send's deletes were transformed past it like any other edit.
 */
export const SharedDraftEditSchema = z.strictObject({
  generation: SharedDraftGenerationSchema,
  epoch: NonNegativeIntegerSchema,
  base: NonNegativeIntegerSchema,
  text: TextOpSchema.optional(),
  add: z.array(SharedDraftItemSchema).max(SHARED_DRAFT_MAX_ITEMS).readonly().optional(),
  remove: z.array(SharedDraftIdSchema).max(SHARED_DRAFT_MAX_ITEMS).readonly().optional(),
  sent: z.literal(true).optional(),
});
export type SharedDraftEdit = z.infer<typeof SharedDraftEditSchema>;

/**
 * The daemon's answer to an edit: the edit AS SEQUENCED — transformed past everything that landed
 * after its base, so any device at revision `rev - 1` of `epoch` can apply it — and the draft after it.
 *
 * Items are applied `remove` FIRST, then `add`: an id in both is a replacement, and every device
 * has to agree on that order to end up with the same chips.
 */
export const SharedDraftEditResultSchema = z.strictObject({
  applied: z.strictObject({
    generation: SharedDraftGenerationSchema,
    epoch: NonNegativeIntegerSchema,
    rev: NonNegativeIntegerSchema,
    text: TextOpSchema,
    add: z.array(SharedDraftItemSchema).readonly(),
    remove: z.array(SharedDraftIdSchema).readonly(),
  }),
  snapshot: SharedDraftSnapshotSchema,
});
export type SharedDraftEditResult = z.infer<typeof SharedDraftEditResultSchema>;

/** Why an edit was refused, as the code an `ApiError` carries. */
export const SHARED_DRAFT_ERROR_CODES = {
  /**
   * The edit's base is older than the history the daemon keeps, names an epoch already sent, or comes
   * from a generation before the daemon last loaded the draft.
   */
  stale: 'shared_draft_stale',
  /** The edit would leave more than {@link SHARED_DRAFT_MAX_CHARS} characters. */
  tooLong: 'shared_draft_too_long',
  /** The edit would leave more than {@link SHARED_DRAFT_MAX_ITEMS} items. */
  tooManyItems: 'shared_draft_too_many_items',
  /** The edit's text does not fit the draft it claims to be based on. */
  invalid: 'shared_draft_invalid',
  /** Only the owner's own paired devices and own shell may read or edit a draft — never an agent. */
  ownerOnly: 'shared_draft_owner_only',
} as const;

// ── The live stream: every open composer for one session, kept in step ───────────────────────────

/** A text selection as `[start, end]` UTF-16 offsets into the draft. */
const SelectionSchema = z.tuple([NonNegativeIntegerSchema, NonNegativeIntegerSchema]).readonly();

/** Device labels are shown to a person, so they are bounded and single-line like any other label. */
const PeerLabelSchema = z
  .string()
  .min(1)
  .max(SHARED_DRAFT_LABEL_MAX)
  .regex(/^[^\r\n]*$/u, 'a device label is one line');

/**
 * What a composer sends up its stream.
 *
 * - `edit` — one edit, tagged with an id the daemon's answer echoes, so the composer knows which of its
 *   own edits an `ack` or an `error` is about.
 * - `presence` — where this composer's caret is and whether the person is typing. Never stored, never
 *   sequenced, and never shown back to the composer that sent it.
 */
export const SharedDraftClientFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('edit'), id: z.string().min(1).max(64), edit: SharedDraftEditSchema }),
  z.strictObject({ kind: z.literal('presence'), typing: z.boolean(), selection: SelectionSchema.optional() }),
]);
export type SharedDraftClientFrame = z.infer<typeof SharedDraftClientFrameSchema>;

/**
 * What the daemon sends down a composer's stream.
 *
 * - `snapshot` — the whole draft. First, when the composer could not be caught up edit by edit.
 * - `edit` — an edit as sequenced, and the epoch and revision the draft is at after it (a send that
 *   emptied the draft moves the epoch on and the revision back to 0). `id` is the id the composer that
 *   made it gave it: a composer catching up after a reconnect may find its OWN edit here, landed while
 *   it was away, and must take it as answered rather than send it again.
 * - `ready` — the catch-up is over and everything after is live: the moment to send again whatever
 *   edit is still unanswered.
 * - `ack` — this composer's own edit as sequenced, with the same "after".
 * - `error` — this composer's own edit was refused, with the daemon's code.
 * - `presence` / `left` — another of the owner's open composers: which device, its caret, whether the
 *   person is typing there; and that it closed.
 */
export const SharedDraftServerFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), snapshot: SharedDraftSnapshotSchema }),
  z.strictObject({
    kind: z.literal('edit'),
    id: z.string().min(1).max(64).optional(),
    applied: SharedDraftEditResultSchema.shape.applied,
    epoch: NonNegativeIntegerSchema,
    rev: NonNegativeIntegerSchema,
  }),
  z.strictObject({ kind: z.literal('ready') }),
  z.strictObject({
    kind: z.literal('ack'),
    id: z.string().min(1).max(64),
    applied: SharedDraftEditResultSchema.shape.applied,
    epoch: NonNegativeIntegerSchema,
    rev: NonNegativeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('error'),
    id: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    message: z.string().max(1_000),
  }),
  z.strictObject({
    kind: z.literal('presence'),
    peer: z.string().min(1).max(64),
    device: PeerLabelSchema,
    typing: z.boolean(),
    selection: SelectionSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('left'), peer: z.string().min(1).max(64) }),
]);
export type SharedDraftServerFrame = z.infer<typeof SharedDraftServerFrameSchema>;
