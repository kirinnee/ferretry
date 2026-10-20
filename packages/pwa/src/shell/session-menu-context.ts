/**
 * HOW A ROW ASKS THE BAR TO OPEN ITS MENU. The bar holds one menu for every row in every presentation
 * and on every machine it lists, so a row reaches it through context instead of a prop threaded through
 * the tree, the machine groups and the Needs-you list. Absent means the bar offers no row menu.
 */

import type { SessionView } from '@ferretry/protocol';
import { createContext } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';

/** The ferret a press landed on, and the machine it runs on: session ids collide across machines. */
interface SessionMenuTarget {
  readonly view: SessionView;
  readonly daemonId: DaemonId;
}

/** Where the menu is, and for whom. `open` is false once it is dismissed but its hosts still live. */
export interface SessionMenuState extends SessionMenuTarget {
  readonly x: number;
  readonly y: number;
  readonly trigger: HTMLElement;
  /** A finger pressed it: a bottom sheet, not a menu at a point. */
  readonly touch: boolean;
  readonly open: boolean;
}

export type OpenRowMenu = (target: SessionMenuTarget, x: number, y: number, trigger: HTMLElement) => void;

export const SessionMenuContext = createContext<OpenRowMenu | undefined>(undefined);
