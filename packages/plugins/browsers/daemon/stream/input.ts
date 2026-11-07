import { type BrowserInputEvent, BrowserInputEventSchema } from '@ferretry/protocol';

/** The key variant, named once so the release policy below can talk about it. */
export type BrowserKeyInput = Extract<BrowserInputEvent, { kind: 'key' }>;

export const MAX_KEY_NAME_CHARS = 128;
export const MAX_KEY_TEXT_CHARS = 16;
export const MAX_INSERT_TEXT_CHARS = 200_000;
export const MAX_MOUSE_BUTTON_MASK = 31;
export const MAX_CLICK_COUNT = 3;
export const MAX_WHEEL_DELTA = 10_000;
export const MAX_INPUT_MODIFIERS = 15;
export const MAX_VIRTUAL_KEY_CODE = 0xffff;
/** Pointer coordinates are viewport-relative; anything past this is a malformed client, not a click. */
export const MAX_COORDINATE = 1_000_000;

export type BrowserInputResult =
  | { readonly ok: true; readonly value: BrowserInputEvent }
  | { readonly ok: false; readonly message: string };

const MOUSE_TYPES = ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'] as const;
const MOUSE_BUTTONS = ['none', 'left', 'middle', 'right', 'back', 'forward'] as const;

type MouseType = (typeof MOUSE_TYPES)[number];
type MouseButton = (typeof MOUSE_BUTTONS)[number];

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Missing numeric fields default to zero because CDP treats them as absent-means-zero, but a
 * present-and-unparseable field is a protocol error rather than a zero: silently coercing `"abc"`
 * or `null` into a coordinate would move the pointer somewhere the client never asked for.
 */
function bounded(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
  round: boolean,
): number | undefined {
  const present = raw[key];
  if (present === undefined) return 0;
  if (typeof present !== 'number' || !Number.isFinite(present)) return undefined;
  const clamped = Math.max(minimum, Math.min(maximum, round ? Math.round(present) : present));
  return clamped;
}

function shortString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length <= MAX_KEY_NAME_CHARS ? value : undefined;
}

function normalizeMouse(raw: Readonly<Record<string, unknown>>): BrowserInputResult {
  if (!MOUSE_TYPES.includes(raw['type'] as MouseType)) {
    return { ok: false, message: 'unsupported mouse input type' };
  }
  const button = raw['button'];
  if (button !== undefined && !MOUSE_BUTTONS.includes(button as MouseButton)) {
    return { ok: false, message: 'unsupported mouse button' };
  }
  const x = bounded(raw, 'x', -MAX_COORDINATE, MAX_COORDINATE, false);
  const y = bounded(raw, 'y', -MAX_COORDINATE, MAX_COORDINATE, false);
  const buttons = bounded(raw, 'buttons', 0, MAX_MOUSE_BUTTON_MASK, true);
  const clickCount = bounded(raw, 'clickCount', 0, MAX_CLICK_COUNT, true);
  const deltaX = bounded(raw, 'deltaX', -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA, false);
  const deltaY = bounded(raw, 'deltaY', -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA, false);
  const modifiers = bounded(raw, 'modifiers', 0, MAX_INPUT_MODIFIERS, true);
  if (
    x === undefined ||
    y === undefined ||
    buttons === undefined ||
    clickCount === undefined ||
    deltaX === undefined ||
    deltaY === undefined ||
    modifiers === undefined
  ) {
    return { ok: false, message: 'mouse input carries a non-numeric field' };
  }
  return finalize({
    kind: 'mouse',
    type: raw['type'] as MouseType,
    x,
    y,
    ...(button === undefined ? {} : { button: button as MouseButton }),
    buttons,
    clickCount,
    deltaX,
    deltaY,
    modifiers,
  });
}

