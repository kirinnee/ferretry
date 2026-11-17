import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { contributedSlots, panelsInSlot } from '@ferretry/app/testing';
import { INPUT_SETTLED_SLOT } from '@ferretry/core-vault/contract';
import { ACCESS_DEVICE_NOTE_SLOT, ACCOUNTS_CONTRIBUTED_SLOTS } from '../../../contract/index.ts';

describe('the slot Access’s Add device page offers under each device’s Revoke and Accounts fills', () => {
  test('Accounts writes the name Access owns, and puts its one panel there', () => {
    expect([...ACCOUNTS_CONTRIBUTED_SLOTS]).toEqual([ACCESS_DEVICE_NOTE_SLOT, INPUT_SETTLED_SLOT]);
    // The name Access's app half offers (its own test pins `DEVICE_NOTE_SLOT` to the same literal): a shell test may not
    // import a half, so the agreed name is written here too.
    expect(ACCESS_DEVICE_NOTE_SLOT).toBe('access.device-note');
    expect(isSlotName(ACCESS_DEVICE_NOTE_SLOT)).toBe(true);
    expect(panelsInSlot(ACCESS_DEVICE_NOTE_SLOT)).toEqual(['accounts.device-rule-note']);
  });

  test('Accounts places no panel in any other access.* slot', () => {
    expect(contributedSlots('access.')).toEqual(['access.device-note']);
  });
});

describe('the slot the Vault’s input card offers once a saved account settled it, and Accounts fills', () => {
  test('Accounts imports the name the Vault owns, and puts its one panel there', () => {
    expect(INPUT_SETTLED_SLOT).toBe('vault.input-settled');
    expect(isSlotName(INPUT_SETTLED_SLOT)).toBe(true);
    expect(panelsInSlot(INPUT_SETTLED_SLOT)).toEqual(['accounts.sign-in-rule-offer']);
  });
});
