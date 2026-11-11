/**
 * CFG-LEAK: the ONE word cutter and the write rule (W) of `@ferretry/std/credential-words`, over one corpus. The
 * kernel's read mask and Runtimes' views both import this cutter (there used to be two copies pinned equal by an
 * agreement test; there is one now, so there is nothing to keep equal). The corpus is the whole generated family of
 * ruling #40 (`../support/command-line-family.ts`), the cases a person writes, and a generated block of every
 * credential-naming word and token format.
 *
 * The CORPUS test (T-B1) holds that the cutter really cuts it. T-B2 holds the write rule (W, `findFlagSecrets`) under
 * the cutter, strictly: EVERY word W refuses is cut, residual 0 over THIS corpus (a pointer, then keys of its own, then
 * raw text included); the F1-F7 families, which are outside it, are not cut by the cutter and are held by the NET in each
 * consumer (`shownConfigText`'s `unmaskable`, Runtimes' withheld views). Its corpus comes from W's own name tail, not
 * from the cutter's name list: a candidate name is in it exactly when W refuses it, so a name only W knows is in it. A
 * W-only widening onto a name outside CANDIDATE_NAMES is not seen.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { firstRefusedWord } from '../../../core/vault/contract/lib/command-line.ts';
import {
  type CutterTests,
  findFlagSecrets,
  findRawSecrets,
  looksSecret,
  SECRET_TOKEN_SOURCE,
  secretNamed,
  SHOWN_TESTS,
  shownWords,
  shownWordWith,
} from '../../src/credential-words/index.ts';
import { nestedFamily } from '../support/command-line-family.ts';

/** A 16-character value of 16 distinct characters: past every length and entropy gate, and no known shape. */
const VALUE = 'Zk3pQ9vXw2LmN7rT';
const OTHER_VALUE = 'Hy8cBt4Fg6SdJ1uE';
const SHORT_PASSWORD = 'hunter2024';
const POINTER = '${secret:X}';

/** Where a credential's value goes: the flag forms and the key forms W reads (review r3: B1, the class). */
const VALUE_LEADS: readonly ((value: string) => readonly string[])[] = [
  value => ['--key', value],
  value => ['--ssh-key', value],
  value => ['--token', value],
  value => [`--token=${value}`],
  value => [`--api-key=${value}`],
  value => ['-e', `KEY=${value}`],
  value => ['-e', `API_KEY=${value}`],
  value => [`-eAPI_KEY=${value}`],
  value => [`API_KEY=${value}`],
  value => [`Authorization: ${value}`],
  value => [`--header=Authorization: Bearer ${value}`],
  value => [`--env=SIGNING_KEY=${value}`],
];

/** A value that holds a pointer and raw text in ANOTHER piece of it (before, glued, a harmless key's value, a `#` after). */
const POINTER_VALUES: readonly ((mark: string) => string)[] = [
  mark => `a${mark}${VALUE}${mark}${POINTER}`,
  mark => `a${mark}${POINTER}${mark}${VALUE}`,
  mark => `a=1${mark}${POINTER}${mark}${VALUE}`,
  mark => `x${POINTER}${mark}${VALUE}`,
  mark => `prefix${POINTER}${mark}${VALUE}`,
  mark => `${POINTER}x${mark}${VALUE}`,
  mark => `${POINTER}${mark}b=${VALUE}`,
  mark => `${POINTER}${mark}b:${VALUE}`,
  mark => `${POINTER}${mark}b=x${VALUE}`,
  mark => `${POINTER}${mark}b="${VALUE}"`,
  mark => `${POINTER}${mark}${VALUE}=x`,
  mark => `${POINTER}${mark}${VALUE}:x`,
  mark => `${POINTER}${mark}${mark}${VALUE}`,
  mark => `${POINTER}${POINTER}${mark}${VALUE}`,
  mark => `${POINTER}${mark}#${VALUE}`,
  mark => `${POINTER}#${mark}${VALUE}`,
  mark => `${POINTER}${mark}b=2#${VALUE}`,
  mark => `${POINTER}?b=2${mark}${VALUE}`,
];

/** Every value shape x mark x lead: W refuses each whole, so each is cut whole by both cutters (the class, not one shape). */
const POINTER_CLASS_LINES: readonly (readonly string[])[] = [',', ';', '&'].flatMap(mark =>
  POINTER_VALUES.flatMap(shape => VALUE_LEADS.map(lead => lead(shape(mark)))),
);

