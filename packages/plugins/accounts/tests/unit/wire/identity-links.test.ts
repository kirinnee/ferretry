import { describe, expect, it } from 'bun:test';
import { BROWSER_IDENTITY_KEY_PATTERN, BrowserIdentityKeySchema } from '@ferretry/plugin-browsers/contract';
import { IDENTITY_KEY_PATTERN, IdentityKeySchema } from '../../../contract/routes/index.ts';

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
