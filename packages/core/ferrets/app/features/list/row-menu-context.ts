import { createContext } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';

export type RowMenuTrigger = 'mouse' | 'touch' | 'keyboard';

export interface RowMenuRequest {
  readonly ferret: FerretSummary;
  readonly x: number;
  readonly y: number;
  readonly trigger: RowMenuTrigger;
  /** Gives focus back to the row the menu came from; false when that row left the page. */
  readonly focusRow: () => boolean;
}

/** Opens the row menu; `undefined` = this host draws no row menu (rows then carry no menu and no ⋯). */
export const RowMenuContext = createContext<((request: RowMenuRequest) => void) | undefined>(undefined);
