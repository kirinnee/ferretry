import { parseHandoffPointer } from '@ferretry/protocol';
import type { SendPath, SendRecord } from './types.ts';

/**
 * Recognising a POINTER THE DAEMON ITSELF TYPED, left sitting in the composer because its Enter never
 * took.
 *
 * Ferretry types one short line for a long message — "Read the file …/turns/turn-008.md now, then …" —
 * and when the Enter for it is swallowed (a stalled daemon, a repaint) the line stays in the composer.
 * Every later send then found "unsent text" there and refused, so a person was told to deal with a
 * draft that was never theirs, in a terminal they may not be able to reach.
 *
 * WHAT MAKES IT PROVABLY OURS is the ledger, not the wording. The draft must be the pointer of one
 * still-unsettled send in THIS session's own ledger — so a person's draft, a person who quoted a
 * pointer, an edited pointer and another session's pointer all fail, and the composer is left alone.
 *
 * TOLERANT ONLY WHERE A TUI IS. Whitespace is ignored, because a TUI re-wraps a long line wherever it
 * likes; and a draft the harness clipped with `…` still matches, but only when what is visible runs
 * past the whole turn-file path. The path is the part that differs from one pointer to the next, so a
 * clip inside it ("Read the file /Users/me/.ferretry/stat…") could be any session's pointer and is
 * refused like a person's draft.
 */

/** The transports that type a pointer rather than the message itself. */
const POINTER_PATHS: ReadonlySet<SendPath> = new Set<SendPath>(['turn-file', 'native-file']);

/** The fates of a send whose pointer may still be sitting typed: open, or settled without proof. */
const UNSETTLED: ReadonlySet<SendRecord['fate']> = new Set<SendRecord['fate']>(['accepted', 'queued', 'unaccounted']);

/** How a TUI may have redrawn a line: wrapped anywhere, never reworded. */
function squeezed(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '');
}

/** The pointer a send typed, when it typed one and it could still be stranded in the composer. */
export function strandablePointer(record: SendRecord): string | undefined {
  if (record.held === true || !UNSETTLED.has(record.fate) || !POINTER_PATHS.has(record.path)) return undefined;
  const pointer = record.matchText;
  return pointer !== undefined && parseHandoffPointer(pointer) !== null ? pointer : undefined;
}

/**
 * Whether `draft` is exactly `pointer` as a TUI may draw it: re-wrapped, or clipped with `…` after the
 * whole path.
 */
export function showsOwnPointer(draft: string, pointer: string): boolean {
  const parsed = parseHandoffPointer(pointer);
  if (parsed === null) return false;
  const shown = squeezed(draft);
  const wanted = squeezed(pointer);
  if (shown === wanted) return true;
  if (!shown.endsWith('…')) return false;
  const visible = shown.slice(0, -1);
  // Everything up to and including the path must be on screen: the path is what tells one pointer
  // from another, so a clip that cut into it proves nothing about whose this is.
  const identifying = squeezed(pointer.slice(0, pointer.indexOf(parsed.path) + parsed.path.length));
  return visible.length >= identifying.length && wanted.startsWith(visible);
}

/**
 * The one unsettled send of this session whose pointer the composer is holding, or `undefined` when
 * the draft is anything else — including when, impossibly, two sends would both match it.
 */
export function strandedPointerSend(draft: string, records: readonly SendRecord[]): SendRecord | undefined {
  const matches = records.filter(record => {
    const pointer = strandablePointer(record);
    return pointer !== undefined && showsOwnPointer(draft, pointer);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether two readings of the composer are the same text, however the TUI wrapped either. */
export function sameComposerText(left: string, right: string): boolean {
  return squeezed(left) === squeezed(right);
}
