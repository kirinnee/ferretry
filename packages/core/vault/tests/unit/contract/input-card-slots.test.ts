import { describe, expect, it } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import {
  INPUT_CARD_CODES_SLOT,
  INPUT_SETTLED_SLOT,
  isInputSettledSlotProps,
  readInputCardCodesSlotProps,
} from '../../../contract/index.ts';

const GOOD = {
  requestId: 'a'.repeat(32),
  ferretId: 'hadi',
  saved: { match: 'github.com', offers: [] },
  refresh: () => undefined,
};

describe('the slots the input card offers', () => {
  it('are named <plugin>.<name>, and the codes slot is Vault’s own', () => {
    expect(INPUT_CARD_CODES_SLOT).toBe('vault.input-card-codes');
    expect(isSlotName(INPUT_CARD_CODES_SLOT)).toBe(true);
    expect(isSlotName(INPUT_SETTLED_SLOT)).toBe(true);
  });
});

describe('reading the props of the codes slot', () => {
  it('reads what the card hands over, with and without the hold callback', () => {
    expect(readInputCardCodesSlotProps(GOOD)).toMatchObject({ requestId: GOOD.requestId, ferretId: 'hadi' });
    const hold = (): void => undefined;
    expect(readInputCardCodesSlotProps({ ...GOOD, hold })?.hold).toBe(hold);
    expect(readInputCardCodesSlotProps(GOOD)).not.toHaveProperty('hold');
  });

  it('refuses anything else, and never throws', () => {
    for (const junk of [
      undefined,
      null,
      'x',
      7,
      [],
      {},
      { ...GOOD, requestId: '' },
      { ...GOOD, ferretId: 3 },
      { ...GOOD, saved: null },
      { ...GOOD, saved: {} },
      { ...GOOD, saved: [] },
      { ...GOOD, refresh: 'x' },
      { ...GOOD, hold: 'x' },
    ])
      expect(readInputCardCodesSlotProps(junk)).toBeUndefined();
  });

  it('keeps the settled slot’s reader as it was (the hold callback is optional)', () => {
    expect(isInputSettledSlotProps({ ferret: 'hadi', request: 'r', entry: 'E' })).toBe(true);
    expect(isInputSettledSlotProps({ ferret: 'hadi', request: 'r', entry: 'E', hold: () => undefined })).toBe(true);
  });
});
