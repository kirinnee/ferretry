import { describe, expect, it } from 'bun:test';
import {
  ACTIONS_ROW_SLOT,
  FERRET_ACCOUNT_SLOTS,
  FERRET_SLOTS,
  FILES_SEARCH_SLOT,
  isActionsRowSlotProps,
  isFilesSearchSlotProps,
  isNewFerretProjectSlotProps,
  NEW_FERRET_PROJECT_SLOT,
} from '../../contract/index.ts';

describe('the ferret page’s slots', () => {
  it('are named in `<plugin>.<name>` form and listed with the account slots', () => {
    expect(ACTIONS_ROW_SLOT).toBe('ferrets.actions-row');
    expect(FILES_SEARCH_SLOT).toBe('ferrets.files-search');
    expect(NEW_FERRET_PROJECT_SLOT).toBe('ferrets.new-ferret-project');
    expect([...FERRET_SLOTS]).toEqual([
      ...FERRET_ACCOUNT_SLOTS,
      ACTIONS_ROW_SLOT,
      FILES_SEARCH_SLOT,
      NEW_FERRET_PROJECT_SLOT,
    ]);
  });

  it('a panel accepts the props the host hands it and refuses anything short of them', () => {
    const offer = () => undefined;
    expect(isActionsRowSlotProps({ ferret: 'f1', name: 'wren', canControl: true, offer })).toBe(true);
    expect(isActionsRowSlotProps({ ferret: 'f1', name: 'wren', canControl: 'yes', offer })).toBe(false);
    expect(isActionsRowSlotProps({ subject: 'f1' })).toBe(false);
    expect(isFilesSearchSlotProps({ ferret: 'f1', openFile: offer })).toBe(true);
    expect(isFilesSearchSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isNewFerretProjectSlotProps({ value: '', onPick: offer })).toBe(true);
    expect(isNewFerretProjectSlotProps({ value: 3, onPick: offer })).toBe(false);
    expect(isNewFerretProjectSlotProps(null)).toBe(false);
  });
});
