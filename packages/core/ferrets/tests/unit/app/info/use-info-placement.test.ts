/** Where Info stands on one ferret's header: open or shut, which tab, and the phone sheet's half/full height. */

import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useInfoPlacement } from '../../../../app/features/info/use-info-placement.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const probe = (initial?: 'overview' | 'runtime') => {
  const seen: { placement?: ReturnType<typeof useInfoPlacement> } = {};
  let renderer: ReactTestRenderer | undefined;
  const Probe = () => {
    seen.placement = useInfoPlacement(initial);
    return null;
  };
  act(() => {
    renderer = create(createElement(Probe));
  });
  const placement = (): ReturnType<typeof useInfoPlacement> => {
    if (seen.placement === undefined) throw new Error('not rendered');
    return seen.placement;
  };
  return { placement, unmount: () => act(() => renderer?.unmount()) };
};

describe('useInfoPlacement', () => {
  it('starts shut on Overview with a half sheet when given no initial tab', () => {
    const { placement, unmount } = probe();
    expect(placement()).toMatchObject({ open: false, tab: 'overview', sheetSize: 'half' });
    unmount();
  });

  it('opens on the given tab from the start when handed one', () => {
    const { placement, unmount } = probe('runtime');
    expect(placement()).toMatchObject({ open: true, tab: 'runtime' });
    unmount();
  });

  it('toggles open and shut, and a fresh open is a half sheet again', () => {
    const { placement, unmount } = probe();
    act(() => placement().toggle());
    expect(placement().open).toBe(true);
    act(() => placement().setSheetSize('full'));
    expect(placement().sheetSize).toBe('full');
    act(() => placement().close());
    expect(placement().open).toBe(false);
    act(() => placement().toggle());
    expect(placement()).toMatchObject({ open: true, sheetSize: 'half' });
    unmount();
  });

  it('shows a tab: selects it and opens the panel', () => {
    const { placement, unmount } = probe();
    act(() => placement().show('runtime'));
    expect(placement()).toMatchObject({ open: true, tab: 'runtime' });
    act(() => placement().setTab('overview'));
    expect(placement().tab).toBe('overview');
    unmount();
  });
});
