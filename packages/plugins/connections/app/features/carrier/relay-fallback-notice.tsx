/**
 * THE LINE SAID WHILE THE DIRECT ADDRESS STANDS IN FOR AN UNREACHABLE RELAY (`docs/relay-protocol.md` §15).
 *
 * The default preference is Relay and asks nothing; when the relay cannot carry a session, the address this device paired
 * over does, and a surface that names the live carrier must say it is direct BECAUSE the relay failed — never leave a
 * person believing the relay is working. It is a status line, so a reader on assistive tech hears it appear and go.
 */

import { type BackgroundViewProps, type PairedDaemon, useOptionalRouter, usePairedDaemons } from '@ferretry/app';
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

/**
 * The line itself, as a QUIET status: the connection works, so it is not an error (no red, no warning tone). It is a
 * note about which way in is being used and why.
 */
export function RelayFallbackNotice({ line }: { readonly line: string }) {
  return (
    <p role="status" className="fy-shell-line fy-shell-line--info text-meta text-muted" data-relay-fallback="">
      {line}
    </p>
  );
}

/**
 * The line as ONE machine says it. With a single machine paired it is the plain line; with several, each machine's line
 * names its machine (and, for two that share a host name, the tail of its id) so two fallbacks never read as one
 * line said twice.
 */
export function relayFallbackLine(line: string, daemons: readonly PairedDaemon[], daemon: string): string {
  if (daemons.length < 2) return line;
  const mine = daemons.find(candidate => candidate.daemon === daemon);
  if (mine === undefined || mine.machine === '') return line;
  const twin = daemons.some(other => other.daemon !== daemon && other.machine === mine.machine);
  return `${mine.machine}${twin ? ` (…${daemon.slice(-4)})` : ''}: ${line}`;
}

/**
 * A background view, mounted once per paired daemon where Connections may run: it draws the line while that daemon is
 * carried by the paired direct address, and nothing otherwise. It follows the router, so the line goes the moment the
 * relay answers again. It speaks only on a settings screen (where connection matters); on every other page the
 * connection simply works and the page stays clean. With no router mounted (a harness) it speaks.
 */
export function relayFallbackView(router: () => Pick<CarrierRouter, 'subscribe' | 'relayFallback'> | undefined) {
  return function RelayFallbackWatcher({ daemon }: BackgroundViewProps) {
    const held = router();
    const daemons = usePairedDaemons();
    const where = useOptionalRouter()?.route.kind;
    const matters = where === undefined || where === 'device-settings' || where === 'daemon-settings';
    const read = () => held?.relayFallback(daemon);
    const line = useSyncExternalStore(listener => held?.subscribe(listener) ?? (() => undefined), read, read);
    const cardSaysIt = useSyncExternalStore(
      subscribeCards,
      () => cardsOnScreen.has(daemon),
      () => false,
    );
    return line === undefined || cardSaysIt || !matters
      ? null
      : createElement(RelayFallbackNotice, { line: relayFallbackLine(line, daemons, daemon) });
  };
}
