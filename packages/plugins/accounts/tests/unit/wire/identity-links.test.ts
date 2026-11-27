import { describe, expect, it } from 'bun:test';
import { BROWSER_IDENTITY_KEY_PATTERN, BrowserIdentityKeySchema } from '@ferretry/plugin-browsers/contract';
import {
  IDENTITY_KEY_PATTERN,
  IdentityAnswerSchema,
  IdentityKeySchema,
  IdentityLinksDocumentSchema,
} from '../../../contract/routes/index.ts';

/** Browsers owns an identity's key; Accounts' contract may not import it, so one test holds the two spellings together. */
describe('an identity key in the graph', () => {
  it('should be spelled exactly as Browsers spells it, so no key Browsers refuses can enter the graph', () => {
    expect(IDENTITY_KEY_PATTERN.source).toBe(BROWSER_IDENTITY_KEY_PATTERN.source);
    expect(IDENTITY_KEY_PATTERN.flags).toBe(BROWSER_IDENTITY_KEY_PATTERN.flags);
    for (const key of [
      'agent',
      'work',
      'a',
      'team-2',
      'x'.repeat(32),
      '',
      '../agent',
      'Work',
      'a/b',
      '2fa',
      'x'.repeat(33),
    ])
      expect(IdentityKeySchema.safeParse(key).success).toBe(BrowserIdentityKeySchema.safeParse(key).success);
  });
});

describe('an identity answer on the wire', () => {
  const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `id-${String(index)}`);
  const edges = (count: number) =>
    keys(count).map(identity => ({
      signIn: 'si_0000000000000001',
      identity,
      seenAt: '2026-11-27T09:00:00.000Z',
      how: 'filled',
    }));

  it('should carry as many ambiguous identities as the graph can hold edges for, past 16', () => {
    // 17 identities hold one sign-in: the document parses, so the answer the graph returns must parse too.
    expect(IdentityLinksDocumentSchema.safeParse({ format: 1, links: edges(17) }).success).toBe(true);
    expect(IdentityAnswerSchema.safeParse({ ambiguous: keys(17) }).success).toBe(true);
    expect(IdentityAnswerSchema.safeParse({ ambiguous: keys(1_024) }).success).toBe(true);
    expect(IdentityAnswerSchema.safeParse({ ambiguous: keys(1_025) }).success).toBe(false);
  });

  it('should carry one identity under two or more accounts, and refuse one account alone', () => {
    expect(IdentityAnswerSchema.safeParse({ identity: 'work', ambiguousAccounts: ['A', 'B'] }).success).toBe(true);
    expect(IdentityAnswerSchema.safeParse({ identity: 'work', ambiguousAccounts: ['A'] }).success).toBe(false);
  });
});
