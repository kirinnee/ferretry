/**
 * Text with every character that changes how it LOOKS without being seen written out as `⟨U+202E⟩` (Trojan Source,
 * CVE-2021-42574). Copied from today's `revealHidden`: a review, an address and a SKILL.md are all shown through it.
 */

/**
 * The bidirectional overrides, isolates and marks; zero-width spaces, joiners and the word joiner; the soft hyphen; the
 * line and paragraph separators; the Hangul fillers; variation selectors; tag characters; the byte-order mark; the
 * interlinear annotation marks; and every other format character Unicode defines. Written as escapes, so this source
 * never holds one itself.
 */
const HIDDEN_CHARACTER_SOURCE = String.raw`\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\p{Cf}`;

/** A fresh global matcher each time, since `lastIndex` is state. */
const hiddenCharacters = (): RegExp =>
  new RegExp(
    String.raw`(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F${HIDDEN_CHARACTER_SOURCE}]|\r(?!\n))`,
    'gu',
  );

export const revealHidden = (text: string): string =>
  text.replace(
    hiddenCharacters(),
    character => `⟨U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
