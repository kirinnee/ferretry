/**
 * CFG-LEAK-R: the kernel's word cutter (`host/config/secret-words.ts`) is a COPY of runtimes' (`command-line.ts` and the
 * `looksSecret` family of `account/import.ts`), because the kernel is a leaf and imports no plugin. Two copies of
 * security code may not drift, so this test runs both over one corpus — the whole generated family of ruling #40 that
 * runtimes holds its own cutter to, and the words of the cases this unit pins — and requires the same answer, word for
 * word. It reaches the runtimes files by relative path (a TEST may; the kernel's own code may not).
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { expect, test } from 'bun:test';
import { HIDDEN_WORD_TEXT } from '../../../../../plugins/runtimes/contract/wire/catalog.ts';
import { shownWords as runtimesShownWords } from '../../../../../plugins/runtimes/daemon/lib/service/command-line.ts';
import { nestedFamily } from '../../../../../plugins/runtimes/tests/unit/daemon/command-line-family.ts';
import { HIDDEN_VALUE_TEXT, shownWords as kernelShownWords } from '../../../host/config/secret-words.ts';
import { OTHER_VALUE, SHORT_PASSWORD, VALUE } from './masked-support.ts';

/** The words of this unit's own cases, lines and lists a person writes. */
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
  [`srv --token ${VALUE}`],
  ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'plain', ''],
  [],
];

test('CFG-LEAK-R the kernel and runtimes cut every corpus word identically', () => {
  const family = nestedFamily();
  expect(family.length).toBeGreaterThan(500);
  const lines = [...family.map(item => item.words), ...OWN_LINES];
  for (const words of lines) {
    const kernel = kernelShownWords(words);
    const runtimes = runtimesShownWords(words);
    expect([words, kernel]).toEqual([words, runtimes]);
  }
  // …and the corpus really cuts: the family holds secrets, so the two are not agreeing on "nothing".
  const cut = lines.filter(words => kernelShownWords(words).some(word => word.hidden));
  expect(cut.length).toBeGreaterThan(400);
});

test('CFG-LEAK-R the kernel’s placeholder is the one spelling runtimes uses', () => {
  expect(HIDDEN_VALUE_TEXT).toBe(HIDDEN_WORD_TEXT);
});