function normalizeKey(raw: Readonly<Record<string, unknown>>): BrowserInputResult {
  const type = raw['type'];
  if (type !== 'keyDown' && type !== 'keyUp') return { ok: false, message: 'unsupported key input type' };
  const key = shortString(raw, 'key');
  const code = shortString(raw, 'code');
  if (key === undefined || code === undefined) {
    return { ok: false, message: `key and code must be strings no longer than ${MAX_KEY_NAME_CHARS} characters` };
  }
  const text = raw['text'];
  const unmodifiedText = raw['unmodifiedText'];
  // kteam silently dropped over-long text and dispatched the keystroke without it, which types a
  // different thing than the client asked for. Refuse it instead.
  for (const candidate of [text, unmodifiedText]) {
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string' || candidate.length > MAX_KEY_TEXT_CHARS) {
      return { ok: false, message: `key text must be a string no longer than ${MAX_KEY_TEXT_CHARS} characters` };
    }
  }
  const windowsVirtualKeyCode = bounded(raw, 'windowsVirtualKeyCode', 0, MAX_VIRTUAL_KEY_CODE, true);
  const nativeVirtualKeyCode = bounded(raw, 'nativeVirtualKeyCode', 0, MAX_VIRTUAL_KEY_CODE, true);
  const modifiers = bounded(raw, 'modifiers', 0, MAX_INPUT_MODIFIERS, true);
  if (windowsVirtualKeyCode === undefined || nativeVirtualKeyCode === undefined || modifiers === undefined) {
    return { ok: false, message: 'key input carries a non-numeric field' };
  }
  return finalize({
    kind: 'key',
    type,
    key,
    code,
    ...(text === undefined ? {} : { text: text as string }),
    ...(unmodifiedText === undefined ? {} : { unmodifiedText: unmodifiedText as string }),
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
    modifiers,
    autoRepeat: raw['autoRepeat'] === true,
    isKeypad: raw['isKeypad'] === true,
  });
}

function normalizeInsertText(raw: Readonly<Record<string, unknown>>): BrowserInputResult {
  const text = raw['text'];
  if (typeof text !== 'string' || text.length > MAX_INSERT_TEXT_CHARS) {
    return { ok: false, message: `text must be a string no longer than ${MAX_INSERT_TEXT_CHARS} characters` };
  }
  return finalize({ kind: 'insertText', text });
}

/** The wire schema is the last word: normalization proposes, parse-don't-validate disposes. */
function finalize(candidate: unknown): BrowserInputResult {
  const parsed = BrowserInputEventSchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: 'browser input failed validation' };
}

/**
 * Normalizes an untrusted client message into a CDP-dispatchable input event. Continuous ranges are
 * clamped (a trackpad that overshoots must not kill a healthy viewer); malformed shapes, unknown
 * kinds, and over-long strings are refused.
 */
export function normalizeBrowserInput(value: unknown): BrowserInputResult {
  const raw = asRecord(value);
  switch (raw['kind']) {
    case 'mouse':
      return normalizeMouse(raw);
    case 'key':
      return normalizeKey(raw);
    case 'insertText':
      return normalizeInsertText(raw);
    default:
      return { ok: false, message: 'unsupported browser input kind' };
  }
}

/** Identity a held key is tracked under, so a keyUp releases the key its keyDown pressed. */
export function keyIdentity(input: BrowserKeyInput): string {
  return input.code.length > 0 ? input.code : input.key;
}

/**
 * The keyUp events that must be dispatched when a viewer vanishes mid-chord. Newest first, because
 * releasing a modifier before the key it modifies leaves the page with a stuck combination; text
 * payloads are stripped so a release can never insert characters.
 */
export function keyReleaseSequence(pressed: Iterable<BrowserKeyInput>): readonly BrowserKeyInput[] {
  return [...pressed].reverse().map(input => {
    const { text: _text, unmodifiedText: _unmodifiedText, ...rest } = input;
    return { ...rest, type: 'keyUp' as const, modifiers: 0, autoRepeat: false };
  });
}
