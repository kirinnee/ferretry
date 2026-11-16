/**
 * THE LINE SAID WHILE THE DIRECT ADDRESS STANDS IN FOR AN UNREACHABLE RELAY (`docs/relay-protocol.md` §15).
 *
 * The default preference is Relay and asks nothing; when the relay cannot carry a session, the address this device paired
 * over does, and a surface that names the live carrier must say it is direct BECAUSE the relay failed — never leave a
 * person believing the relay is working. It is a status line, so a reader on assistive tech hears it appear and go.
 */

import { type BackgroundViewProps } from '@ferretry/app';
import { createElement, useEffect, useSyncExternalStore } from 'react';
import type { CarrierRouter } from '../../carriers/router.ts';

/**
 * The machines whose Connection card is on screen right now. The card says the line itself, so the frame's status line
 * for that machine stays quiet: one screen, one telling. Everywhere else the frame's line is the only place to hear it.
 */
const cardsOnScreen = new Map<string, number>();
const cardListeners = new Set<() => void>();
const announceCards = (): void => {
  for (const listener of cardListeners) listener();
};
const subscribeCards = (listener: () => void): (() => void) => {
  cardListeners.add(listener);
  return () => {
    cardListeners.delete(listener);
  };
};

/** Registers a Connection card for `daemon` while it is mounted, so the frame's status line does not repeat it. */
export function useConnectionCardOnScreen(daemon: string | undefined): void {
  useEffect(() => {
    if (daemon === undefined) return undefined;
    cardsOnScreen.set(daemon, (cardsOnScreen.get(daemon) ?? 0) + 1);
    announceCards();
    return () => {
      const left = (cardsOnScreen.get(daemon) ?? 1) - 1;
      if (left <= 0) cardsOnScreen.delete(daemon);
      else cardsOnScreen.set(daemon, left);
      announceCards();
    };
  }, [daemon]);
}

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
    const cardSaysIt = useSyncExternalStore(
      subscribeCards,
      () => cardsOnScreen.has(daemon),
      () => false,
    );
    return line === undefined || cardSaysIt ? null : createElement(RelayFallbackNotice, { line });
  };
}
