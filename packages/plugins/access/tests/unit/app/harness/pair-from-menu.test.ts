/**
 * The pairing harness is what committed screenshots are taken from, so the code it shows must be a fixed fake:
 * a committed PNG of a real minted code would be a live credential in the repository.
 */
import { describe, expect, test } from 'bun:test';
import { PAIRING_CODE_PATTERN, PairingCodeMintResponseSchema } from '../../../../contract/index.ts';
import { HARNESS_INVITE } from '../../../../app/harness/pair-from-menu.tsx';

describe('the pairing harness', () => {
  test('P107 shows a fixed fake code on an example.test address, the same in every capture', () => {
    // A well-formed mint, so the surface draws it exactly as it would a real one.
    expect(PairingCodeMintResponseSchema.parse(HARNESS_INVITE).code).toBe(HARNESS_INVITE.code);
    expect(HARNESS_INVITE.code).toBe('7F3K-Q2ND');
    expect(PAIRING_CODE_PATTERN.test(HARNESS_INVITE.code)).toBe(true);
    // Nothing it names can be dialled: the address is reserved for examples, and the link carries that same code.
    expect(new URL(HARNESS_INVITE.daemonUrl ?? '').hostname.endsWith('.example.test')).toBe(true);
    expect(HARNESS_INVITE.pairUrl).toContain('code=7F3K-Q2ND');
    // Frozen, so the countdown reads the same in every capture.
    expect(String(HARNESS_INVITE.expiresAt)).toBe('2026-01-01T00:01:34.000Z');
  });
});
