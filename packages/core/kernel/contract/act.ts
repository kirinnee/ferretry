import type { Brand, Instant, JsonValue, Result } from '@ferretry/std';
import { z } from 'zod';

/**
 * The act runner's vocabulary (§4.7). Lives in the kernel leaf, not in Vault's contract where §4.7 sketches it,
 * because `kernel.act` is a kernel port and the kernel imports no core contract; Vault's contract re-exports it.
 */
export type Op =
  | 'read'
  | 'wait'
  | 'stream' // text out: a screen, a wait predicate, the viewer stream
  | 'picture' // screenshot, PDF, highlight
  | 'keys' // terminal_send (keys into a terminal)
  | 'type' // browser_type (text into the focused field)
  | 'press'
  | 'fill'
  | 'navigate'
  | 'open'
  | 'close' // other writes
  | 'script'; // browser_eval: a write that RETURNS page data

export type Effect = 'reads' | 'writes' | 'pictures';

/**
 * Every Op's effects, fixed in the contract, never chosen by a tool. `as const satisfies` keeps each entry's literal
 * tuple, so a write-only Op cannot type as returning Content (review r10 finding 2).
 */
export const OP_EFFECTS = {
  read: ['reads'],
  wait: ['reads'],
  stream: ['reads', 'pictures'],
  picture: ['pictures'],
  keys: ['writes'],
  type: ['writes'],
  press: ['writes'],
  fill: ['writes'],
  close: ['writes'],
  navigate: ['writes'],
  open: ['writes'],
  script: ['reads', 'writes'],
} as const satisfies Record<Op, readonly Effect[]>;

export const OPS: readonly Op[] = Object.freeze(Object.keys(OP_EFFECTS) as Op[]);

export function isOp(value: unknown): value is Op {
  return typeof value === 'string' && Object.hasOwn(OP_EFFECTS, value);
}

/** Terminal cells: rows of same-width cells, masked cell by cell (I105, I106). */
export interface CellGrid {
  readonly columns: number;
  readonly rows: readonly (readonly string[])[];
}

/** What a reading act returns, always already masked by `Redaction`. */
export interface Content {
  readonly kind: 'content';
  readonly text?: string;
  readonly cells?: CellGrid;
  readonly data?: JsonValue;
}

/** What a picturing act returns. A picture cannot be masked; holds refuse it for the whole window. */
export interface Picture {
  readonly kind: 'picture';
  readonly mime: 'image/png' | 'image/jpeg' | 'application/pdf';
  readonly bytes: Uint8Array;
}

declare const minted: unique symbol;
/** An id minted only by the kernel's id factory (a page `open` created). Never a target-derived string. */
export type OpaqueId = string & { readonly [minted]: true };

