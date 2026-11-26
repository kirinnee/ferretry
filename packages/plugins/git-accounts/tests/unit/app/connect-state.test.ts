/** The connect card's pure parts: failure words, the countdown, the link it may open, the two marks of the consent words. */
import { describe, expect, it } from 'bun:test';
import { GIT_ACCOUNT_CODES, GITHUB_SCOPES, githubScopes } from '../../../contract/index.ts';
import {
  CONSENT_ITEMS,
  CONSENT_LIMIT,
  CONSENT_MEANING,
  GPG_CONSENT_ITEM,
} from '../../../app/features/connect/consent-words.ts';
import { explainFailure, formatRemaining, remainingMs, safeVerificationUri } from '../../../app/lib/connect-state.ts';
import { richParts } from '../../../app/lib/rich.ts';

describe('the consent words', () => {
  it('name every scope the daemon asks GitHub for, and no other', () => {
    const named = CONSENT_ITEMS.flatMap(item => item.scopes);
    expect([...named].sort()).toEqual([...GITHUB_SCOPES].sort());
    expect([...named, ...GPG_CONSENT_ITEM.scopes].sort()).toEqual([...githubScopes('gpg')].sort());
  });

  it('say that the access can act as the person, can be used and never read, and how to revoke it', () => {
    expect(CONSENT_MEANING).toContain('**use**');
    expect(CONSENT_MEANING).toContain('never **read** the token');
    expect(CONSENT_LIMIT).toContain('github.com/settings/applications');
    const repo = CONSENT_ITEMS.find(item => item.scopes.includes('repo'));
    expect(repo?.text).toContain('**every** repository');
  });
});

describe('richParts', () => {
  it('splits bold and code marks and leaves the rest as plain text, never as markup', () => {
    expect(richParts('a **b** `c` <b>d</b>')).toEqual([
      { kind: 'text', text: 'a ', at: 0 },
      { kind: 'bold', text: 'b', at: 2 },
      { kind: 'text', text: ' ', at: 7 },
      { kind: 'code', text: 'c', at: 8 },
      { kind: 'text', text: ' <b>d</b>', at: 11 },
    ]);
  });
});

describe('the countdown', () => {
  it('counts down to zero and never below', () => {
    const at = '2026-11-19T08:15:00.000Z';
    const start = Date.parse('2026-11-19T08:00:00.000Z');
    expect(formatRemaining(remainingMs(at, start))).toBe('15:00');
    expect(formatRemaining(remainingMs(at, start + 14 * 60_000 + 59_500))).toBe('0:01');
    expect(remainingMs(at, start + 20 * 60_000)).toBe(0);
    expect(remainingMs('not a time', start)).toBe(0);
    expect(formatRemaining(0)).toBe('0:00');
  });
});

describe('safeVerificationUri', () => {
  it('links only https on github.com', () => {
    expect(safeVerificationUri('https://github.com/login/device')).toBe('https://github.com/login/device');
    for (const bad of [
      'http://github.com/login/device',
      'https://github.com.evil.example/login/device',
      'https://evil.example/login/device',
      'https://user@github.com/login/device',
      'javascript:alert(1)',
      'nonsense',
    ])
      expect(safeVerificationUri(bad), bad).toBeUndefined();
  });
});

describe('explainFailure', () => {
  it('words the known codes and keeps an unknown failure’s own message', () => {
    expect(explainFailure({ code: GIT_ACCOUNT_CODES.providerUnreachable })).toContain('could not reach GitHub');
    expect(explainFailure({ code: GIT_ACCOUNT_CODES.clientIdUnset })).toContain('git-accounts.yaml');
    expect(explainFailure(new Error('boom'))).toBe('boom');
  });
});
