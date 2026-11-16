import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { contributedSlots, dependenciesOf, panelsInSlot, reachFrom } from '@ferretry/app/testing';
import { FERRET_ACCOUNT_SLOTS } from '@ferretry/core-ferrets/contract';
import { RUNTIMES_SLOTS } from '../../../contract/index.ts';

/**
 * Runtimes' side of the slot agreements, proved against the real compiled manifests: its two account pickers sit in the
 * slots Ferrets offers, the slots its Add runtime page and Profiles library offer are the ones the contract names, and
 * it uses Usage without being used back.
 */

describe('the slots Ferrets offers', () => {
  test('each is a plugin slot name owned by Ferrets, and Runtimes contributes a panel to each', () => {
    for (const slot of FERRET_ACCOUNT_SLOTS) {
      expect(isSlotName(slot)).toBe(true);
      expect(slot.startsWith('ferrets.')).toBe(true);
      expect(panelsInSlot(slot)).toEqual([
        `runtimes.${slot === 'ferrets.new-ferret-account' ? 'new-ferret-account' : 'move-account'}`,
      ]);
    }
  });
});

describe('the slots Runtimes’ Add runtime page offers and Logins fills', () => {
  test('every panel contributed to a runtimes.* slot is one of the slots Runtimes’ contract names', () => {
    const named: readonly string[] = RUNTIMES_SLOTS;
    const contributed = contributedSlots('runtimes.');
    expect(contributed.length).toBeGreaterThan(0);
    for (const slot of contributed) expect(named).toContain(slot);
  });
});

describe('the plugin graph with Runtimes using Usage', () => {
  test('Runtimes uses Usage, optionally: declared in `uses`, not `needs`', () => {
    const { needs, uses } = dependenciesOf('runtimes');
    expect(uses).toEqual(['usage']);
    expect(needs).not.toContain('usage');
    expect(reachFrom('runtimes')).toContain('usage');
  });
});
