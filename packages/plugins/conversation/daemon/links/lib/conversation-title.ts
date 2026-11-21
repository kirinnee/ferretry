import { taskTitleFor } from '@ferretry/core-ferrets/contract';
import { SECRET_TOKEN_SOURCE } from '@ferretry/std/credential-words';
import { CONVERSATION_NAME_MAX } from '../../../contract/index.ts';
import { TITLE_BRIEF_MAX, truncateText } from './conversation-text.ts';

/**
 * A CONVERSATION'S TITLE: the words a drawer row, a header, a notification and the Conversations list all show for it.
 *
 * A title travels further than a preview (it is stored in Ferrets' record and shown in places a message never is), so every
 * title, whoever wrote it, is SCRUBBED before it is stored: the vault's known values are masked ({@link ScrubText}, one
 * read-scoped batch), then every word that has the SHAPE of a credential is dropped, because the vault only knows the values
 * it was told. Nothing here calls a model: when the CLI wrote no title the words come from the first thing the owner said, by
 * the one deterministic rule Ferrets owns (`taskTitleFor`).
 *
 * Everything here is pure; the redaction read is the caller's.
 */

/** Masks the vault's known secret values in one text (a `RedactionScope.text`, valid for the batch that made it). */
export type ScrubText = (text: string) => string;

/** The label `taskTitleFor` names a brief with nothing readable in it (`Conversation 7k2x`): not a title worth showing. */
const FALLBACK_LABEL = 'Conversation';
const FALLBACK_TITLE = new RegExp(`^${FALLBACK_LABEL} [0-9a-z]{4}$`, 'u');

/** What `NFKC` does not remove but nobody reads: soft hyphen, zero-width and direction marks, the BOM. Spelled between a token's letters they hide it. */
const INVISIBLE: readonly (readonly [from: number, to: number])[] = [
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

/** `text` with the invisible characters out (and every control character: none belongs in a title). */
const plainOf = (text: string): string =>
  Array.from(text.normalize('NFKC'))
    .filter(character => {
      const code = character.codePointAt(0) ?? 0;
      if (character === '\n' || character === '\t') return true;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
      return !INVISIBLE.some(([from, to]) => code >= from && code <= to);
    })
    .join('');

/** The marks a vault leaves where a value was (`[redacted]`, `[redacted:NAME]`, `${secret:NAME}`): never words of a title. */
const MASK_MARKS = /\[redacted(?::[^\]\s]*)?\]|\$\{secret:[^}\s]*\}/giu;

