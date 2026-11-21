import { taskTitleFor } from '@ferretry/core-ferrets/contract';
import { SECRET_TOKEN_SOURCE, shownWord } from '@ferretry/std/credential-words';
import { CONVERSATION_NAME_MAX, CONVERSATION_PREVIEW_MAX } from '../../../contract/index.ts';
import { TITLE_BRIEF_MAX } from './conversation-text.ts';
import { endOnContent } from './title-words.ts';

/**
 * A CONVERSATION'S TITLE: the words a drawer row, a header, a notification and the Conversations list all show for it.
 *
 * A title travels further than a preview (it is stored in Ferrets' record and shown in places a message never is), so every
 * title, whoever wrote it, is SCRUBBED before it is stored: the vault's known values are masked ({@link ScrubText}, one
 * read-scoped batch), then every word that has the SHAPE of a credential or follows the NAME of one is dropped, because the
 * vault only knows the values it was told. The order is fixed: mask the WHOLE written text, THEN make it one line, THEN cut it
 * short, and what is shown keeps the owner's own glyphs (the text is made plain only to be matched, never to be shown). Nothing here calls a model: when the CLI wrote no title the words come from the first thing the owner said, by
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

/** The names of a password: its value is what follows, even with no separator (`passcode 4817 2951`). */
const PASS_WORD = String.raw`(?:pass[\s_-]?w(?:or)?d|pass[\s_-]?phrase|pass[\s_-]?code|\bpwd\b)`;
/** The words that name a credential (any case, any quoting around them: `"Password"`, `my_token`, `(bearer`). */
const CUE_WORD = String.raw`(?:${PASS_WORD}|token|secret|api[\s_-]?key|private[\s_-]?key|credential|bearer|authori[sz]ation)s?`;
/** What may close a quoted name before its value (`"password":`, `'token' =`, `“password” —`). */
const CUE_CLOSER = '["\'`”’)\\]}]*';
/**
 * A cue is a credential's NAME followed by a VALUE FORM: a separator (`:` `=` `=>` `->` `:=`, a dash) on the same line and then a
 * value (a word, a quoted value, a JSON `"password":"…"`, the value may start on the next line), or `is` / `was` / `to` / `are`
 * (with or without a `:` after it) and then a value, or, for a password's name only, a word with a digit right after it
 * (`passcode 4817 …`). The words after a cue cannot be told from the secret they hold (multiword, glued, after `is:`, across a
 * line), so a text that holds one is NEVER the source of a heuristic title. A bare mention (`Fix token refresh`, `Rotate the API
 * secret`, `password reset flow`) is a topic, not a cue.
 */
const CREDENTIAL_CUE = new RegExp(
  `${CUE_WORD}${CUE_CLOSER}(?:[ \\t]*(?:[:=]|->|[—–])\\s*\\S|\\s+(?:is|was|to|are)\\b[ \\t]*[:=]?\\s*\\S)|${PASS_WORD}${CUE_CLOSER}[ \\t]+\\S*\\d`,
  'iu',
);

/** Whether `text` (as written, or made plain: NFKC with the invisible characters out) holds a credential cue. */
export const hasCredentialCue = (text: string): boolean =>
  CREDENTIAL_CUE.test(text) || CREDENTIAL_CUE.test(matchViewOf(text).plain);

/** The marks a vault leaves where a value was (`[redacted]`, `[redacted:NAME]`, `${secret:NAME}`): never words of a title. */
const MASK_MARKS = /\[redacted(?::[^\]\s]*)?\]|\$\{secret:[^}\s]*\}/giu;