/** The cases `credential-words.test.ts` pins, and the lines a person writes. */
const OWN_LINES: readonly (readonly string[])[] = [
  ...POINTER_CLASS_LINES,
  // No pointer, so no whole-value cut: a quoted value's own cut ends at its closing quote (`,b=2` after it stays shown).
  [`--set=API_KEY="${VALUE},more${OTHER_VALUE}",b=2`, '--key', `"${VALUE},more${OTHER_VALUE}",b=2`],
  ['--token', VALUE],
  ['--token', '${secret:GH_TOKEN}'],
  ['--token-file', '~/.config/tool/token'],
  ['--auth-mode', 'browser-login'],
  ['-p', 'hunter2'],
  [`--client-secret=${VALUE}`, '-e', `API_KEY=${VALUE}`],
  [`--header=Authorization: Bearer ${VALUE}`],
  [`https://alice:${SHORT_PASSWORD}@host.example/path?token=${OTHER_VALUE}`],
  ['--api-key=$MY_KEY', '--password=${DB_PASS}', '--password', '${secret:DB_PW}'],
  ['-Hghp_AbCdEfGh12345678=sk-AbCdEfGh12345678'],
  ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'plain', ''],
  [],
  [`API_KEY="${VALUE},${VALUE}"`],
  [`API_KEY=a:'${VALUE},x'`],
  [`API_KEY="${VALUE}`],
  [`API_KEY=${VALUE} ${POINTER}`],
  [`API_KEY=${POINTER} ${VALUE}==`],
  [`API_KEY=${POINTER} API_KEY=${VALUE}`],
  [`API_KEY=${VALUE} ${POINTER} API_KEY=${VALUE}`],
  [`Authorization: Basic ${VALUE}== X=${POINTER}`],
  [`Authorization: user:${VALUE} ${POINTER}`],
  [`PASSWORD=${POINTER}?password:${VALUE}`],
  ['API_KEY=$FOO-bar-baz-qux ${secret:X}'],
  ['API_KEY=${FOO_BAR ${secret:X}'],
  ['API_KEY=$FOO_BAR_BAZ ${secret:X}', 'API_KEY=${FOO_BAR_BAZ} ${secret:X}'],
  [`password=Basic ${VALUE}#${POINTER}`],
  [`https://u:${VALUE}@h.example/?token=${VALUE}x`],
  ['https://u:p@ss@h.example/path'],
  [`API_KEY=${POINTER} https://u:${VALUE}@h.example/p`],
  [`PASSWORD=https://u:${VALUE}@h.example/p`],
  ['--token', `${VALUE} ${POINTER}`],
  ['--token', `${POINTER} ${VALUE}`],
  ['--password', `Basic ${VALUE}#${POINTER}`],
  [`--hdr,api_key:${VALUE} more`],
  [`-cAPI_KEY:${VALUE},PASSWORD=${VALUE}x`],
  [`API_KEY=${POINTER}`, 'API_KEY=$HOME_KEY', 'API_KEY=${HOME_KEY}', 'AUTH=1', 'password=short'],
  // PIECE_BREAK gaps (a `;` and a `,` set a token apart from the text before it).
  ['--x=foo;ghp_AbCdEfGh12345678'],
  ['--x=foo,ghp_AbCdEfGh12345678'],
  // A token in a secret-named flag's own part.
  [`--verbose;AKIAABCDEFGHIJKLMNOP,tokens ${VALUE}`, `--x;ghp_AbCdEfGh12345678,token=${VALUE}`],
  // Text glued to a pointer (CFG-LEAK-R ii): cut; a pointer alone stays shown.
  ['API_KEY=prefix${secret:X}', '--token', 'prefix${secret:X}', 'API_KEY=${secret:X}?model=short'],
  ['--header=Authorization: Bearer v${secret:X}', '--token=prefix${secret:X}', `API_KEY=${VALUE}${POINTER}`],
  [
    'API_KEY="${secret:X}"',
    '--token',
    '${secret:X}${secret:Y}',
    'API_KEY=a:${secret:X}',
    'Authorization: Bearer ${secret:X}',
  ],
  // A pointer, then a `,` `;` or `&` that ends a key's value, then raw text: glued, cut (reviewer r2); a key of its own
  // after the separator is not glued (`--set=a=1,API_KEY=${secret:X},b=2` stays, ruling #40).
  ...[',', ';', '&'].flatMap(mark => [
    ['--key', `${POINTER}${mark}${VALUE}`],
    [`--token=${POINTER}${mark}${VALUE}`],
    ['-e', `KEY=${POINTER}${mark}${VALUE}`],
    [`Authorization: ${POINTER}${mark}${VALUE}`],
    [`--header=Authorization: Bearer ${POINTER}${mark}${VALUE}`],
    ['--key', `${POINTER}${mark}gsk_AbCdEfGhIjKlMnOpQrSt12`],
    [`--set=a=1,API_KEY=${POINTER}${mark}b=2`],
    // …and one, two or three keys of its own after it, then raw text: the text after a key's value is glued all the same.
    ['--key', `${POINTER}${mark}b=2${mark}${VALUE}`],
    [`--token=${POINTER}${mark}b=2${mark}${VALUE}`],
    ['-e', `KEY=${POINTER}${mark}b=2${mark}${VALUE}`],
    [`Authorization: ${POINTER}${mark}b=2${mark}${VALUE}`],
    [`--header=Authorization: Bearer ${POINTER}${mark}b=2${mark}${VALUE}`],
    ['--key', `${POINTER}${mark}k=v${mark}k2=v2${mark}${VALUE}`],
    ['--key', `${POINTER}${mark}k=v${mark}k2=v2${mark}k3=v3${mark}${VALUE}`],
    ['--key', `${POINTER}${mark}b="x${mark}y"${mark}${VALUE}`],
    ['--key', `${POINTER}${mark}b='x${mark}y'${mark}gsk_AbCdEfGhIjKlMnOpQrSt12`],
    [`--set=a=1,API_KEY=${POINTER}${mark}b=2${mark}${VALUE}`],
    [`-cAPI_KEY:${POINTER}${mark}b=2${mark}c=3${mark}${VALUE}`],
  ]),
];

