/**
 * CFG-LEAK-R: the kernel's word cutter (`host/config/secret-words.ts`) is a COPY of runtimes' (`command-line.ts`),
 * because the kernel is a leaf and imports no plugin. Two copies of security code may not drift, so this test runs both
 * over ONE corpus and requires the same answer, word for word. The corpus is the whole generated family of ruling #40
 * that runtimes holds its own cutter to (`command-line-family.ts`), the cases the kernel's own tests pin
 * (`secret-words.test.ts`), and a generated block of every credential-naming word and token format.
 *
 * It reaches the kernel by relative path: `shownWords` and `findFlagSecrets` are not on `@ferretry/kernel/host`'s
 * export list, and a TEST may import both sides where the kernel's own code may not import a plugin.
 *
 * T-B2 holds the write rule (W, `findFlagSecrets`) under BOTH cutters, strictly: EVERY word W refuses is cut by the
 * kernel's mask and by runtimes' copy, residual 0. Its corpus comes from W's own name tail, not from the mask's name
 * list: a candidate name is in it exactly when W refuses it, so a name only W knows is in it. A W-only widening onto a name outside CANDIDATE_NAMES is not seen.
 *
 * Pin to the vault contract's cutter once it lands on 5.0 (`rebuild/fix-catalogs-one-rule`, #41): this file has no
 * vault import until then.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { HIDDEN_WORD_TEXT } from '../../../contract/index.ts';
import { shownWords as runtimesShownWords } from '../../../daemon/lib/service/command-line.ts';
import { findFlagSecrets } from '../../../../../core/kernel/host/config/secrets.ts';
import {
  HIDDEN_VALUE_TEXT,
  shownWords as kernelShownWords,
} from '../../../../../core/kernel/host/config/secret-words.ts';
import { nestedFamily } from './command-line-family.ts';

/** A 16-character value of 16 distinct characters: past every length and entropy gate, and no known shape. */
const VALUE = 'Zk3pQ9vXw2LmN7rT';
const OTHER_VALUE = 'Hy8cBt4Fg6SdJ1uE';
const SHORT_PASSWORD = 'hunter2024';
const POINTER = '${secret:X}';

/** The cases the kernel's own `secret-words.test.ts` pins, and the lines a person writes. */
const OWN_LINES: readonly (readonly string[])[] = [
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

/** The ONE corpus both copies are run over. */
const corpus = (): readonly (readonly string[])[] => [
  ...nestedFamily().map(item => item.words),
  ...OWN_LINES,
  ...BLANK_WORD_LINES,
  ...GENERATED_LINES,
  ...writeRuleLines(),
];

/** Every word of `lines` W refuses, and whether each cutter cut it: `[words, index, kernel cut it, runtimes cut it]`. */
function refusedWords(
  lines: readonly (readonly string[])[],
): readonly (readonly [words: readonly string[], at: number, kernel: boolean, runtimes: boolean])[] {
  return lines.flatMap(words => {
    const kernel = kernelShownWords(words);
    const runtimes = runtimesShownWords(words);
    return findFlagSecrets({ args: words }).map(finding => {
      const at = finding.path[1] as number;
      return [words, at, kernel[at]?.hidden === true, runtimes[at]?.hidden === true] as const;
    });
  });
}

describe('CFG-LEAK-R the kernel copy of the cutter agrees with runtimes', () => {
  it('CFG-LEAK-R the kernel and runtimes cut every corpus word identically', () => {
    const lines = corpus();
    should(nestedFamily().length).be.above(500);
    const kernel = lines.map(words => kernelShownWords(words));
    const runtimes = lines.map(words => runtimesShownWords(words));
    // The whole corpus in ONE comparison (a `should(...).eql` per line cost ~1 s of the test's 3 s); on a difference,
    // the first line that differs, with its words, so the failure still says which.
    if (JSON.stringify(kernel) !== JSON.stringify(runtimes)) {
      const at = kernel.findIndex((shown, index) => JSON.stringify(shown) !== JSON.stringify(runtimes[index]));
      should([lines[at], kernel[at]]).eql([lines[at], runtimes[at]]);
    }
    // …and the corpus really cuts: the two are not agreeing on "nothing".
    should(kernel.filter(shown => shown.some(word => word.hidden)).length).be.above(400);
  });

  it('CFG-LEAK-R a command’s own flag before the first word is read the same by both', () => {
    const lines = corpus().filter(line => line.length > 0);
    const kernel = lines.map(words => kernelShownWords(words.slice(1), words[0]));
    const runtimes = lines.map(words => runtimesShownWords(words.slice(1), words[0]));
    if (JSON.stringify(kernel) !== JSON.stringify(runtimes)) {
      const at = kernel.findIndex((shown, index) => JSON.stringify(shown) !== JSON.stringify(runtimes[index]));
      should([lines[at], kernel[at]]).eql([lines[at], runtimes[at]]);
    }
  });

  it('S6 CFG-LEAK-W every word W refuses is cut by the kernel mask AND by the runtimes copy: residual 0', () => {
    // One word with blanks that does not start with a flag (`srv --token v`) is read as a command line by the kernel's
    // `shownItem`, not by `shownWord`, so it is T-B1's (both cutters show it alike), not this test's.
    const lines = [...nestedFamily().map(item => item.words), ...OWN_LINES, ...GENERATED_LINES, ...writeRuleLines()];
    const refused = refusedWords(lines);
    // W refuses a good share of the corpus, and the names only W's tail knows are in it (--key, --ssh-key, --tokens …).
    should(refused.length).be.above(1000);
    const names = new Set(writeRuleLines().map(words => words.join(' ')));
    should(names.size).be.above(60);
    const missed = refused
      .filter(([, , kernel, runtimes]) => !kernel || !runtimes)
      .map(([words, at, kernel, runtimes]) => [words, at, { kernel, runtimes }]);
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

  it('S6 CFG-LEAK-W GAP pinned: a pointer, then a key of its own, then raw text is refused by W and shown by both', () => {
    // `${secret:X},b=2,<v>`: the text after `b=2,` belongs to key `b`, which no name rule reads, so neither cutter cuts it.
    // Not declared yet (a ports-pending line is the owner's call). This test pins the gap so it cannot grow: a fix turns
    // it RED, and the line then moves to T-B2.
    for (const mark of [',', ';', '&']) {
      const words = ['--key', `${POINTER}${mark}b=2${mark}${VALUE}`];
      should(findFlagSecrets({ args: words }).length).equal(1);
      should(kernelShownWords(words)[1]?.hidden).equal(false);
      should(runtimesShownWords(words)[1]?.hidden).equal(false);
    }
  });

  it('CFG-LEAK-R HIDDEN_VALUE_TEXT === HIDDEN_WORD_TEXT', () => {
    should(HIDDEN_VALUE_TEXT).equal(HIDDEN_WORD_TEXT);
  });
});
