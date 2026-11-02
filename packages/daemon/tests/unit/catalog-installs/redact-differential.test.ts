import { describe, it } from 'bun:test';
import type { SharedCatalogItem } from '@ferretry/protocol';
import should from 'should';
import { hideSecrets } from '../../../src/lib/catalog-installs/hide-secrets.ts';
import { redactText } from '../../../src/lib/fleet/catalog.ts';
import { referenceRedactText } from '../../support/redact-reference.ts';

// The loop this ends: every review found one more way a line break, a separator or a lead character hid a value
// from the new rules that the old `redactText` had hidden. Instead of waiting for the next one, generate text from
// the alphabet those findings came from and hold the new rules to the old one: a secret value the reference
// (main's `redactText`) hid must not survive `redactText` or "See changes".

const SECRET_VALUES = [
  'hunter2hunter2xyz',
  'c2VjcmV0cGFzc3dvcmQ=',
  'aHVudGVyMmh1bnRlcjI==',
  'ghp_abcdefghijklmnop',
  'sk-qrstuvwxyz012345',
  'Zm9vYmFyYmF6cXV4cXV1',
  'tok3nvalue99',
];
const NAMES = [
  'password',
  'PASSWORD',
  'api_token',
  'API_KEY',
  'TOKEN',
  'TOKEN_',
  'GITHUB_TOKEN',
  'db_pass',
  'secret',
  'auth',
  'x-api-key',
  '1API_KEY',
  '9TOKEN',
  'mode',
  'user_name',
  'login_page',
];
const LEADS = [
  '',
  ' ',
  '  ',
  '\t',
  '/',
  '$',
  'export ',
  '|',
  '- ',
  '"',
  "'",
  '(',
  '[',
  '{',
  '>',
  ',',
  ';',
  'see ',
  'set the ',
  '-=',
  '.=',
  '--',
  '\n',
  '\n  ',
  '\r\n    ',
];
const GAPS = ['', '', ' ', '  ', '\t', '\n', '\r', '\r\n', '\n  ', '\n\n', '\r\r', ' \n '];
const MARKS = [':', '=', ':', '=', ':='];
const BLOCKS = ['', '', '', '', '|', '>-', '|+', '>2'];
const PARENTS = ['db', 'auth', 'env', 'mcp.servers', 'x'];
const QUOTES = ['', '"', "'"];
const BREAKS = ['\n', '\r\n', '\r', '\n  ', '\n\n', ' ', '\n\t', '\n    '];

/** mulberry32: a small seeded generator, so a run is the same run everywhere and nothing flakes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(next: () => number): string {
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;
  const entries = 1 + Math.floor(next() * 5);
  let text = '';
  for (let at = 0; at < entries; at += 1) {
    const quote = pick(QUOTES);
    if (next() < 0.25) text += `${pick(PARENTS)}:${pick(BREAKS)}`;
    const separator = `${pick(GAPS)}${pick(MARKS)}${pick(GAPS)}${pick(BLOCKS)}${pick(GAPS)}`;
    text += pick(LEADS) + pick(NAMES) + pick(QUOTES) + separator + quote + pick(SECRET_VALUES) + quote;
    if (next() < 0.3) text += pick(NAMES);
    text += pick(BREAKS);
  }
  return text;
}

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

const base = { format: 'ferretry-catalog-item', version: 1, publisher: 'p', catalogId: 'c', itemId: 'i', name: 'x' };
const skill = (content: string) =>
  ({ ...base, kind: 'skill', skill: { files: [{ path: 'SKILL.md', content }] } }) as unknown as Extract<
    SharedCatalogItem,
    { kind: 'skill' }
  >;
const shown = (content: string): string => {
  const [installed] = hideSecrets(skill(content), skill('nothing here'));
  return (installed as ReturnType<typeof skill>).skill.files[0]?.content ?? '';
};

/** Which of the rules lets a value the reference hid through, or undefined when none does. */
function leak(text: string): string | undefined {
  const reference = referenceRedactText(text).text;
  const current = redactText(text).text;
  const preview = shown(text);
  for (const value of SECRET_VALUES) {
    const hidden = occurrences(text, value) > occurrences(reference, value) ? occurrences(reference, value) : undefined;
    if (hidden === undefined) continue;
    if (occurrences(current, value) > hidden) return `redactText shows ${value}`;
    if (occurrences(preview, value) > hidden) return `See changes shows ${value}`;
  }
  return undefined;
}

/** The smallest text that still leaks: characters taken out one at a time while it does. */
function minimal(text: string, why: string): string {
  let smallest = text;
  for (let again = true; again; ) {
    again = false;
    for (let at = 0; at < smallest.length; at += 1) {
      const shorter = smallest.slice(0, at) + smallest.slice(at + 1);
      if (leak(shorter) !== why) continue;
      smallest = shorter;
      again = true;
      at -= 1;
    }
  }
  return smallest;
}

describe('redactText and See changes never hide less than the text rules of main', () => {
  it('should hide every secret value the reference hid, over 20000 generated texts', () => {
    // Arrange
    const next = seeded(0x5eed);
    const failures: string[] = [];

    // Act
    for (let count = 0; count < 20_000 && failures.length < 5; count += 1) {
      const text = generate(next);
      const why = leak(text);
      if (why !== undefined) failures.push(`${why}: ${JSON.stringify(minimal(text, why))}`);
    }

    // Assert
    should(failures).deepEqual([]);
  });
});