/** A private key or certificate block, from its BEGIN line to its END line, or to the end of the text when the END was cut off. */
const KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|SIGNATURE)[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/gu;

/** `Authorization`-style: the word after Bearer / Basic / Token is the credential. */
const SCHEME_THEN_CREDENTIAL = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu;

/** A word that names a credential and carries its value glued to it: `TOKEN=…`, `password:…`, `--api-key=…`. */
const NAMED_CREDENTIAL =
  /^[\w.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[\w.-]*[=:]\S+/iu;

/** A URL whose user part carries a password. */
const URL_PASSWORD = /\/\/[^\s/:@]*:[^\s/@]+@/u;

const KNOWN_TOKEN = new RegExp(`(?:${SECRET_TOKEN_SOURCE})`, 'u');
/** A JWT (three dot-separated parts, the first starting `eyJ`), a Google OAuth token, an AWS-style secret run. */
const SPECIAL_TOKEN = /^(?:eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}|ya29\.[A-Za-z0-9_-]{8,})/u;
/** A long run of key-like characters (base64, base64url, hex): no dot, so a file name or a dotted name is not one. */
const KEY_RUN = /^[A-Za-z0-9+/_=-]{24,}$/u;
/** A word that is a file path (`/a/b`, `./a`, `~/a`): long and full of digits, but a place, not a key. A token inside one is still caught by its format. */
const PATH_WORD = /^[("'`<[]*(?:~|\.{0,2})\//u;
const LONG_HEX = /^[0-9a-fA-F]{32,}$/u;

/** The edge of a word that is punctuation, not part of what the word is (`"sk-abc…",` is the token `sk-abc…`). */
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Whether one whitespace-free word has the shape of a credential. Over-masking (the safe side) is accepted. */
export function looksLikeCredential(word: string): boolean {
  const core = word.replaceAll(EDGE, '');
  if (core.length < 8) return NAMED_CREDENTIAL.test(word);
  if (KNOWN_TOKEN.test(word) || SPECIAL_TOKEN.test(core) || NAMED_CREDENTIAL.test(word) || URL_PASSWORD.test(word))
    return true;
  if (LONG_HEX.test(core)) return true;
  // A long mixed run with a digit and a letter is a key, not a word; a plain long word (`internationalisation`) has no digit.
  return !PATH_WORD.test(word) && KEY_RUN.test(core) && /\d/u.test(core) && /\p{L}/u.test(core);
}

/**
 * `text` with every word that looks like a credential removed, and any private-key block. The text is first made plain
 * (`NFKC`, invisible characters out), so a token spelled in full-width letters or with a zero-width space inside it is the
 * token it is. Lines survive: a heading is still a heading.
 */
export function dropCredentialShapes(text: string): string {
  const plain = plainOf(text);
  const withoutBlocks = plain.replaceAll(KEY_BLOCK, ' ').replaceAll(SCHEME_THEN_CREDENTIAL, ' ');
  return withoutBlocks.replaceAll(/\S+/gu, word => (looksLikeCredential(word) ? ' ' : word));
}

/**
 * One text, scrubbed for a title: the vault's values masked (before AND after the text is made plain, so a value spelled in
 * another form is still found), the credential-shaped words dropped, the vault's own marks removed, whitespace as it was.
 */
export function scrubTitleText(text: string, scrub: ScrubText): string {
  const masked = scrub(text);
  const plain = scrub(plainOf(masked));
  return dropCredentialShapes(plain).replaceAll(MASK_MARKS, ' ');
}

/** One line of at most {@link CONVERSATION_NAME_MAX} characters, or `undefined` when nothing is left. */
const oneLine = (text: string): string | undefined => {
  const line = plainOf(text).replaceAll(/\s+/gu, ' ').trim();
  return line === '' ? undefined : truncateText(line, CONVERSATION_NAME_MAX);
};

/** A message's opening as a row shows it (`preview`, `latest`): scrubbed like a title, on one line, not otherwise cut. */
export function scrubShown(text: string, scrub: ScrubText): string {
  return scrubTitleText(text, scrub).replaceAll(/\s+/gu, ' ').trim();
}

/**
 * A title somebody ELSE wrote (the CLI's, Codex's thread name, a ferret's own): scrubbed and put on one line. `undefined`
 * when nothing readable is left, so the next source of a title is used instead of an empty one.
 */
export function cleanTitle(text: string, scrub: ScrubText): string | undefined {
  return oneLine(scrubTitleText(text, scrub));
}

/**
 * How people open a request: a greeting, "can you", "please", "I need you to", "help me". A task title names the work, not the
 * asking, so these are cut from the start of each line before the title is made (a heading is left as written).
 */
const LEAD_IN =
  /^(?:(?:hey|hi|hello|ok|okay|so|um|well|right|alright|thanks|thank you)[\s,.!:-]+)*(?:(?:can|could|would|will) you (?:please |kindly )?|i (?:need|want|would like) you to |i(?:'d| would) like (?:you )?to |(?:please|pls|kindly)[\s,]+|(?:help me|let's|lets)[\s,]+(?:to )?|you should |we (?:need|have) to )*/iu;

const withoutLeadIn = (brief: string): string =>
  brief
    .split('\n')
    .map(line => (/^\s*#/u.test(line) ? line : line.replace(LEAD_IN, '')))
    .join('\n');

/**
 * A title made from the first thing the owner said: its first heading, else its first sentence that names work, at most five
 * words (`taskTitleFor`'s rule), from the text AFTER the scrub. The made title is scrubbed once more, as any title is.
 * `undefined` when nothing readable is left (the caller's fallback shows the message's own opening instead).
 */
export function deriveTitle(firstMessage: string, scrub: ScrubText): string | undefined {
  const brief = scrubTitleText(firstMessage.slice(0, TITLE_BRIEF_MAX), scrub);
  if (brief.replaceAll(/\s+/gu, '') === '') return undefined;
  const made = taskTitleFor(withoutLeadIn(brief), FALLBACK_LABEL);
  return FALLBACK_TITLE.test(made) ? undefined : cleanTitle(made, scrub);
}

/**
 * The title a transcript gives its conversation in the index: the CLI's own name (the owner's `/rename`, else the title the CLI
 * generated, already chosen by the describer), else a deterministic one from the first message. Always scrubbed.
 */
export function fileTitle(
  input: { readonly name?: string | undefined; readonly firstMessage?: string | undefined },
  scrub: ScrubText,
): string | null {
  const named = input.name === undefined ? undefined : cleanTitle(input.name, scrub);
  if (named !== undefined) return named;
  return (input.firstMessage === undefined ? undefined : deriveTitle(input.firstMessage, scrub)) ?? null;
}