/** The closed refusal codes an act can answer; each is a fixed sentence (`REFUSAL_SENTENCES`). */
export const REFUSAL_CODES = [
  'held', // a page hold or pending input card refuses this effect
  'quarantined', // a terminal in quarantine after a secret
  'input_pending', // a pending input card with a non-code field
  'holds_unavailable', // no InputHolds bound, or decide threw: fail closed
  'malformed_result', // fn returned something that is not a plain Ack
  'unminted_id', // fn returned an id the kernel did not mint
  'unknown_op', // an op string not in OP_EFFECTS
  'target_gone', // the target closed before the act
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
const REFUSAL_CODE_SET: ReadonlySet<string> = new Set(REFUSAL_CODES);

export const REFUSAL_SENTENCES: Readonly<Record<RefusalCode, string>> = {
  held: 'This is held right now because the owner just typed a private value into it.',
  quarantined: 'This terminal is held after a secret was typed into it.',
  input_pending: 'The owner is filling in an input card for this; wait for it.',
  holds_unavailable: 'The hold check is unavailable, so nothing may act here.',
  malformed_result: 'The tool answered something the act runner does not accept.',
  unminted_id: 'The tool answered an id the daemon did not issue.',
  unknown_op: 'That is not an act the daemon knows.',
  target_gone: 'That target is no longer open.',
};

/**
 * What a write-only act hands back, and nothing else: a fixed status, a fixed refusal code and daemon-minted ids
 * (review r10 finding 1). No URL, title or any other target-derived string.
 */
export interface Ack {
  readonly status: 'done' | 'refused';
  readonly code?: RefusalCode;
  readonly ids?: readonly OpaqueId[];
}

export const AckSchema = z.object({
  status: z.enum(['done', 'refused']),
  code: z.enum(REFUSAL_CODES).optional(),
  ids: z.array(z.string()).optional(),
});

/** The explicit result map, checked against OP_EFFECTS below so the two cannot drift. */
export interface ResultMap {
  read: Content;
  wait: Content;
  stream: Content;
  script: Content;
  picture: Picture;
  keys: Ack;
  type: Ack;
  press: Ack;
  fill: Ack;
  navigate: Ack;
  open: Ack;
  close: Ack;
}

export type ResultOf<O extends Op> = ResultMap[O];

type ShowsSomething<O extends Op> = Extract<(typeof OP_EFFECTS)[O][number], 'reads' | 'pictures'>;
type Consistent = {
  [O in Op]: [ShowsSomething<O>] extends [never] ? (ResultMap[O] extends Ack ? true : false) : true;
};
/** Fails to compile on drift between OP_EFFECTS and ResultMap. */
export const OP_RESULTS_CONSISTENT: Consistent = {
  read: true,
  wait: true,
  stream: true,
  script: true,
  picture: true,
  keys: true,
  type: true,
  press: true,
  fill: true,
  navigate: true,
  open: true,
  close: true,
};

/** Who asks for an act, stamped by the kernel from the call's credential; a plugin cannot choose it. */
export type Actor = 'ferret' | 'owner-tools' | 'owner-viewer' | 'owner-input' | 'warden';

/** A target kind under Vault's `input.targets` hook: `terminal`, `page`, … */
export type TargetKind = Brand<string, 'TargetKind'>;

/** One thing a tool acts on: a terminal pane, a browser page. */
export interface TargetRef {
  readonly kind: TargetKind;
  readonly key: string;
}

/** An audited "Show anyway" an owner viewer holds for one target, minted by Vault only. */
export type RevealGrant = Brand<{ readonly target: TargetRef; readonly until: Instant }, 'RevealGrant'>;

export interface HoldRefusal {
  readonly refused: RefusalCode;
}

/** `InputHolds.decide`'s answer. When several rows match, the most restrictive wins (review r8 finding 3). */
export type HoldDecision = 'allow' | 'allow-masked' | HoldRefusal;

/** What `fn` is told about the decision it runs under; on `allow-masked` it must return masked reads. */
export interface ActPermit {
  readonly answer: 'allow' | 'allow-masked';
  readonly actor: Actor;
}

/**
 * The kernel's act runner (`kernel.act`, §4.7, §7.4): asks `InputHolds.decide(target, op, actor)` synchronously
 * inside the target's queue immediately before `fn`, runs `fn` only if allowed, and closes a write-only result to a
 * fresh Ack with {@link closeAck} before anything formats, journals, audits, views or replies with it. The op is
 * looked up from its RUNTIME value; an op not in OP_EFFECTS is refused before `fn` runs.
 */
export type ActRunner = <O extends Op>(
  target: TargetRef,
  op: O,
  fn: (permit: ActPermit) => Promise<ResultOf<O>>,
) => Promise<Result<ResultOf<O>, HoldRefusal>>;

/** The kernel's registry of ids it minted; `get` hands back the kernel's own copy. */
export interface MintedIds {
  has(id: unknown): boolean;
  get(id: unknown): OpaqueId;
}

const isPrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');

/**
 * The own data values of a plain array of primitives, read from its property descriptors (never through `[[Get]]` or
 * its iterator), or undefined when it is anything else. A hole reads as `undefined`, which no registry minted.
 */
function primitiveElements(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Reflect.getOwnPropertyDescriptor(value, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number') return undefined;
  const elements: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? Number(key) : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || String(index) !== key) return undefined;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !isPrimitive(descriptor.value)) return undefined;
    elements[index] = descriptor.value;
  }
  return Array.from({ length: length.value }, (_, i) => elements[i]);
}

