import { describe, expect, test } from 'bun:test';
import { consumesOf, contributedSlots, slotsPlacedBy } from '@ferretry/app/testing';
import { FERRET_MENU_SLOT, FERRET_SLOTS } from '../../../contract/index.ts';

/**
 * The slots Ferrets offers are an agreement by name: its contract names them and the props they carry, and each
 * contributing plugin writes the name in its own manifest (and proves it in its own suite). Proved against the real
 * compiled manifests, so renaming either side fails here instead of drawing an empty field.
 */

describe('the slots Ferrets offers', () => {
  test('every panel contributed to a Ferrets slot is one of the slots its contract names', () => {
    const named: readonly string[] = FERRET_SLOTS;
    const contributed = contributedSlots('ferrets.');
    expect(contributed.length).toBeGreaterThan(0);
    for (const slot of contributed) expect(named).toContain(slot);
  });

  test('Ferrets imports nothing of Runtimes: the offer is its contract, the contribution is Runtimes’ manifest', () => {
    expect(consumesOf('ferrets')).not.toContain('runtimes');
    // The one slot Ferrets fills itself is the ferret's menu (Info and Actions), which Conversation's header mounts.
    expect([...new Set(slotsPlacedBy('ferrets').filter(slot => slot.startsWith('ferrets.')))]).toEqual([
      FERRET_MENU_SLOT,
    ]);
  });
});
