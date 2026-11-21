import { describe, expect, test } from 'bun:test';
import { panelsInSlot, slotsPlacedBy } from '@ferretry/app/testing';
import { NEW_FERRET_PROJECT_SLOT } from '@ferretry/core-ferrets/contract';

/** The slot is an agreement by name: Ferrets offers it, Projects fills it (r11 S8: nobody did, so the picker never drew). */
describe('the New ferret project slot', () => {
  test('Projects fills the slot Ferrets offers above its Folder box', () => {
    expect(slotsPlacedBy('projects')).toContain(NEW_FERRET_PROJECT_SLOT);
    expect(panelsInSlot(NEW_FERRET_PROJECT_SLOT)).toEqual(['projects.new-ferret-projects']);
  });
});
