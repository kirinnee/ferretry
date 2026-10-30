/**
 * Where Info stands on one session page: open or shut, which tab, the Folder sub-tab, and the phone
 * sheet's half/full height — one placement so the header's ⓘ, a `/skill` chip and Info's own tabs move
 * the same panel.
 */

import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useInfoPlacement } from '../../../../src/features/session-info/use-info-placement.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useInfoPlacement', () => {
  it('starts shut on Overview, with the files sub-tab and a half sheet, when given no initial tab', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement();
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    expect(placement).toMatchObject({ open: false, tab: 'overview', folderTab: 'files', sheetSize: 'half' });
    act(() => renderer?.unmount());
  });

  it('opens on the given tab from the start when handed one', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement('surfaces');
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    expect(placement).toMatchObject({ open: true, tab: 'surfaces' });
    act(() => renderer?.unmount());
  });

  it('opens the Tasks tab as a full-height sheet, from a tab press or from show', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement();
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    act(() => placement?.show('tasks'));
    expect(placement).toMatchObject({ open: true, tab: 'tasks', sheetSize: 'full' });
    act(() => placement?.setTab('overview'));
    act(() => placement?.setSheetSize('half'));
    act(() => placement?.setTab('tasks'));
    expect(placement).toMatchObject({ tab: 'tasks', sheetSize: 'full' });
    act(() => renderer?.unmount());
  });

  it('toggles open and shut, resetting the sheet to half each time', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement();
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    act(() => placement?.setSheetSize('full'));
    expect(placement?.sheetSize).toBe('full');

    act(() => placement?.toggle());
    expect(placement?.open).toBe(true);
    expect(placement?.sheetSize).toBe('half');

    act(() => placement?.setSheetSize('full'));
    act(() => placement?.toggle());
    expect(placement?.open).toBe(false);
    expect(placement?.sheetSize).toBe('half');

    act(() => renderer?.unmount());
  });

  it('closes, and changes tab and folder tab independently', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement('overview');
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    act(() => placement?.setTab('usage'));
    expect(placement?.tab).toBe('usage');
    act(() => placement?.setFolderTab('docs'));
    expect(placement?.folderTab).toBe('docs');
    act(() => placement?.close());
    expect(placement?.open).toBe(false);
    // Closing does not disturb which tab was shown.
    expect(placement?.tab).toBe('usage');

    act(() => renderer?.unmount());
  });

  it('show() opens Info on a tab, and on a Folder sub-tab when one is given', () => {
    let placement: ReturnType<typeof useInfoPlacement> | undefined;
    let renderer: ReactTestRenderer | undefined;
    const Probe = () => {
      placement = useInfoPlacement();
      return null;
    };
    act(() => {
      renderer = create(createElement(Probe));
    });
    act(() => placement?.show('runtime'));
    expect(placement).toMatchObject({ open: true, tab: 'runtime', folderTab: 'files' });

    act(() => placement?.show('folder', 'mcp'));
    expect(placement).toMatchObject({ open: true, tab: 'folder', folderTab: 'mcp' });

    act(() => renderer?.unmount());
  });
});
