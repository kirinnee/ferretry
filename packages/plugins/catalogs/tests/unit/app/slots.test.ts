import { describe, expect, test } from 'bun:test';
import { panelsInSlot } from '@ferretry/app/testing';
import { ACTIONS_ROW_SLOT } from '@ferretry/core-ferrets/contract';

describe('the slots Catalogs fills', () => {
  test('Catalogs puts its Add skills row in the Actions ▾ menu, through the name Ferrets owns', () => {
    expect(panelsInSlot(ACTIONS_ROW_SLOT)).toContain('catalogs.add-skills-row');
  });
});