/** A word with blanks that does not START with a flag: both cutters show it, and W reads its blank-split words. */
const BLANK_WORD_LINES: readonly (readonly string[])[] = [[`srv --token ${VALUE}`]];

/** Every word that says a name holds a credential, every pair of words that says so, and every token format by value. */
const NAME_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'cookie',
  'pat',
];
const NAME_PAIRS = ['api_key', 'access_key', 'private_key', 'secret_key', 'api-key', 'ACCESS_KEY'];
const TOKEN_VALUES = [
  'sk-AbCdEfGh12345678',
  'sk_live_AbCdEfGh12345678',
  'ghp_AbCdEfGh12345678',
  'gho_AbCdEfGh12345678',
  'github_pat_AbCdEfGh12345678',
  'glpat-AbCdEfGh12345678',
  'xoxb-AbCdEfGh12345678',
  'xoxp-AbCdEfGh12345678',
  'AKIAABCDEFGHIJKLMNOP',
  'ASIAABCDEFGHIJKLMNOP',
  'AIzaAbCdEfGh12345678',
  'npm_AbCdEfGh12345678',
  'hf_AbCdEfGh12345678',
  'ya29.AbCdEfGh12345678',
  'eyJhbGciOiJIUzI1NiJ9',
];
/** Values from one under the secret store's shortest (7) to 16 characters: the length edge of every rule, both sides. */
const LENGTH_LINES: readonly (readonly string[])[] = Array.from({ length: 11 }, (_, index) =>
  VALUE.slice(0, 6 + index),
).flatMap(value => [
  ['--token', value],
  [`--password=${value}`],
  [`API_KEY=${value}`],
  [`https://u:${value}@h.example/p`],
  [`Authorization: Bearer ${value}`],
]);
const GENERATED_LINES: readonly (readonly string[])[] = [
  ...LENGTH_LINES,
  ...[...NAME_WORDS, ...NAME_PAIRS].flatMap(name => [
    [`--${name}`, VALUE],
    [`--${name}=${VALUE}`],
    [`${name.toUpperCase()}=${VALUE}`],
    ['-e', `${name}: ${VALUE}`],
    [`https://u:p@h.example/?${name}=${VALUE}`],
  ]),
  ...TOKEN_VALUES.flatMap(token => [[token], ['--anything', token], [`--x=${token}`], [`pre ${token} post`]]),
];

/**
 * Names to ask W about: every one W's tail test refuses becomes lines in the corpus (all three forms, a fake value), and
 * the ones it does not are here to catch W being widened onto them (`model`, `signing`, `level` …).
 */
