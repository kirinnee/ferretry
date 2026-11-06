/**
 * Proving that a payload actually reached a harness's composer.
 *
 * Typing into a TUI is not a request with a reply. `send-keys` succeeds as long as tmux delivered
 * the keys to the pane's pty, which says nothing about whether the harness was in a state to accept
 * them — and the daemon's whole job is delivering an agent its work. So delivery here is a
 * two-part act: get the text in, then find EVIDENCE of it in a later frame, and only then submit.
 *
 * The evidence has two forms, and conflating them destroyed real messages in the source system.
 * Both harnesses collapse a large or multi-line paste into a placeholder and render none of its
 * characters, so a character-echo check reports "nothing landed" for a payload that landed
 * perfectly — and the retry that follows clears the composer first, destroying it. Hence
 * `LandingEvidence`: a caller that landed on a placeholder must never clear and retype.
 */

/**
 * Which kind of evidence proved a payload reached the composer.
 *
 * `placeholder` means the harness took it and is deliberately showing NONE of its characters. That
 * is a successful delivery the caller cannot re-verify by looking for its text.
 */
export type LandingEvidence = 'chars' | 'placeholder';

/**
 * Collapsed-paste placeholders, taken from the shipped binaries' own format strings rather than
 * guessed: Claude Code renders `[Pasted text #1 +16 lines]`, `[Image #1]`, `[Audio #1]` and
 * `[…Truncated text …]`; Codex renders `[Pasted Content …]`.
 *
 * The capture group is the placeholder's counter, so a SECOND paste (`#2`) is recognisable as new
 * even while the frame still shows the first.
 */
export const PASTE_PLACEHOLDER_PATTERN =
  '\\[(?:Pasted text|Pasted Content|Image|Audio|\\.{3}Truncated text)(?:[^\\]\\n]*?#(\\d+))?[^\\]\\n]*\\]';

const PASTE_PLACEHOLDER = new RegExp(PASTE_PLACEHOLDER_PATTERN, 'gi');

/**
 * Above this many characters — or on any embedded newline — a payload travels as a BRACKETED PASTE
 * rather than as literal keystrokes.
 *
 * Both TUIs treat a large burst of literal keys as a paste anyway and then collapse it, so making
 * the paste explicit is the difference between one deterministic paste event and a race with the
 * harness's own burst heuristic.
 */
export const PASTE_TRANSPORT_CHARS = 240;

/** How the composer should be filled with this payload. */
export type ComposerTransport = 'literal' | 'paste';

export function composerTransport(text: string): ComposerTransport {
  return text.includes('\n') || text.length > PASTE_TRANSPORT_CHARS ? 'paste' : 'literal';
}

export interface ComposerEvidence {
  /** Occurrences of the payload's character probe in the frame. */
  readonly chars: number;
  /** Collapsed-paste placeholders in the frame. */
  readonly placeholders: number;
  /** Highest placeholder counter seen (`#3` ⇒ 3); 0 when none carries one. */
  readonly maxPlaceholderIndex: number;
}

/**
 * What a frame says about a payload we typed.
 *
 * The probe is the whitespace-stripped first 50 characters, and it is COUNTED rather than tested for
 * presence: a payload like `continue` is routinely already somewhere on screen, so only a change in
 * the count between two frames proves the composer received this copy. Stripping whitespace is what
 * survives the TUI wrapping the payload across composer lines.
 */
export function composerEvidence(frame: string, text: string): ComposerEvidence {
  const strip = (value: string): string => value.replace(/\s+/g, '');
  const probe = strip(text).slice(0, 50);
  let chars = 0;
  if (probe.length > 0) {
    const haystack = strip(frame);
    for (let index = haystack.indexOf(probe); index >= 0; index = haystack.indexOf(probe, index + 1)) chars++;
  }
  let placeholders = 0;
  let maxPlaceholderIndex = 0;
  for (const match of frame.matchAll(PASTE_PLACEHOLDER)) {
    placeholders++;
    const counter = Number(match[1] ?? 0);
    if (counter > maxPlaceholderIndex) maxPlaceholderIndex = counter;
  }
  return { chars, placeholders, maxPlaceholderIndex };
}

/**
 * The evidence a pair of before/after frames provides, or `undefined` when neither form appeared.
 *
 * A new placeholder outranks a new character echo: when the harness collapsed the paste, its
 * characters are not on screen at all, and treating the frame as unproven is what leads a caller to
 * clear a composer that is holding a perfectly good message.
 */
export function landingEvidence(before: ComposerEvidence, after: ComposerEvidence): LandingEvidence | undefined {
  if (after.placeholders > before.placeholders || after.maxPlaceholderIndex > before.maxPlaceholderIndex)
    return 'placeholder';
  return after.chars > before.chars ? 'chars' : undefined;
}

/**
 * True while the frame still shows the payload we typed, in whichever display form proved it landed.
 *
 * This is how a caller tells "still sitting in the composer" from "consumed", without having to care
 * whether the harness chose to render characters or a placeholder.
 */
export function composerHolds(frame: string, text: string, evidence: LandingEvidence): boolean {
  const seen = composerEvidence(frame, text);
  return evidence === 'placeholder' ? seen.placeholders > 0 : seen.chars > 0;
}

/** One collapsed-paste placeholder and nothing else around it. */
const LONE_PASTE_PLACEHOLDER = /^\[(?:Pasted text|Pasted Content)[^\]\n]*\]$/iu;

/** Claude's chip for a paste with no line break: its counter and nothing else (`[Pasted text #30]`). */
const COUNTLESS_CLAUDE_PASTE = /^\[Pasted text #\d+\]$/iu;

/**
 * Whether a composer showing ONLY a collapsed-paste placeholder can be this payload's paste (B144).
 *
 * A placeholder hides the text, so "a placeholder is there" proves nothing about whose paste it is: a person
 * who cleared our paste and pasted their own draft shows one too. The placeholder's own count is the only
 * thing it says about what it holds, so it must agree with the payload: Claude's `+N lines` (the payload's
 * line breaks, or its lines — the two readings of the counter, both accepted) or Codex's `N chars`. An image
 * or audio placeholder, or one beside any other text, is never claimed.
 *
 * &B153: CLAUDE'S COUNTLESS CHIP IS A COUNT OF ZERO. Claude draws `+N lines` only when the paste has line
 * breaks; a paste with none — a long one-line message, which travels as a paste past
 * {@link PASTE_TRANSPORT_CHARS} — is drawn `[Pasted text #N]` with no count at all. Refusing that chip left a
 * 1,550-character owner decision typed in a lead's box for 40 minutes on 2026-11-06: the fill would not press
 * Enter on it (`composerHoldsOtherText`), and nothing afterwards could prove it ours. So a countless Claude
 * chip agrees with exactly the payloads that have no line break, and with no other. A countless Codex chip
 * is still never claimed: Codex always draws its count.
 */
export function lonePasteOf(composer: string, text: string): boolean {
  const shown = composer.trim();
  if (!LONE_PASTE_PLACEHOLDER.test(shown)) return false;
  if (COUNTLESS_CLAUDE_PASTE.test(shown)) return !text.includes('\n');
  const lines = /\+(\d+)\s+lines?\b/iu.exec(shown);
  if (lines !== null) {
    const breaks = text.split('\n').length - 1;
    const counted = Number(lines[1]);
    return counted === breaks || counted === breaks + 1;
  }
  const chars = /(\d+)\s+chars?\b/iu.exec(shown);
  if (chars === null) return false;
  const counted = Number(chars[1]);
  return counted === text.length || counted === [...text].length;
}
