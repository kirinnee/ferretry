import { describe, expect, test } from 'bun:test';
import { dependenciesOf } from '@ferretry/app/testing';

describe('the slot Access’s Add device page offers under each device’s Revoke and Accounts fills', () => {
  test('Access imports nothing of Accounts: the two agree by name, and this test is the pairing', () => {
    const { needs, uses } = dependenciesOf('access');
    expect(needs).not.toContain('accounts');
    expect(uses).not.toContain('accounts');
  });
});
