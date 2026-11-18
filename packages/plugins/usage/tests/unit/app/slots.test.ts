import { describe, expect, test } from 'bun:test';
import { panelsInSlot, reachFrom } from '@ferretry/app/testing';
import { FERRET_LIST_ROW_MARK_SLOT } from '@ferretry/core-ferrets/contract';
import { LOGIN_METER_SLOT } from '@ferretry/plugin-logins/contract';

describe('the slots Usage fills and the plugin graph around it', () => {
  test('Usage puts its quota mark on a ferret’s list row, through the name Ferrets owns', () => {
    expect(panelsInSlot(FERRET_LIST_ROW_MARK_SLOT)).toContain('usage.quota');
  });

  test('Usage draws a login’s spend budget bars under its quota on Logins’ card, through the name Logins owns', () => {
    expect(LOGIN_METER_SLOT.startsWith('logins.')).toBe(true);
    expect(panelsInSlot(LOGIN_METER_SLOT)).toEqual(['usage.login-budget']);
  });

  test('Usage does not reach Runtimes, directly or through anything it consumes', () => {
    expect(reachFrom('usage')).not.toContain('runtimes');
  });
});
