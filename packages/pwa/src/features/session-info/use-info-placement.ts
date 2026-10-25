/**
 * Where Info stands on one session page: open or shut, which tab, which Context sub-tab, and — on a
 * phone — whether the sheet is at half or full height. One placement per page, so the header's ⓘ, a
 * `/skill` chip in the transcript ("show me that skill") and Info's own tabs move the same panel.
 *
 * Shut by default: Info is for looking, and looking is something a person asks for. Its width on a
 * desktop is remembered by the workspace's rail preference (the right rail's), not here.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ContextRailTab } from '../context-rail/context-rail-model.ts';
import type { InfoTab } from './info-model.ts';
import type { InfoSheetSize } from './info-panel.tsx';

export interface InfoPlacement {
  readonly open: boolean;
  readonly tab: InfoTab;
  readonly folderTab: ContextRailTab;
  readonly sheetSize: InfoSheetSize;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly setTab: (tab: InfoTab) => void;
  readonly setFolderTab: (tab: ContextRailTab) => void;
  readonly setSheetSize: (size: InfoSheetSize) => void;
  /** Opens Info on `tab` (and a Context sub-tab), wherever it lives on this screen. */
  readonly show: (tab: InfoTab, folderTab?: ContextRailTab) => void;
}

/** `initial`: open on this tab from the start (a harness, a deep link). Absent: shut, on Overview. */
export function useInfoPlacement(initial?: InfoTab): InfoPlacement {
  const [open, setOpen] = useState(initial !== undefined);
  const [tab, setTab] = useState<InfoTab>(initial ?? 'overview');
  const [folderTab, setFolderTab] = useState<ContextRailTab>('files');
  const [sheetSize, setSheetSize] = useState<InfoSheetSize>('half');
  const toggle = useCallback(() => {
    setOpen(value => !value);
    setSheetSize('half');
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback((next: InfoTab, folder?: ContextRailTab) => {
    setTab(next);
    if (folder !== undefined) setFolderTab(folder);
    setOpen(true);
  }, []);
  return useMemo(
    () => ({ open, tab, folderTab, sheetSize, toggle, close, setTab, setFolderTab, setSheetSize, show }),
    [open, tab, folderTab, sheetSize, toggle, close, show],
  );
}