const CANDIDATE_NAMES = [
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'passwds',
  'credential',
  'credentials',
  'apitoken',
  'authtoken',
  'sessiontoken',
  'clientsecret',
  'client-secret',
  'ssh-key',
  'signing-key',
  'encryption-key',
  'license-key',
  'master-key',
  'api-key',
  'public-key',
  'access-keys',
  'db_password',
  'auth',
  'model',
  'signing',
  'level',
  'name',
  'mode',
  'token-file',
  'auth-mode',
  'keyboard',
  'monkey',
  'secretary',
  'keyring',
  'tokenizer',
  'passwordless',
  'host',
  'x',
];

/** The three forms a flag takes with a value: after a space, glued by `=`, and `-e NAME=v`. */
const formsOf = (name: string): readonly (readonly string[])[] => [
  [`--${name}`, VALUE],
  [`--${name}=${VALUE}`],
  ['-e', `${name.toUpperCase().replaceAll('-', '_')}=${VALUE}`],
];

/** The lines of every candidate name W (`findFlagSecrets`) refuses: W's own name tail, read off W itself. */
const writeRuleLines = (): readonly (readonly string[])[] =>
  CANDIDATE_NAMES.flatMap(formsOf).filter(words => findFlagSecrets({ args: words }).length > 0);

/** The ONE corpus. */
const corpus = (): readonly (readonly string[])[] => [
  ...nestedFamily().map(item => item.words),
  ...OWN_LINES,
  ...BLANK_WORD_LINES,
  ...GENERATED_LINES,
  ...writeRuleLines(),
];

/** Every word of `lines` W refuses, and whether the cutter cut it: `[words, index, cut]`. `first` is the command before. */
function refusedWords(
  lines: readonly (readonly string[])[],
  withFirst = false,
): readonly (readonly [words: readonly string[], at: number, cut: boolean])[] {
  return lines.flatMap(words => {
    // W first, then the cutter only on a line W refuses a word of: the other lines were 2.4 s of the test's 3 s (now 0.7).
    const findings = findFlagSecrets({ args: words });
    if (findings.length === 0) return [];
    const shown = withFirst ? shownWords(words.slice(1), words[0]) : shownWords(words);
    return findings.map(finding => {
      const at = (finding.path[1] as number) - (withFirst ? 1 : 0);
      return [words, at, shown[at]?.hidden === true] as const;
    });
  });
}

