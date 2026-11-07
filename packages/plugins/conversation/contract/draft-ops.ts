/**
 * The pure rules of the shared draft (today's `shared-draft.ts`, the part that is not a schema): the text-operation
 * algebra the daemon and every composer both run, the slot helpers and a frame's wire cost. Copied unchanged.
 */
import { DRAFT_CHAT_SLOT, type DraftSlot, type TextOp, type TextOpComponent } from './wire-draft.ts';

/** The slot a request or snapshot names, `chat` when it names none. */
export const draftSlotOf = (carrier: { readonly slot?: DraftSlot | undefined }): DraftSlot =>
  carrier.slot ?? DRAFT_CHAT_SLOT;

/** Whether this slot is an agenda item's reply rather than the chat box. */
export const isDraftItemSlot = (slot: DraftSlot | undefined): slot is Exclude<DraftSlot, 'chat'> =>
  slot !== undefined && slot !== DRAFT_CHAT_SLOT;

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

/** What a frame costs on the wire, escaped twice, in UTF-8 bytes. */
export const draftFrameBytes = (frame: unknown): number =>
  new TextEncoder().encode(JSON.stringify(JSON.stringify(frame))).length;
