import { describe, expect, test } from 'bun:test';
import { panelsInSlot, reachFrom } from '@ferretry/app/testing';
import { FERRET_LIST_ROW_MARK_SLOT } from '@ferretry/core-ferrets/contract';

describe('the slots Usage fills and the plugin graph around it', () => {
  test('Usage puts its quota mark on a ferret’s list row, through the name Ferrets owns', () => {
    expect(panelsInSlot(FERRET_LIST_ROW_MARK_SLOT)).toContain('usage.quota');
  });

  test('Usage does not reach Runtimes, directly or through anything it consumes', () => {
    expect(reachFrom('usage')).not.toContain('runtimes');
  });
});
