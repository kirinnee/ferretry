import { describe, expect, it } from 'bun:test';
import {
  ACTIONS_ROW_SLOT,
  FERRET_ACCOUNT_SLOTS,
  FERRET_LIST_ROW_MARK_SLOT,
  FERRET_SLOTS,
  FERRET_MENU_SLOT,
  FILES_SEARCH_SLOT,
  isActionsRowSlotProps,
  isFerretListRowMarkSlotProps,
  isFilesSearchSlotProps,
  isNewFerretContinueSlotProps,
  isNewFerretProjectSlotProps,
  NEW_FERRET_CONTINUE_SLOT,
  NEW_FERRET_PROJECT_SLOT,
} from '../../contract/index.ts';

describe('the ferret page’s slots', () => {
  it('are named in `<plugin>.<name>` form and listed with the account slots', () => {
    expect(ACTIONS_ROW_SLOT).toBe('ferrets.actions-row');
    expect(FILES_SEARCH_SLOT).toBe('ferrets.files-search');
    expect(NEW_FERRET_PROJECT_SLOT).toBe('ferrets.new-ferret-project');
    expect(NEW_FERRET_CONTINUE_SLOT).toBe('ferrets.new-ferret-continue');
    expect(isNewFerretContinueSlotProps({ picked: null, onPick: () => undefined })).toBe(true);
    expect(isNewFerretContinueSlotProps({ picked: 'k', onPick: () => undefined })).toBe(true);
    expect(isNewFerretContinueSlotProps({ picked: 1, onPick: () => undefined })).toBe(false);
    expect(isNewFerretContinueSlotProps({ picked: null })).toBe(false);
    expect(FERRET_LIST_ROW_MARK_SLOT).toBe('ferrets.list-row-mark');
    expect(FERRET_MENU_SLOT).toBe('ferrets.menu');
    expect([...FERRET_SLOTS]).toEqual([
      ...FERRET_ACCOUNT_SLOTS,
      ACTIONS_ROW_SLOT,
      FILES_SEARCH_SLOT,
      FERRET_MENU_SLOT,
      NEW_FERRET_CONTINUE_SLOT,
      NEW_FERRET_PROJECT_SLOT,
      FERRET_LIST_ROW_MARK_SLOT,
    ]);
  });

  it('a row-mark panel needs the ferret and the runtime it runs on', () => {
    expect(isFerretListRowMarkSlotProps({ ferret: 'f1', runtime: 'claude-main' })).toBe(true);
    expect(isFerretListRowMarkSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isFerretListRowMarkSlotProps({ ferret: 'f1', runtime: 7 })).toBe(false);
    expect(isFerretListRowMarkSlotProps(undefined)).toBe(false);
  });

  it('a panel accepts the props the host hands it and refuses anything short of them', () => {
    const offer = () => undefined;
    expect(isActionsRowSlotProps({ ferret: 'f1', name: 'wren', canControl: true, offer })).toBe(true);
    expect(isActionsRowSlotProps({ ferret: 'f1', name: 'wren', canControl: 'yes', offer })).toBe(false);
    expect(isActionsRowSlotProps({ subject: 'f1' })).toBe(false);
    expect(isFilesSearchSlotProps({ ferret: 'f1', openFile: offer })).toBe(true);
    expect(isFilesSearchSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isNewFerretProjectSlotProps({ daemon: 'd', value: '', id: 'f', recent: ['/a'], onPick: offer })).toBe(true);
    expect(isNewFerretProjectSlotProps({ daemon: 'd', value: '', id: 'f', recent: [], onPick: offer })).toBe(true);
    expect(isNewFerretProjectSlotProps({ daemon: 'd', value: '', onPick: offer })).toBe(false);
    expect(isNewFerretProjectSlotProps({ daemon: 'd', value: '', id: 'f', onPick: offer })).toBe(false);
    expect(isNewFerretProjectSlotProps({ value: '', id: 'f', recent: [], onPick: offer })).toBe(false);
    expect(isNewFerretProjectSlotProps({ daemon: 'd', value: 3, id: 'f', recent: [], onPick: offer })).toBe(false);
    expect(isNewFerretProjectSlotProps(null)).toBe(false);
  });
});
