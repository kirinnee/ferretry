import { describe, expect, it } from 'bun:test';
import {
  FERRET_ACCOUNT_SLOTS,
  isMoveAccountSlotProps,
  isNewFerretAccountSlotProps,
  MOVE_ACCOUNT_SLOT,
  NEW_FERRET_ACCOUNT_SLOT,
} from '../../contract/index.ts';

const page = {
  value: 'claude-default',
  onValueChange: () => undefined,
  onChosen: () => undefined,
  fallbackId: 'agent',
  labelId: 'agent-label',
  fallbackPlaceholder: 'runtime',
  noAccounts: null,
};

describe('the slots Ferrets offers', () => {
  it('names the new-ferret and move account slots in `<plugin>.<name>` form', () => {
    expect(NEW_FERRET_ACCOUNT_SLOT).toBe('ferrets.new-ferret-account');
    expect(MOVE_ACCOUNT_SLOT).toBe('ferrets.move-account');
    expect([...FERRET_ACCOUNT_SLOTS]).toEqual([NEW_FERRET_ACCOUNT_SLOT, MOVE_ACCOUNT_SLOT]);
  });

  it('a panel accepts the props a page hands it and refuses anything short of them', () => {
    expect(isNewFerretAccountSlotProps(page)).toBe(true);
    expect(isNewFerretAccountSlotProps({ ...page, preferred: 'codex-default' })).toBe(true);
    expect(isNewFerretAccountSlotProps({ ...page, onChosen: undefined })).toBe(false);
    expect(isNewFerretAccountSlotProps({ ...page, value: 3 })).toBe(false);
    expect(isNewFerretAccountSlotProps({ subject: 'f1' })).toBe(false);
    expect(isNewFerretAccountSlotProps(null)).toBe(false);
  });

  it('the move slot also owes the harness the ferret is on', () => {
    expect(isMoveAccountSlotProps(page)).toBe(false);
    expect(isMoveAccountSlotProps({ ...page, harness: 'codex' })).toBe(true);
  });
});
