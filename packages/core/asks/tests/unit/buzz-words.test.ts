import { describe, expect, test } from 'bun:test';
import { buzzBody, buzzTitle, clipAtWord } from '../../contract/index.ts';
import { askBuzzKey, askBuzzKind, askBuzzPath, askBuzzWords, type BuzzableAsk } from '../../contract/index.ts';

describe('clipAtWord', () => {
  test('keeps a short line whole and one-lines it', () => {
    expect(clipAtWord('  fix   the\nbadge ', 40)).toBe('fix the badge');
  });

  test('cuts a long line at a word with an ellipsis', () => {
    const clipped = clipAtWord('review the release notes before the owner reads them tonight', 30);
    expect(clipped.length).toBeLessThanOrEqual(30);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/\s…$/u);
  });
});

describe('buzzTitle', () => {
  test('writes an ordinary title as written, clipped at 40', () => {
    expect(buzzTitle('Badge colour is at Released')).toBe('Badge colour is at Released');
    expect(buzzTitle('x'.repeat(100)).length).toBeLessThanOrEqual(40);
  });

  test('labels a title that reads as the daemon’s new-device alert, in any letters that look like it', () => {
    expect(buzzTitle('A new device was paired')).toMatch(/^Ferret “/u);
    // Cyrillic е and о look like the Latin letters.
    expect(buzzTitle('A nеw dеvice was paired')).toMatch(/^Ferret “/u);
    expect(buzzTitle('new device!')).toMatch(/^Ferret “/u);
  });

  test('labels a title that reads as the approve-on-phone push', () => {
    expect(buzzTitle('Approve on your phone')).toMatch(/^Ferret “/u);
    expect(buzzTitle('aррrove on your phone')).toMatch(/^Ferret “/u);
  });

  test('keeps a labelled title inside the title limit', () => {
    expect(buzzTitle('A new device was paired, please approve on your phone right now').length).toBeLessThanOrEqual(41);
  });
});

describe('buzzBody', () => {
  test('is one line of at most 120 characters', () => {
    expect(buzzBody(`${'word '.repeat(60)}`).length).toBeLessThanOrEqual(120);
    expect(buzzBody('a\nb')).toBe('a b');
  });
});

describe('the buzz an ask makes', () => {
  const ask = (overrides: Partial<BuzzableAsk>) =>
    ({
      id: 'A3',
      subject: 'Renew the cert',
      ferret: 'f1',
      state: 'open',
      kind: 'task',
      source: 'question',
      ...overrides,
    }) as BuzzableAsk;

  test('only a card’s ask or a notice that asked for the phone buzzes on its own', () => {
    expect(askBuzzKind(ask({}))).toBeUndefined();
    expect(askBuzzKind(ask({ kind: 'notice' }))).toBeUndefined();
    expect(askBuzzKind(ask({ kind: 'notice', blocking: true }))).toBe('notice');
    expect(askBuzzKind(ask({ source: 'card' as never }))).toBe('card-ask');
    expect(askBuzzKind(ask({ source: 'card' as never, state: 'closed' }))).toBeUndefined();
  });

  test('words the buzz by the ask’s subject, under the ask’s own tag, and opens the ferret’s chat at the ask', () => {
    const words = askBuzzWords(ask({}));
    expect(words).toEqual({
      tag: 'agenda-f1:A3',
      title: 'Renew the cert',
      body: 'Renew the cert',
      url: '/ferrets/f1/chat?ask=A3',
    });
  });

  test('a machine ask opens the Agenda page at the ask, never /ferrets//chat', () => {
    expect(askBuzzPath('', 'A12' as never)).toBe('/agenda?ask=A12');
    expect(askBuzzWords(ask({ ferret: undefined })).url).toBe('/agenda?ask=A3');
  });

  test('keys an ask by ferret and id', () => {
    expect(askBuzzKey('f1', 'A3')).toBe('ask:f1:A3');
  });
});
