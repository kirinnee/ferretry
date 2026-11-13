/**
 * What a catalog REFUSES in a command line, an environment value or an address: the `publish` strength of the one
 * credential-word rule.
 *
 * The rule itself is not here. The word cutter (which part of a command-line word may not show) and the words that
 * name a credential are `@ferretry/std/credential-words`, ONE implementation shared with the kernel's read mask and
 * Runtimes' views. This file is a LAYER on it and holds no copy of it: it hands the std cutter a pair of tests (std's
 * narrow `secretNamed` and `looksSecret`, plus the rules below) and reads the result more widely. So a catalog refuses
 * everything the write rule refuses and everything std's secret-name words and token shapes catch; the one thing the
 * display hides that it accepts is a plain value under a name that only ENDS in key, token, secret or password. What
 * the layer adds:
 * - the names KEY, PASS, PWD, BEARER and BASIC, for a value of one unbroken piece of 16 or more (at the display they
 *   would hide a variable's NAME, `env_key="OPENROUTER_API_KEY"`, which Runtimes shows by design);
 * - the token formats a v4 catalog refused (`sk_test_`, `rk_live_`, `pk_live_`), and a token right after `/ ? & #`;
 * - for an argument or an environment value, a split reading that joins an announcing word to the value after it
 *   across `/ , ; ? & # " '`, and reads a word that holds white space as the words it holds;
 * - a whole `${secret:NAME}` environment value is a name, never a key, however long it is.
 *
 * A catalog is read by people who are not your devices, so a credential is REFUSED, never masked.
 *
 * Pure.
 */
import { SECRET_REFERENCE_SOURCE } from '@ferretry/std/secret-reference';
import {
  type CutterTests,
  findFlagSecrets,
  findRawSecrets,
  looksSecret,
  pointsElsewhere,
  SECRET_TOKEN_SOURCE,
  secretNamed,
  shownWordWith,
} from '@ferretry/std/credential-words';

/** A whole environment value that names a secret, and nothing else: a NAME, never a key, however long it is. */
const WHOLE_SECRET_PLACEHOLDER = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

/** The shortest value that can be a credential (the secret store's own floor). */
const MIN_VALUE_LENGTH = 8;

/** Name words that say a credential only at the `publish` strength. */
const PUBLISH_NAME_WORDS: ReadonlySet<string> = new Set(['KEY', 'PASS', 'PWD', 'BEARER', 'BASIC']);

/** What a `publish`-only name's value must be: ONE unbroken piece of 16 or more, the shape a v4 catalog refused. */
const PUBLISH_ANNOUNCED_VALUE = /^[^\s=&?#/:,;"'`]{16,}$/u;

/** Token formats a catalog refuses that the display's list does not carry, each a prefix and the body after it. */
const PUBLISH_TOKEN_FORMATS = [
  ['sk_test_', '[A-Za-z0-9_-]{8,}'],
  ['rk_(?:live|test)_', '[A-Za-z0-9_-]{8,}'],
  ['pk_live_', '[A-Za-z0-9_-]{8,}'],
] as const;

/** A value that starts like one of the {@link PUBLISH_TOKEN_FORMATS}. */
const PUBLISH_VALUE_PREFIX = new RegExp(`^(?:${PUBLISH_TOKEN_FORMATS.map(([prefix]) => prefix).join('|')})`, 'u');

/** Whether a name holds one of the words only `publish` reads (KEY, PASS, PWD, BEARER, BASIC), on word boundaries. */
const publishNamed = (name: string): boolean =>
  name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .some(word => PUBLISH_NAME_WORDS.has(word));

/**
 * The tests a catalog cuts by: std's NARROW fleet tests (`secretNamed`, `looksSecret`: the secret-name words and the
 * token shapes) OR the publish-only rules. The display ({@link SHOWN_TESTS}) widens the name test to any name that
 * merely ENDS in key, token, secret or password; a catalog does not, because the write rule refuses none of those on a
 * plain value and a v4 catalog took them (`--sort-key modified_time`, `PRIMARY_KEY=created_at_id`). That widened-tail
 * zone is the ONLY thing the display hides that a catalog accepts (docs/secrets.md); a real token under such a name
 * is still refused, by its shape. A value that only points elsewhere (`$NAME`, `${secret:NAME}`) and one shorter than
 * the store keeps are none.
 */
export const PUBLISH_TESTS: CutterTests = {
  namesSecret: name => secretNamed(name) || publishNamed(name),
  looksSecret: (name, value) =>
    looksSecret(name, value) ||
    (value.length >= MIN_VALUE_LENGTH &&
      !pointsElsewhere(value) &&
      (PUBLISH_VALUE_PREFIX.test(value) || (publishNamed(name) && PUBLISH_ANNOUNCED_VALUE.test(value)))),
};

/**
 * Whether std's WRITE rule (W) refuses the word `word` of a command line, read with the word before it. A catalog
 * refuses everything W refuses: W judges names the cutter's tests do not know (`tokens=Basic …`), and this is the net
 * that keeps the floor, so the cutter's answer is never the only one.
 */
const writeRuleRefuses = (word: string, before: string | undefined): boolean => {
  const args = before === undefined ? [word] : [before, word];
  return [...findFlagSecrets({ args }), ...findRawSecrets({ args })].some(found => found.path[1] === args.length - 1);
};

/** One command-line word as the catalog rule reads it. */
const judged = (word: string, before: string | undefined): boolean =>
  shownWordWith(PUBLISH_TESTS, word, before).hidden || writeRuleRefuses(word, before);

/** A token (of the display's formats or the publish-only ones) right after `/`, `?`, `&` or `#`, where no piece starts. */
const TOKEN_AFTER_BREAK = new RegExp(
  `(?<=[/?&#])(?:${[SECRET_TOKEN_SOURCE, ...PUBLISH_TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`)].join('|')})`,
  'gu',
);

/** The shortest token {@link TOKEN_AFTER_BREAK} counts: a path segment such as `/hf_transfer` is not a key. */
const TOKEN_AFTER_BREAK_MIN = 20;

/** Whether a word holds a token of {@link TOKEN_AFTER_BREAK_MIN} characters or more right after `/`, `?`, `&` or `#`. */
const holdsTokenAfterBreak = (word: string): boolean =>
  [...word.matchAll(TOKEN_AFTER_BREAK)].some(found => found[0].length >= TOKEN_AFTER_BREAK_MIN);