/** The three fields `closeAck` keeps, read once each from own data descriptors. */
interface AckFields {
  readonly status: unknown;
  readonly code: unknown;
  readonly ids: readonly unknown[] | undefined;
}

/**
 * Reads a write-only result's fields without running any getter or `get` trap, or answers undefined when it is not
 * plain data: anything but an object whose prototype is `Object.prototype` or null, an accessor anywhere, any field
 * but `ids` holding an object or function, an `ids` that is not a plain array of primitives, or a Proxy (§4.7). Every
 * value comes from a property descriptor, so a field is read exactly once. The Proxy test is `structuredClone`, which
 * the engine refuses for a Proxy (the result's or its `ids`') before any trap runs; the checks before it leave a
 * non-Proxy nothing a clone could run (no accessor, no nested object but the checked array). A Proxy still answers the
 * descriptor reads above with its other traps; they run inside `closeAck`'s boundary, and their answers are thrown
 * away when the clone refuses it.
 */
function plainAckFields(raw: unknown): AckFields | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const prototype = Reflect.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  let status: unknown;
  let code: unknown;
  let ids: readonly unknown[] | undefined = [];
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined; // a getter or setter
    const value: unknown = descriptor.value;
    if (key === 'ids') {
      ids = value === undefined ? [] : primitiveElements(value);
      if (ids === undefined) return undefined;
    } else if (!isPrimitive(value)) return undefined;
    else if (key === 'status') status = value;
    else if (key === 'code') code = value;
  }
  structuredClone(raw); // throws for a Proxy, without a trap
  return { status, code, ids };
}

const malformed = (): Ack => Object.freeze({ status: 'refused', code: 'malformed_result' });

/**
 * The runtime first layer for a write-only act (review r11): reads three own data properties by name from their
 * descriptors (never a getter, never a Proxy, never spread), never keeps or returns `raw`, and returns a fresh,
 * frozen, strictly parsed Ack. Everything from the first look at `raw` to the parse is inside one boundary: whatever
 * throws in it answers `malformed_result`.
 */
export function closeAck(raw: unknown, mintedIds: MintedIds): Ack {
  try {
    const fields = plainAckFields(raw);
    if (fields === undefined) return malformed();
    const status = fields.status === 'done' || fields.status === 'refused' ? fields.status : undefined;
    const rawCode = fields.code;
    const code =
      rawCode === undefined || (typeof rawCode === 'string' && REFUSAL_CODE_SET.has(rawCode))
        ? (rawCode as RefusalCode | undefined)
        : undefined;
    const ids = fields.ids;
    if (status === undefined || (rawCode !== undefined && code === undefined) || ids === undefined) return malformed();
    if (!ids.every(id => mintedIds.has(id))) return Object.freeze({ status: 'refused', code: 'unminted_id' });
    const fresh: { status: Ack['status']; code?: RefusalCode; ids?: OpaqueId[] } = { status };
    if (code !== undefined) fresh.code = code;
    if (ids.length > 0) fresh.ids = ids.map(id => mintedIds.get(id));
    const parsed = AckSchema.strict().parse(fresh);
    const out: { status: Ack['status']; code?: RefusalCode; ids?: readonly OpaqueId[] } = { status: parsed.status };
    if (parsed.code !== undefined) out.code = parsed.code;
    if (fresh.ids !== undefined) out.ids = Object.freeze([...fresh.ids]);
    return Object.freeze(out);
  } catch {
    return malformed();
  }
}

/** Whether an op's result may show anything (reads or pictures). Looked up from the runtime value. */
export function showsSomething(op: Op): boolean {
  const effects: readonly Effect[] = OP_EFFECTS[op];
  return effects.includes('reads') || effects.includes('pictures');
}
