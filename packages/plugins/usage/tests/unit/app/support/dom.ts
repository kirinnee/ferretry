import { ensureDom } from '@ferretry/app/testing';

/** The address every usage test that reads `window.location` starts from: an in-app link navigates from here. */
const START = 'https://pwa.example.test/';

/**
 * A test that clicks an in-app link and reads `window.location` OWNS its DOM and its address.
 *
 * Every unit file shares one process, so the `window` a file finds is whatever an earlier file left: none at all when
 * the file runs alone ("window is not defined"), or a happy-dom window on `about:blank` (pathname "blank") when an
 * earlier file registered one without an address, so `history.replaceState({}, '', '/')` cannot move it and the
 * router's `pushState` lands nowhere the test reads. `ensureDom()` registers one (idempotent) and the address is
 * put back to the app origin before each test, whoever registered the window.
 */
export const ownDomAtAppOrigin = (): void => {
  ensureDom();
  const dom = window as typeof window & { happyDOM?: { setURL(url: string): void } };
  if (window.location.origin !== new URL(START).origin) dom.happyDOM?.setURL(START);
  window.history.replaceState({}, '', '/');
};