describe('CFG-LEAK the one word cutter, over the corpus', () => {
  // Measured alone with --coverage (bun 1.4.4): the corpus is thousands of lines cut once, so it is the cutter's own
  // cost, not a wait; the limit is set from the measured numbers recorded in the step-4 report (the old test cut every
  // line twice and took 2.75 / 2.88 / 3.31 s, so a limit of 10 s is generous for half the work).
  it('CFG-LEAK-R the cutter cuts the corpus: a body of lines hides a word, and none throws', () => {
    const lines = corpus();
    should(nestedFamily().length).be.above(500);
    const shown = lines.map(words => shownWords(words));
    // The corpus really cuts: the cutter is not answering "nothing" for all of it.
    should(shown.filter(line => line.some(word => word.hidden)).length).be.above(400);
    // …and a hidden word is never the word as written (a cut changes the text).
    should(
      lines.filter((words, at) => shown[at]?.some((word, index) => word.hidden && word.text === words[index])),
    ).eql([]);
  }, 10_000);

  // Same cost class as above: the corpus is read once more, with the command before the first word.
  it('CFG-LEAK-R a command’s own flag before the first word: every word W refuses is cut', () => {
    const lines = corpus().filter(line => line.length > 0);
    const missed = refusedWords(lines, true)
      .filter(([, , cut]) => !cut)
      // A line whose OWN first word is what W refuses is judged without a command before it: not this test's.
      .filter(([words, at]) => at >= 0 && words.length > 1);
    // The first word stands before the rest, so the words after it are judged with it as their `before`: nothing W
    // refuses in them may show, however the first word reads.
    should(missed.length).equal(0);
  }, 10_000);

  it('S6 CFG-LEAK-W every word W refuses is cut by the cutter: residual 0 over this corpus', () => {
    // One word with blanks that does not start with a flag (`srv --token v`) is read as a command line by the kernel's
    // `shownItem` (and a Runtimes list is netted by W), not by `shownWord`, so it is not this test's.
    const writeRule = writeRuleLines();
    const lines = [...nestedFamily().map(item => item.words), ...OWN_LINES, ...GENERATED_LINES, ...writeRule];
    const refused = refusedWords(lines);
    // W refuses a good share of the corpus, and the names only W's tail knows are in it (--key, --ssh-key, --tokens …).
    should(refused.length).be.above(1000);
    const names = new Set(writeRule.map(words => words.join(' ')));
    should(names.size).be.above(60);
    const missed = refused.filter(([, , cut]) => !cut).map(([words, at]) => [words, at]);
    should(missed).eql([]);
  });

  it('S6 CFG-LEAK-W W’s own name tail is in the corpus: every name it refuses is, and the ones it does not are not', () => {
    const refusedNames = new Set(
      writeRuleLines()
        .filter(words => words[0]?.startsWith('--') === true && words.length === 2)
        .map(words => (words[0] as string).slice(2)),
    );
    for (const name of [
      'key',
      'keys',
      'tokens',
      'secrets',
      'passwords',
      'apitoken',
      'clientsecret',
      'ssh-key',
      'signing-key',
    ])
      should([name, refusedNames.has(name)]).eql([name, true]);
    for (const name of ['model', 'signing', 'level', 'token-file', 'host', 'x'])
      should([name, refusedNames.has(name)]).eql([name, false]);
  });

  // The cutter takes its two tests as a parameter so a reader that refuses more (a catalog's publish) is the SAME cutter
  // with a wider pair (britnee #41). Two pins over this one corpus, each command before the first word as well.
  it('CFG-LEAK-R shownWord is literally shownWordWith(SHOWN_TESTS): deep-equal over the whole corpus', () => {
    for (const words of corpus())
      for (const first of [undefined, '--token', '--model']) {
        should(shownWords(words, first)).eql(
          words.map((word, at) => shownWordWith(SHOWN_TESTS, word, at === 0 ? first : words[at - 1])),
        );
      }
  }, 20_000);

  // The publish tests are std's NARROW fleet tests plus the catalog's own rules; the display widens the name test to any
  // name that merely ENDS in key/token/secret/password. Every word the display hides and a catalog accepts is that zone
  // and nothing else: W accepts it, only the widened tail names it, and it carries no known token shape.
  it('CFG-LEAK-R the publish tests withhold everything SHOWN_TESTS withholds, except the widened name-tail zone, pinned exactly', () => {
    const narrow: CutterTests = { namesSecret: secretNamed, looksSecret };
    const tokenShape = new RegExp(SECRET_TOKEN_SOURCE, 'u');
    const widenedTail = /(?:key|token|secret|password|passwd)s?|credentials?/iu;
    let hiddenWords = 0;
    let gap = 0;
    for (const words of corpus())
      for (const first of [undefined, '--token', '--model'])
        words.forEach((word, at) => {
          const before = at === 0 ? first : words[at - 1];
          if (!shownWordWith(SHOWN_TESTS, word, before).hidden) return;
          hiddenWords += 1;
          if (firstRefusedWord([word], before) !== -1) return;
          gap += 1;
          const args = before === undefined ? [word] : [before, word];
          const reasons = {
            writeRuleAccepts: findFlagSecrets({ args }).length === 0 && findRawSecrets({ args }).length === 0,
            narrowNamesNothing: !shownWordWith(narrow, word, before).hidden,
            tailNamesIt: widenedTail.test(`${before ?? ''} ${word}`),
            noTokenShape: !tokenShape.test(word),
          };
          should([word, before, reasons]).eql([
            word,
            before,
            { writeRuleAccepts: true, narrowNamesNothing: true, tailNamesIt: true, noTokenShape: true },
          ]);
        });
    should(hiddenWords).be.above(1000);
    // The zone is real in this corpus (the test would otherwise pin nothing).
    should(gap).be.above(0);
  }, 20_000);

  it('S6 CFG-LEAK-W the ruled controls stay shown: a pointer, then a key of its own and no raw text, is no glue', () => {
    for (const mark of [',', ';', '&'])
      for (const words of [['--key', `${POINTER}${mark}b=2`], [`--set=a=1,API_KEY=${POINTER}${mark}b=2`]]) {
        should(findFlagSecrets({ args: words }).length).equal(0);
        should([words, shownWords(words).map(word => word.hidden)]).eql([words, words.map(() => false)]);
      }
  });
});