/** A private key or certificate block, from its BEGIN line to its END line, or to the end of the text when the END was cut off. */
const KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|SIGNATURE)[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/gu;

/** `Authorization`-style: the word after Bearer / Basic / Token is the credential. */
const SCHEME_THEN_CREDENTIAL = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu;

/** A word that names a credential and carries its value glued to it: `TOKEN=…`, `password:…`, `--api-key=…`, `?access_token=…`. */
const NAMED_CREDENTIAL =
  /^[\w.-]*(?:token|secret|passw(?:or)?d|passwd|passphrase|passcode|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[\w.-]*["'`]?[=:]\S+/iu;

/** A word that NAMES a credential (its value is the next word, after a `:`, `=` or `is`). `STRONG` is the names that are never plain English. */
const STRONG_NAME =
  /(?:token|secret|passw(?:or)?d|passwd|passphrase|passcode|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|secret[_-]?key)/iu;
const WEAK_NAME = /(?:auth|credential)/iu;
/** `key` is a credential's name only after one of these (`api key is …`, `ssh key: …`). */
const KEY_QUALIFIER = /^(?:api|secret|private|access|ssh|signing)$/iu;
const SEPARATOR_WORD = /^(?:[=:]|:=|=>)$/u;

/** Where a word's own name+value can begin inside it: after a URL's `?` or `&`, a quote, a bracket, a comma. (Anchored per piece: an unanchored scan of one long word is quadratic.) */
const PIECE_START = /[?&;,#([{"'`]/gu;

/** Whether the word, or a piece of it after one of those marks, is a credential's name glued to its value (`url?access_token=x`). */
const namedValue = (word: string): boolean =>
  NAMED_CREDENTIAL.test(word) ||
  [...word.matchAll(PIECE_START)].some(mark => NAMED_CREDENTIAL.test(word.slice(mark.index + 1)));

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
  if (core.length < 8) return namedValue(word);
  if (KNOWN_TOKEN.test(word) || SPECIAL_TOKEN.test(core) || namedValue(word) || URL_PASSWORD.test(word)) return true;
  if (LONG_HEX.test(core)) return true;
  // A long mixed run with a digit and a letter is a key, not a word; a plain long word (`internationalisation`) has no digit.
  return !PATH_WORD.test(word) && KEY_RUN.test(core) && /\d/u.test(core) && /\p{L}/u.test(core);
}

/** A text as it is MATCHED, with where each of its characters came from in the text as it was WRITTEN. */
interface MatchView {
  readonly plain: string;
  /** For each UTF-16 unit of `plain`, the span of the original text it came from. */
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/**
 * `text` made plain for matching (`NFKC`, the invisible and control characters out, per character) with the position of every
 * plain character in the original. A match is found in the plain text and cut out of the ORIGINAL, so what is shown keeps the
 * owner's own glyphs: nothing is normalised in what is shown, ever.
 */
function matchViewOf(text: string): MatchView {
  let plain = '';
  const from: number[] = [];
  const to: number[] = [];
  let index = 0;
  for (const character of text) {
    const start = index;
    index += character.length;
    for (const normal of character.normalize('NFKC')) {
      const code = normal.codePointAt(0) ?? 0;
      const kept = normal === '\n' || normal === '\t' || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f));
      if (!kept || INVISIBLE.some(([low, high]) => code >= low && code <= high)) continue;
      for (let unit = 0; unit < normal.length; unit += 1) {
        from.push(start);
        to.push(index);
      }
      plain += normal;
    }
  }
  return { plain, from, to };
}

/** A word's letters and digits and the joiners of a name, with its punctuation off both ends (`"API_KEY:"` is `API_KEY`). */
const nameCore = (word: string): string => word.replaceAll(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_-]+$/gu, '');

/** Whether the word at `index` names a credential, and how surely: `2` never plain English, `1` can be (`auth`). */
function namesCredential(words: readonly string[], index: number): 0 | 1 | 2 {
  const core = nameCore(words[index] ?? '');
  if (core === '') return 0;
  if (STRONG_NAME.test(core)) return 2;
  if (/^key$/iu.test(core) && KEY_QUALIFIER.test(nameCore(words[index - 1] ?? ''))) return 2;
  return WEAK_NAME.test(core) ? 1 : 0;
}

/** The [start, end) spans of `plain` that are credentials: key blocks, scheme+credential, and each credential-shaped or credential-named word. */
function credentialSpans(plain: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = [];
  for (const block of plain.matchAll(KEY_BLOCK)) spans.push([block.index, block.index + block[0].length]);
  for (const scheme of plain.matchAll(SCHEME_THEN_CREDENTIAL))
    spans.push([scheme.index, scheme.index + scheme[0].length]);
  const words = [...plain.matchAll(/\S+/gu)].map(word => ({ text: word[0], start: word.index }));
  const texts = words.map(word => word.text);
  words.forEach((word, position) => {
    const before = texts[position - 1];
    let hidden = looksLikeCredential(word.text) || shownWord(word.text, before).hidden;
    // A passphrase or password is often several words and nothing marks where it ends: the value of one is every word to the end
    // of its line (over-masking is the safe side), masked here, before any clause is cut or any title is made.
    let toLineEnd = false;
    if (!hidden && before !== undefined) {
      // The value of a named credential: `password: X` / `API_KEY= X` (the separator glued to the name), `API_KEY = X` / `token : X`
      // (its own word), `password is X` (a name that is never plain English only).
      // The separator may sit on either side of the space: `password: X` (glued to the name) or `password :X` (glued to the value).
      const glued =
        namesCredential(texts, position - 1) > 0 && (/[=:]$/u.test(before) || /^(?:=>|:=|[=:])\S/u.test(word.text));
      const named = position > 1 ? namesCredential(texts, position - 2) : 0;
      const apart = named > 0 && SEPARATOR_WORD.test(before);
      const saying = named === 2 && /^is$/iu.test(before);
      hidden = glued || apart || saying;
      const name = glued ? before : texts[position - 2];
      toLineEnd = hidden && MULTIWORD_NAME.test(nameCore(name ?? ''));
    }
    if (!hidden) return;
    const lineEnd = plain.indexOf('\n', word.start);
    spans.push([word.start, toLineEnd ? (lineEnd < 0 ? plain.length : lineEnd) : word.start + word.text.length]);
  });
  return spans;
}

/** Names whose value is words, not one token: a passphrase, a password, a token said as a phrase (`API_KEY` and the like are one token). */
const MULTIWORD_NAME = /passphrase|passcode|passw(?:or)?d|passwd|pwd|token/iu;

/** `text` with the given spans of its PLAIN form blanked in the ORIGINAL (the glyphs around them untouched). */
function blank(text: string, view: MatchView, spans: readonly (readonly [number, number])[], hole: string): string {
  const cuts = spans
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [view.from[start] ?? 0, view.to[end - 1] ?? text.length] as const)
    .toSorted((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of cuts) {
    if (end <= at) continue;
    out += `${text.slice(at, Math.max(at, start))}${hole}`;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * `text` with every secret masked, the owner's own glyphs and line breaks as written: the vault's values first (in the text as
 * written, then once more in its plain form, so a value spelled in another form is still found), then every key block, scheme
 * credential and word that has the SHAPE of a credential or follows the NAME of one (`API_KEY = …`, `password: …`,
 * `password is …`, `?token=…`), then the vault's own marks. Matching runs on the plain form; only the matches are cut, from the
 * original. A value the plain form reveals is masked in the plain form itself (the one case a glyph is not kept: it hid a secret).
 * Each masked place becomes `hole` (a space unless the caller wants to SEE where a secret was, as a fallback title does).
 */
export function maskText(text: string, scrub: ScrubText, hole = ' '): string {
  const masked = scrub(text);
  let view = matchViewOf(masked);
  let source = masked;
  const rescrubbed = scrub(view.plain);
  if (rescrubbed !== view.plain) {
    source = rescrubbed;
    view = matchViewOf(source);
  }
  return blank(source, view, credentialSpans(view.plain), hole).replaceAll(MASK_MARKS, hole);
}

const NO_SCRUB: ScrubText = text => text;

/** `text` with every credential-shaped word and any private-key block removed (no vault): the shape rules alone. */
export const dropCredentialShapes = (text: string): string => maskText(text, NO_SCRUB);

/** Control characters other than the line breaks and the tab (those are whitespace): none belongs in a title or a row. */
const withoutControls = (text: string): string =>
  Array.from(text)
    .filter(character => {
      const code = character.codePointAt(0) ?? 0;
      return (
        character === '\n' ||
        character === '\t' ||
        character === '\r' ||
        !(code < 0x20 || (code >= 0x7f && code <= 0x9f))
      );
    })
    .join('');

/** `line` cut to `max` UTF-16 units on a character boundary, the cut marked. */
const clip = (line: string, max: number): string => {
  if (line.length <= max) return line;
  let out = '';
  for (const character of line) {
    if (out.length + character.length > max - 1) break;
    out += character;
  }
  return `${out.trimEnd()}…`;
};

/** One text as a row shows it: masked from the WHOLE written text, THEN on one line, THEN cut to `max`. `undefined` when nothing is left. */
function shown(text: string, scrub: ScrubText, max: number): string | undefined {
  const line = withoutControls(maskText(text, scrub)).replaceAll(/\s+/gu, ' ').trim();
  return line === '' ? undefined : clip(line, max);
}

/**
 * A message's opening as a row shows it (`preview`, `latest`): masked from the whole message, then on one line, then cut to the
 * preview length; the owner's glyphs kept. Empty when nothing readable is left (the caller never lists an empty `latest`).
 */
export const scrubShown = (text: string, scrub: ScrubText): string =>
  shown(text, scrub, CONVERSATION_PREVIEW_MAX) ?? '';

/**
 * A title somebody ELSE wrote (the CLI's, Codex's thread name, a ferret's own): masked from the whole text, put on one line and
 * cut. `undefined` when nothing readable is left, so the next source of a title is used instead of an empty one.
 */
export const cleanTitle = (text: string, scrub: ScrubText, by: TitleAuthor = 'generated'): string | undefined =>
  by === 'generated' && hasCredentialCue(text) ? undefined : shown(text, scrub, CONVERSATION_NAME_MAX);

/**
 * Who wrote a title. A GENERATED one (the CLI's, a ferret's automatic one) that holds a credential cue is dropped whole; an
 * OWNER's (`/rename`, a title the owner typed) is the owner's data and is never dropped for a cue, only masked like any other.
 * The caller says which: nothing here guesses.
 */
export type TitleAuthor = 'owner' | 'generated';

/**
 * How people open a request: a greeting, "can you", "please", "I need you to", "help me". A task title names the work, not the
 * asking, so these are cut from the start of each line before the title is made (a heading is left as written).
 */
const LEAD_IN =
  /^(?:(?:hey|hi|hello|ok|okay|so|um|well|right|alright|thanks|thank you)[\s,.!:-]+)*(?:(?:can|could|would|will) you (?:please |kindly )?|(?:i|we) (?:need|want|would like|have) (?:you )?to |i(?:'d| would) like (?:you )?to |(?:please|pls|kindly)[\s,]+|(?:help me|let's|lets)[\s,]+(?:to )?|you should |here(?:'s| is) my |use (?:it|this|that|them) to |look (?:at|into) (?=(?:why|how|what|whether|if)\b)|(?:why|whether) (?:is |are |does |do )?|what (?:is|are) (?:the )?)*/iu;

/** A list item's marker (`-`, `*`, `1.`, a task box): the request starts after it, so the lead-in is cut from there. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u;

const withoutLeadIn = (brief: string): string =>
  brief
    .split('\n')
    .map(line => (/^\s*#/u.test(line) ? line : line.replace(LIST_MARKER, '').replace(LEAD_IN, '')))
    .join('\n');

/** "the difference between X and Y" is a question about two things: it is titled `X vs Y`. */
const DIFFERENCE =
  /(?:\bthe\s+)?\bdifferences?\s+between\s+(?:an?\s+|the\s+)?([^.,;?!]+?)\s+and\s+(?:an?\s+|the\s+)?([^.,;?!]+?)(?=\s*(?:[.,;?!]|$)|\s+(?:in|for|when|if|on|with)\b)/iu;

/** A line cut where its first clause ends (`then`, or `and` once five words are said), after two words: a title names one piece of work. */
function atClauseEnd(line: string): string {
  const words = line.trim().split(/\s+/u);
  // `and` joins two things inside a short clause (`Compare Firefox and Chrome`), so it ends one only after a whole title's worth.
  const end = words.findIndex(
    (word, index) => index >= 2 && (/^then$/iu.test(word) || (index >= 5 && /^and$/iu.test(word))),
  );
  return end < 0 ? line : words.slice(0, end).join(' ');
}

/** What a message that is only a greeting or thanks is titled: it names no work yet. */
const GREETING_ONLY = /^(?:(?:hey|hi|hello|yo|ok|okay|thanks|thank you|thx)[\s,.!?-]*)+$/iu;
const GREETING_TITLE = 'New conversation';

/**
 * A title made from the first thing the owner said: its first heading, else its first sentence that names work, at most five
 * words (`taskTitleFor`'s rule), from the text AFTER the scrub. The made title is scrubbed once more, as any title is.
 * `undefined` when nothing readable is left (the caller's fallback shows the message's own opening instead).
 */
export function deriveTitle(firstMessage: string, scrub: ScrubText): string | undefined {
  // FAIL CLOSED: a message that names a credential makes no heuristic title (the masking below is the second layer, not the first).
  if (hasCredentialCue(firstMessage)) return undefined;
  // Masked from the WHOLE message, then cut to what a title reads: a value that crosses the cut is gone before it.
  const brief = withoutControls(maskText(firstMessage, scrub, HOLE))
    .slice(0, TITLE_BRIEF_MAX)
    .replace(/[\uD800-\uDBFF]$/u, '');
  if (brief.replaceAll(/[\s\uE000]+/gu, '') === '') return undefined;
  if (GREETING_ONLY.test(brief.trim())) return GREETING_TITLE;
  // A place where a secret was is an edge, never a join: each side is read on its own, and the first that reads as work wins.
  const pieces = brief
    .split(HOLE)
    .map(piece => piece.trim())
    .filter(piece => piece !== '');
  const split = brief.includes(HOLE);
  const titles = pieces.flatMap(piece => {
    const made = madeTitle(piece);
    return made === undefined || (split && LONE_ASCII_WORD.test(made)) ? [] : [made];
  });
  const made = titles.find(title => title.split(' ').length >= 3) ?? titles[0];
  return made === undefined ? undefined : cleanTitle(made, scrub);
}

/** One plain word: beside a scrubbed secret it says nothing (`Use`, `Key`). A script written without spaces is one word and still says something. */
const LONE_ASCII_WORD = /^[\x21-\x7e]+$/u;

/** Where a scrubbed secret was, while a title is made (a private-use character: never typed, never shown). */
const HOLE = '\uE000';

/** One stretch of the owner's words as a title: opening filler off, five words at most, ending on a content word. */
function madeTitle(piece: string): string | undefined {
  const opened = withoutLeadIn(piece);
  const versus = DIFFERENCE.test(opened);
  const lines = (versus ? opened.replace(DIFFERENCE, '$1 vs $2') : opened).split('\n').map(atClauseEnd);
  const made = taskTitleFor(lines.join('\n'), FALLBACK_LABEL);
  if (FALLBACK_TITLE.test(made)) return undefined;
  const ended = endOnContent(made);
  return versus && ended !== undefined ? ended.replace(/ Vs /u, ' vs ') : ended;
}

/**
 * The title a transcript gives its conversation in the index: the CLI's own name (the owner's `/rename`, else the title the CLI
 * generated, already chosen by the describer), else a deterministic one from the first message. Always scrubbed.
 */
export function fileTitle(
  input: {
    readonly name?: string | undefined;
    /** Who gave `name`; the CLI's when not said (fail closed). */
    readonly nameBy?: TitleAuthor | undefined;
    readonly firstMessage?: string | undefined;
  },
  scrub: ScrubText,
): string | null {
  const named = input.name === undefined ? undefined : cleanTitle(input.name, scrub, input.nameBy);
  if (named !== undefined) return named;
  if (input.firstMessage === undefined) return null;
  const made = deriveTitle(input.firstMessage, scrub);
  if (made !== undefined) return made;
  // A first message that names a credential gets the plain fallback title, never its own opening (the preview the row would
  // otherwise be named by may still hold the unmasked tail of a multiword value).
  return hasCredentialCue(input.firstMessage) ? UNTITLED_TITLE : null;
}

/** What a conversation is called when the only thing to name it by is a message that names a credential. */
export const UNTITLED_TITLE = 'Conversation';
