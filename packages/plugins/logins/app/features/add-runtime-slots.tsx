/**
 * What Logins draws on Runtimes' Add runtime page (its two slots; contract/slots.ts names them): the add-login panel
 * under the login list, and the sign-in panel under a picked login that needs one. Runtimes hands each plain callbacks;
 * a panel answers with a login's id or a bare "signed in" and nothing else — the harness's own sign-in runs in this
 * panel's client and no token, code or address is ever given to the page that mounts it (docs/design/harness-login.md).
 *
 * The props are untyped at the shell, so each panel checks what it reads and draws what it can without the rest.
 */

import type { ReactElement } from 'react';
import { createElement } from 'react';
import { isSupportedHarnessKey } from '../../contract/harness-words.ts';
import type { LoginsClient } from '../lib/client.ts';
import { AddLoginPanel } from './add-login-panel.tsx';
import { LoginSignInPanel } from './login-sign-in-panel.tsx';

const callback = <Args extends readonly unknown[]>(
  props: Readonly<Record<string, unknown>>,
  name: string,
): ((...args: Args) => void) | undefined => {
  const value = props[name];
  return typeof value === 'function' ? (value as (...args: Args) => void) : undefined;
};

/** The add-login panel; the page is told the new login's id so it can pick it. */
export function addRuntimeLoginPanel(client: LoginsClient, props: Readonly<Record<string, unknown>>): ReactElement {
  const onAdded = callback<[string]>(props, 'onAdded');
  return createElement(AddLoginPanel, { client, ...(onAdded === undefined ? {} : { onAdded }) });
}

/** The sign-in panel for the login the slot names as its `subject`; the page is told when it finished. */
export function addRuntimeSignInPanel(client: LoginsClient, props: Readonly<Record<string, unknown>>): ReactElement {
  const onSignedIn = callback<[]>(props, 'onSignedIn');
  const subject = typeof props['subject'] === 'string' ? props['subject'] : undefined;
  const harness = props['harness'];
  if (typeof harness !== 'string' || !isSupportedHarnessKey(harness))
    return createElement(
      'p',
      { className: 'm-0 text-cell leading-base text-muted', 'data-login-sign-in-panel': 'none' },
      'Name which tool this login signs in to.',
    );
  return createElement(LoginSignInPanel, {
    client,
    harness,
    ...(subject === undefined ? {} : { subject }),
    ...(onSignedIn === undefined ? {} : { onSignedIn }),
  });
}
