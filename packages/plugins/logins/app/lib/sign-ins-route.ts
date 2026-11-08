/**
 * How the Sign-ins tab's one page is addressed (docs/design/account-model.md §4.2, O1): the hash
 * `#machines/<machine>/sign-ins/<loginId>`, the same address Runtimes writes when it links a login
 * ("Add a new login in Sign-ins", a login that needs sign-in), so a link from another tab lands on
 * the login's own page.
 *
 * This is Logins' own reading of the address — the words `machines` and `sign-ins` are the tab's, and
 * no code here imports another plugin to read them. The tab reads it when it mounts and when it
 * changes, so Back works and a copied link reads as the page it was looking at; opening a page from
 * the tab writes it back, so the address always names the page on screen.
 */

import { useCallback, useEffect, useState } from 'react';

/** The first word of a Machines hash, and the tab's own word in it. */
const MACHINES = 'machines';
const TAB = 'sign-ins';

/** The login a Machines link names (`#machines/<machine>/sign-ins/<loginId>`), or `null` for the list. */
export const loginFromHash = (hash: string): string | null => {
  const [section, , tab, item] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES || tab !== TAB || item === undefined || item === '') return null;
  try {
    return decodeURIComponent(item);
  } catch {
    return null;
  }
};

/** The link to one login's page, or to the tab's list. */
export const signInsHash = (machine: string, loginId?: string): string =>
  `#${MACHINES}/${encodeURIComponent(machine)}/${TAB}${loginId === undefined ? '' : `/${encodeURIComponent(loginId)}`}`;

/**
 * Which login's page the link names, and a way to open another. Follows the browser's Back and
 * Forward, because the page is in the address. `machine` is the machine the list named — the link
 * cannot be written before the read lands, and no page can be opened before then either.
 */
export function useSignInsLogin(
  machine: string | null,
  browser: Window = window,
): readonly [string | null, (loginId: string | null) => void] {
  const [detail, setDetail] = useState(() => loginFromHash(browser.location.hash));
  useEffect(() => {
    const read = (): void => setDetail(loginFromHash(browser.location.hash));
    read();
    browser.addEventListener('hashchange', read);
    return () => browser.removeEventListener('hashchange', read);
  }, [browser]);
  const open = useCallback(
    (loginId: string | null): void => {
      if (machine !== null) browser.location.hash = signInsHash(machine, loginId ?? undefined);
      setDetail(loginId);
    },
    [browser, machine],
  );
  return [detail, open];
}
