/**
 * Where Info stands on one ferret's header: open or shut, which tab, and — on a phone — whether the sheet is at half
 * or full height. One placement per header, so the ⓘ and Info's own tabs move the same panel.
 *
 * Shut by default: Info is for looking, and looking is something a person asks for.
 */

import { useCallback, useMemo, useState } from 'react';
import type { InfoTab } from './info-model.ts';
import type { InfoSheetSize } from './info-panel.tsx';

export interface InfoPlacement {
  readonly open: boolean;
  readonly tab: InfoTab;
  readonly sheetSize: InfoSheetSize;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly setTab: (tab: InfoTab) => void;
  readonly setSheetSize: (size: InfoSheetSize) => void;
  /** Opens Info on `tab`. */
  readonly show: (tab: InfoTab) => void;
}

/** `initial`: open on this tab from the start (a deep link). Absent: shut, on Overview. */
export function useInfoPlacement(initial?: InfoTab): InfoPlacement {
  const [open, setOpen] = useState(initial !== undefined);
  const [tab, setTab] = useState<InfoTab>(initial ?? 'overview');
  const [sheetSize, setSheetSize] = useState<InfoSheetSize>('half');
  const toggle = useCallback(() => {
    setOpen(value => !value);
    setSheetSize('half');
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback((next: InfoTab) => {
    setTab(next);
    setOpen(true);
  }, []);
  return useMemo(
    () => ({ open, tab, sheetSize, toggle, close, setTab, setSheetSize, show }),
    [open, tab, sheetSize, toggle, close, show],
  );
}
