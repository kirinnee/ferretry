import { parseHandoffPointer } from '@ferretry/protocol';
import { composerTransport, lonePasteOf } from '../../tmux/composer.ts';
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
  if (record.held === true || record.untyped === true || !UNSETTLED.has(record.fate) || !POINTER_PATHS.has(record.path))
    return undefined;
  const pointer = record.matchText;
  return pointer !== undefined && parseHandoffPointer(pointer) !== null ? pointer : undefined;
}

/**
 * &B153 — A POINTER THE HARNESS TOOK BACK. On 2026-11-06 a lead's turn-007 pointer was typed, its Enter took,
 * and Claude Code wrote the user record the tracker settles `delivered` on — then, a second later and before
 * any reply, put the text back into the composer (a background agent's permission prompt was still pending;
 * Claude rewinds a prompt cancelled before its first answer into the box). The ledger said `delivered`, so
 * nothing could ever claim the text again: the ferret sat three hours with its own turn in its box.
 *
 * This is only the CANDIDATE rule, from the ledger: the NEWEST send this session typed (by when it was last
 * typed), so once anything was typed after it the pointer seen again is something else and is left alone. It
 * cannot tell a harness's rewind from a person pressing Up to recall the last prompt, so the send path never
 * presses on it without the transcript's proof that its user record was never answered (`retraction.ts`).
 */
/** When a send was last typed: its current attempt, else its acceptance. */
function lastTypedMs(record: SendRecord): number {
  return Date.parse(record.attemptAt ?? record.acceptedAt);
}

export function retractedPointer(record: SendRecord, records: readonly SendRecord[]): string | undefined {
  if (record.fate !== 'delivered' || record.held === true || record.untyped === true || !POINTER_PATHS.has(record.path))
    return undefined;
  const pointer = record.matchText;
  if (pointer === undefined || parseHandoffPointer(pointer) === null) return undefined;
  // Ordered by when each was last TYPED: a send retried after a later one was delivered is newer than it.
  const typedAt = lastTypedMs(record);
  const newer = records.some(
    other =>
      other.sendId !== record.sendId &&
      other.held !== true &&
      other.untyped !== true &&
      other.fate !== 'withdrawn' &&
      lastTypedMs(other) >= typedAt,
  );
  return newer ? undefined : pointer;
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

/**
 * B144: NOT ONLY A POINTER. A message typed AS ITSELF — a peer's envelope, a Warden notice, the person's own
 * words from the app — is stranded the same way when its Enter is swallowed: on 2026-11-02 a lead's
 * three-paragraph message sat in a ferret's composer as `[Pasted text #40 +3 lines]` for fourteen hours, the
 * ferret idle at its prompt, while every later message waited behind it as a "draft".
 *
 * WHAT MAKES IT OURS is still the ledger: the fill typed it into a composer it had proven EMPTY, so text that
 * is exactly it, still there, is the send's own. A message this short could be a word a person typed, so it
 * is never claimed below {@link OWN_TEXT_MIN} characters; and a paste drawn as a placeholder is claimed only
 * when the placeholder is ALL the composer shows AND its own count agrees with the message (`lonePasteOf`):
 * a person who cleared our paste and pasted their own draft shows a placeholder too.
 */

/** The transports that type the message itself rather than a pointer at it. */
const INLINE_PATHS: ReadonlySet<SendPath> = new Set<SendPath>(['direct', 'native-inline']);

/** Below this many characters (whitespace ignored) a message could be a person's own words, so it is never claimed. */
export const OWN_TEXT_MIN = 12;

/**
 * The text a send typed that may still be sitting in the composer: its pointer, or — for a message typed as
 * itself — the message, when it is long enough to be told from a person's word. `undefined` when the send is
 * settled, held for a revive, was never typed, or is too short to claim.
 *
 * Given the session's whole ledger, a delivered pointer the harness took back counts too ({@link retractedPointer});
 * without it only unsettled sends do, which is what the tracker's own watch wants.
 */
export function strandableText(record: SendRecord, records?: readonly SendRecord[]): string | undefined {
  const pointer = strandablePointer(record) ?? (records === undefined ? undefined : retractedPointer(record, records));
  if (pointer !== undefined) return pointer;
  if (record.held === true || record.untyped === true || !UNSETTLED.has(record.fate)) return undefined;
  if (!INLINE_PATHS.has(record.path)) return undefined;
  const text = record.matchText ?? record.message;
  return squeezed(text).length >= OWN_TEXT_MIN ? text : undefined;
}

/**
 * Whether `draft` is exactly what this send typed, as a TUI may draw it: the pointer re-wrapped or clipped
 * after its path; the message re-wrapped, or clipped with `…` past {@link OWN_TEXT_MIN} characters; or, for a
 * message that travelled as a paste, one collapsed placeholder alone whose count agrees with it.
 */
export function showsOwnText(draft: string, text: string): boolean {
  if (parseHandoffPointer(text) !== null) return showsOwnPointer(draft, text);
  const shown = squeezed(draft);
  const wanted = squeezed(text);
  if (wanted.length < OWN_TEXT_MIN || shown === '') return false;
  if (shown === wanted) return true;
  if (composerTransport(text) === 'paste' && lonePasteOf(draft, text)) return true;
  if (!shown.endsWith('…')) return false;
  const visible = shown.slice(0, -1);
  return visible.length >= OWN_TEXT_MIN && wanted.startsWith(visible);
}

/**
 * The one unsettled send of this session whose own text the composer is holding, or `undefined` when the
 * draft is anything else — or when two sends would both match it (two pastes drawn as the same kind of
 * placeholder), because then neither is provably the one in the box.
 */
export function strandedSend(draft: string, records: readonly SendRecord[]): SendRecord | undefined {
  const matches = records.filter(record => {
    const text = strandableText(record, records);
    return text !== undefined && showsOwnText(draft, text);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
