import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { dependenciesOf, panelsInSlot } from '@ferretry/app/testing';
import { LOGINS_CONTRIBUTED_SLOTS } from '../../../contract/index.ts';

/**
 * Logins fills the two slots Runtimes' Add runtime page offers. Logins imports nothing of Runtimes, so the names are
 * written here as literals; Runtimes' own suite pins its two slot constants to the same literals.
 */
const ADD_RUNTIME_SLOT_NAMES = ['runtimes.add-runtime-login', 'runtimes.add-runtime-sign-in'] as const;

describe('the slots Runtimes’ Add runtime page offers and Logins fills', () => {
  test('Logins writes the two names Runtimes owns, and puts one panel in each', () => {
    expect([...LOGINS_CONTRIBUTED_SLOTS]).toEqual([...ADD_RUNTIME_SLOT_NAMES]);
    for (const slot of ADD_RUNTIME_SLOT_NAMES) {
      expect(isSlotName(slot)).toBe(true);
      expect(panelsInSlot(slot)).toEqual([
        `logins.${slot === 'runtimes.add-runtime-login' ? 'add-runtime-login' : 'add-runtime-sign-in'}`,
      ]);
    }
  });

  test('Logins imports nothing of Runtimes: Runtimes needs Logins, so the two agree by name and this test pairs them', () => {
    const { needs, uses } = dependenciesOf('logins');
    expect(needs).not.toContain('runtimes');
    expect(uses).not.toContain('runtimes');
    expect(dependenciesOf('runtimes').needs).toContain('logins');
  });
});
