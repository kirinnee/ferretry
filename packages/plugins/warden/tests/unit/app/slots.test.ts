import { describe, expect, test } from 'bun:test';
import { panelsInSlot } from '@ferretry/app/testing';
import { ACTIONS_ROW_SLOT } from '@ferretry/core-ferrets/contract';

describe('the slots Warden fills', () => {
  test('Warden puts its Ask Warden row in the Actions ▾ menu, through the name Ferrets owns', () => {
    expect(panelsInSlot(ACTIONS_ROW_SLOT)).toContain('warden.ask-warden-row');
  });
});
