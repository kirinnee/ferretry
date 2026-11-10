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
 * T-B2 also holds the write rule (W, `findFlagSecrets`) under the read mask: a word W refuses must be one the mask cuts.
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

/** The ONE corpus both copies are run over. */
const corpus = (): readonly (readonly string[])[] => [
  ...nestedFamily().map(item => item.words),
  ...OWN_LINES,
  ...BLANK_WORD_LINES,
  ...GENERATED_LINES,
];

describe('CFG-LEAK-R the kernel copy of the cutter agrees with runtimes', () => {
  it('CFG-LEAK-R the kernel and runtimes cut every corpus word identically', () => {
    const lines = corpus();
    should(nestedFamily().length).be.above(500);
    for (const words of lines) {
      should([words, kernelShownWords(words)]).eql([words, runtimesShownWords(words)]);
    }
    // …and the corpus really cuts: the two are not agreeing on "nothing".
    const cut = lines.filter(words => kernelShownWords(words).some(word => word.hidden));
    should(cut.length).be.above(400);
  });

  it('CFG-LEAK-R a command’s own flag before the first word is read the same by both', () => {
    for (const words of corpus().filter(line => line.length > 0)) {
      should([words, kernelShownWords(words.slice(1), words[0])]).eql([
        words,
        runtimesShownWords(words.slice(1), words[0]),
      ]);
    }
  });

  it('S6 CFG-LEAK-W every word W refuses is also cut by the read mask', () => {
    let refused = 0;
    for (const words of [...OWN_LINES, ...GENERATED_LINES]) {
      const shown = kernelShownWords(words);
      for (const finding of findFlagSecrets({ args: words })) {
        refused += 1;
        const at = finding.path[1];
        should(typeof at).equal('number');
        should([words, at, shown[at as number]?.hidden]).eql([words, at, true]);
      }
    }
    // W refuses a good share of the corpus, so the check above is not over nothing.
    should(refused).be.above(50);
  });

  it('S6 CFG-LEAK-W the ruling #40 family: W refuses words the mask shows only under two harmless shapes (DESIGN-QUESTION)', () => {
    // KNOWN GAP, pinned so it cannot grow unseen: over the ruling #40 family W (`findFlagSecrets`) refuses some words the
    // read mask leaves whole — (a) the harmless key `tokens` (the mask's name test is stricter than W's tail test) and
    // (b) a secret-named key whose value glues a `${secret:…}` pointer to other text. Both are W refusing MORE than the
    // mask hides: a file already holding such a word is read with that word shown, though W would refuse to add it.
    // So "every word W refuses is cut" is false here; closing it is a kernel change (DESIGN-QUESTION, not made here).
    const gap = new Set<string>();
    for (const words of nestedFamily().map(item => item.words)) {
      const shown = kernelShownWords(words);
      for (const finding of findFlagSecrets({ args: words })) {
        const at = finding.path[1] as number;
        if (shown[at]?.hidden !== true) gap.add(words[at] ?? '');
      }
    }
    should(gap.size).be.above(0);
    for (const word of gap) should(word.includes('tokens') || word.includes('${secret:')).equal(true);
    // (c) one word that holds blanks and does not start with a flag (`srv --token v`): shown by both cutters.
    const [blank = []] = BLANK_WORD_LINES;
    should(findFlagSecrets({ args: blank }).length).be.above(0);
    should(kernelShownWords(blank).some(word => word.hidden)).equal(false);
  });

  it('CFG-LEAK-R HIDDEN_VALUE_TEXT === HIDDEN_WORD_TEXT', () => {
    should(HIDDEN_VALUE_TEXT).equal(HIDDEN_WORD_TEXT);
  });
});
