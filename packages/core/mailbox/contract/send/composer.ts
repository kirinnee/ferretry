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
 * Collapsed-paste placeholders, taken from the shipped binaries' own format strings rather than
 * guessed: Claude Code renders `[Pasted text #1 +16 lines]`, `[Image #1]`, `[Audio #1]` and
 * `[…Truncated text …]`; Codex renders `[Pasted Content …]`.
 *
 * The capture group is the placeholder's counter, so a SECOND paste (`#2`) is recognisable as new
 * even while the frame still shows the first.
 */
export const PASTE_PLACEHOLDER_PATTERN =
  '\\[(?:Pasted text|Pasted Content|Image|Audio|\\.{3}Truncated text)(?:[^\\]\\n]*?#(\\d+))?[^\\]\\n]*\\]';

/**
 * Above this many characters — or on any embedded newline — a payload travels as a BRACKETED PASTE
 * rather than as literal keystrokes.
 *
 * Both TUIs treat a large burst of literal keys as a paste anyway and then collapse it, so making
 * the paste explicit is the difference between one deterministic paste event and a race with the
 * harness's own burst heuristic.
 */
const PASTE_TRANSPORT_CHARS = 240;

/** How the composer should be filled with this payload. */
export type ComposerTransport = 'literal' | 'paste';

export function composerTransport(text: string): ComposerTransport {
  return text.includes('\n') || text.length > PASTE_TRANSPORT_CHARS ? 'paste' : 'literal';
}

/** One collapsed-paste placeholder and nothing else around it. */
const LONE_PASTE_PLACEHOLDER = /^\[(?:Pasted text|Pasted Content)[^\]\n]*\]$/iu;

/**
 * Whether a composer showing ONLY a collapsed-paste placeholder can be this payload's paste (B144).
 *
 * A placeholder hides the text, so "a placeholder is there" proves nothing about whose paste it is: a person
 * who cleared our paste and pasted their own draft shows one too. The placeholder's own count is the only
 * thing it says about what it holds, so it must agree with the payload: Claude's `+N lines` (the payload's
 * line breaks, or its lines — the two readings of the counter, both accepted) or Codex's `N chars`. A
 * placeholder with no count, an image or audio placeholder, or one beside any other text is never claimed.
 */
export function lonePasteOf(composer: string, text: string): boolean {
  const shown = composer.trim();
  if (!LONE_PASTE_PLACEHOLDER.test(shown)) return false;
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