/**
 * The pieces a v4 catalog read a value in: split at white space and `= & ? # / : , ; " ' \``. The SAME characters the
 * 16-character value shape excludes, so a piece is always one unbroken run.
 */
const PUBLISH_PIECES = /[\s=&?#/:,;"'`]+/u;

/** One run of white space. */
const WHITE_SPACE = /\s+/u;

/** A text's words: what white space sets apart. */
const wordsOf = (text: string): readonly string[] => text.split(WHITE_SPACE).filter(word => word !== '');

/**
 * Whether a word the rule reads at `publish` holds a credential, however its words are glued: a bare secret-named piece
 * announces the unbroken piece of 16 or more after it, wherever a separator sets them apart (`--token,v`, `x/key/v`,
 * `x token v`). Only an ARG or an ENV value is read this way: an address or a command keeps the reading of its
 * words ({@link refusedLine}), so `/oauth/token/refresh-endpoint` is a path, not a key. A piece that only points
 * elsewhere (`$NAME`) holds none.
 */
function announcedPiece(text: string): boolean {
  const pieces = text.split(PUBLISH_PIECES).filter(piece => piece !== '');
  return pieces.some(
    (piece, index) =>
      index > 0 &&
      PUBLISH_ANNOUNCED_VALUE.test(piece) &&
      PUBLISH_TESTS.namesSecret(pieces[index - 1] as string) &&
      !pointsElsewhere(piece),
  );
}

/**
 * Whether the words of a text, each judged at `publish` with the word before it (the first with `first`), hold a
 * credential. The words are what white space sets apart, so a line break in an argument (`--port 1\n--token v`) does
 * not hide a flag from the rule.
 */
const wordsRefused = (text: string, first: string | undefined): boolean =>
  wordsOf(text).some(
    (word, index, all) => judged(word, index === 0 ? first : all[index - 1]) || holdsTokenAfterBreak(word),
  );

/**
 * Whether a command line holds a credential ANYWHERE, as a catalog reads it: the index of the first word refused, or
 * -1. `first` is the word before the first (an MCP command).
 *
 * It refuses AT LEAST what the display hides, and also what a v4 catalog refused: KEY, PASS, PWD, BEARER and BASIC names
 * with a value of 16 or more characters, a word that holds white space read as the words it holds, and an announcing
 * word joined to its value by `/ , ; ? & # " '`.
 */
export const firstRefusedWord = (words: readonly string[], first?: string): number =>
  words.findIndex((word, index) => {
    const before = index === 0 ? first : words[index - 1];
    return (
      judged(word, before) ||
      holdsTokenAfterBreak(word) ||
      wordsRefused(word, before) ||
      announcedPiece(before === undefined ? word : `${before} ${word}`)
    );
  });

/**
 * Whether one environment entry holds a credential written out. The entry is read as the flag `--x-NAME=value`, the
 * glued reading a launch flag has (the `x-` only so a name that starts with `_` is still a flag's), so its name is
 * judged as a flag's name is, a token anywhere in the value is cut, and a secret-named key nested in the value counts
 * (`NAME=Authorization: Bearer v`); and the value is also read as the words it holds and as the pieces after the name.
 * A whole `${secret:NAME}` pointer holds none, checked BEFORE the split reading (which would cut it at the colon and
 * read a long name as a key); a placeholder with anything glued to it is still read in full.
 */
export const envEntryRefused = (name: string, value: string): boolean =>
  !WHOLE_SECRET_PLACEHOLDER.test(value) &&
  (judged(`--x-${name}=${value}`, undefined) ||
    findRawSecrets({ [name]: value }).length > 0 ||
    findFlagSecrets({ [name]: value }).length > 0 ||
    holdsTokenAfterBreak(value) ||
    wordsRefused(value, undefined) ||
    announcedPiece(`${name} ${value}`));

/**
 * Whether a text a person reads as one command, address or id holds a credential: its words judged one by one, WITHOUT
 * the split reading of an argument. A path that merely contains a secret-named segment (`/oauth/token/refresh-endpoint`)
 * is accepted; `?key=v` and a token are refused.
 */
export const refusedLine = (text: string): boolean => wordsRefused(text, undefined);
