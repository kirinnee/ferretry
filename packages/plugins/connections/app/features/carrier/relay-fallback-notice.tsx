/**
 * THE LINE SAID WHILE THE DIRECT ADDRESS STANDS IN FOR AN UNREACHABLE RELAY (`docs/relay-protocol.md` §15).
 *
 * The default preference is Relay and asks nothing; when the relay cannot carry a session, the address this device paired
 * over does, and a surface that names the live carrier must say it is direct BECAUSE the relay failed — never leave a
 * person believing the relay is working. It is a status line, so a reader on assistive tech hears it appear and go.
 */

import { type BackgroundViewProps } from '@ferretry/app';
import { createElement, useSyncExternalStore } from 'react';
import type { CarrierRouter } from '../../carriers/router.ts';

/** The line itself, as a status. */
export function RelayFallbackNotice({ line }: { readonly line: string }) {
  return (
    <p role="status" className="fy-shell-line fy-shell-line--warn" data-relay-fallback="">
      {line}
    </p>
  );
}

/**
 * A background view, mounted once per paired daemon where Connections may run: it draws the line while that daemon is
 * carried by the paired direct address, and nothing otherwise. It follows the router, so the line goes the moment the
 * relay answers again.
 */
export function relayFallbackView(router: () => Pick<CarrierRouter, 'subscribe' | 'relayFallback'> | undefined) {
  return function RelayFallbackWatcher({ daemon }: BackgroundViewProps) {
    const held = router();
    const read = () => held?.relayFallback(daemon);
    const line = useSyncExternalStore(listener => held?.subscribe(listener) ?? (() => undefined), read, read);
    return line === undefined ? null : createElement(RelayFallbackNotice, { line });
  };
}
