/** DOM helpers for the Inbox's toolbar menus and Find (kept apart from the harness so a browser scene can import that). */

import { interact, must } from './dom.ts';

/** The Inbox's filter menus: Show (`filter`), Ferrets (`kind`), Machine. */
type InboxMenu = 'filter' | 'kind' | 'machine';

/** Opens one of the Inbox's toolbar menus and picks `value` from its list, as the reader does. */
export const chooseFromMenu = async (root: ParentNode, menu: InboxMenu, value: string): Promise<void> => {
  await interact(() =>
    must(
      root.querySelector<HTMLButtonElement>(`[data-agenda-${menu}] [aria-haspopup="menu"]`),
      `the ${menu} menu`,
    ).click(),
  );
  await interact(() =>
    must(
      root.querySelector<HTMLElement>(`[data-agenda-${menu}-option="${value}"]`),
      `the ${menu} choice ${value}`,
    ).click(),
  );
};

/** Opens Find behind its search icon and returns the box. */
export const openFind = async (root: ParentNode): Promise<HTMLInputElement> => {
  if (root.querySelector('[data-agenda-find]') === null) {
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-agenda-find-open]'), 'the Find icon').click(),
    );
  }
  return must(root.querySelector<HTMLInputElement>('[data-agenda-find]'), 'the Find box');
};
