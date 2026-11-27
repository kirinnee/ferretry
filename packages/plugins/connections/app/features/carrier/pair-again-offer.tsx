/**
 * THE "PAIR AGAIN" OFFER FOR A RELAY-ONLY MACHINE THAT HAS STAYED UNREACHABLE (C-80b), in the two places it can appear.
 *
 * A relay-only browser cannot tell a reinstalled machine from a sleeping one (a relay's `4404` reads the same), so after
 * about ten minutes of outage the person is offered pairing again and decides. The offer claims nothing and changes no
 * stored pairing.
 *
 * - On the machine's Connection card ({@link PairAgainOffer} inside `ActiveCarrierCard`), where the machine's own screens
 *   are readable.
 * - On the machine's stop screen, where they are not: a machine whose plugin list cannot be read is replaced by one full
 *   page and no panel of this plugin is drawn at all, so the SAME offer is also a device view ({@link pairAgainView})
 *   mounted once at the frame root. It stands down while the Connection card of that machine is on screen, so the
 *   offer is never drawn twice.
 */
import { type DaemonList, type PairedDaemon, pairAgainHref, useOptionalRouter } from '@ferretry/app';
import { createElement, useEffect, useState, useSyncExternalStore } from 'react';
import type { ConnectionHealthState, DaemonConnectionHealth } from '../../lib/connection-health.ts';
import { PAIR_AGAIN_COPY, pairAgainOffered } from '../connection/connection-copy.ts';
import { Button } from '../../shell/primitives.tsx';
import { useConnectionCardShown } from './relay-fallback-notice.tsx';

/**
 * Whether this device can reach the machine ONLY over a relay: it did not pair over a direct address and its stored carrier
 * set names no direct address or tunnel. Only then can no direct or tunnel leg ever prove the daemon was replaced
 * (`replacedProof`), which is what makes a long outage ambiguous enough to offer pairing again.
 */
export const relayOnly = (daemon: PairedDaemon | undefined): boolean =>
  daemon !== undefined &&
  daemon.pairedOver !== 'direct' &&
  !daemon.carriers.some(carrier => {
    const kind = (carrier as { kind?: unknown } | null)?.kind;
    return kind === 'direct' || kind === 'tunnel';
  });

/** The line and the button: the one block both places draw. */
export function PairAgainOffer({ onPairAgain }: { readonly onPairAgain: () => void }) {
  return (
    <div className="mt-3" data-pair-again="">
      <p className="mb-0 text-cell leading-base text-muted">{PAIR_AGAIN_COPY.line}</p>
      <Button type="button" size="sm" className="mt-2 min-h-[44px]" onClick={onPairAgain} data-pair-again-button="">
        {PAIR_AGAIN_COPY.button}
      </Button>
    </div>
  );
}

/** What the device view reads: how well each machine is reached, the clock that measured it, and the paired list. */
export interface PairAgainPorts {
  readonly health: Pick<DaemonConnectionHealth, 'state' | 'subscribe'>;
  readonly now: () => number;
  readonly daemons: Pick<DaemonList, 'snapshot' | 'subscribe'>;
}

const noHealth: ConnectionHealthState = Object.freeze({ kind: 'unknown' });

function PairAgainFor({
  daemon,
  ports,
  navigate,
}: {
  readonly daemon: PairedDaemon;
  readonly ports: PairAgainPorts;
  readonly navigate: (to: string) => void;
}) {
  const health = useSyncExternalStore(
    listener => ports.health.subscribe(daemon.daemon, listener),
    () => ports.health.state(daemon.daemon),
    () => noHealth,
  );
  const down = health.kind === 'reconnecting';
  const [now, setNow] = useState(ports.now);
  // The age keeps counting while the outage is on screen, on the clock the health model measured it by.
  useEffect(() => {
    if (!down) return;
    setNow(ports.now());
    const handle = globalThis.setInterval(() => setNow(ports.now()), 1000);
    return () => globalThis.clearInterval(handle);
  }, [down, ports]);
  // Only the machine on screen speaks, and not while its own Connection card (which says the same) is drawn.
  const where = useOptionalRouter()?.route;
  const onScreen =
    where === undefined ||
    (where.kind !== 'home' && where.kind !== 'device-settings' && 'daemon' in where && where.daemon === daemon.daemon);
  const cardUp = useConnectionCardShown(daemon.daemon);
  if (
    health.kind !== 'reconnecting' ||
    !onScreen ||
    cardUp ||
    !relayOnly(daemon) ||
    !pairAgainOffered(health.since, now)
  )
    return null;
  return (
    <div
      role="status"
      data-pair-again-notice={daemon.daemon}
      className="fy-shell-line m-0 min-w-0 border-b border-border px-3 py-1.5 text-fg"
    >
      <p className="m-0">{`This browser can’t reach ${daemon.machine} right now.`}</p>
      <PairAgainOffer onPairAgain={() => navigate(pairAgainHref(daemon.daemon, 'unreachable'))} />
    </div>
  );
}

/** The device view the frame mounts once: one notice per paired machine that is relay-only and long unreachable. */
export function pairAgainView(ports: () => PairAgainPorts | undefined) {
  return function PairAgain({ navigate }: { readonly navigate: (to: string) => void }) {
    const held = ports();
    return held === undefined ? null : createElement(PairedPairAgain, { held, navigate });
  };
}

function PairedPairAgain({
  held,
  navigate,
}: {
  readonly held: PairAgainPorts;
  readonly navigate: (to: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    listener => held.daemons.subscribe(listener),
    () => held.daemons.snapshot(),
    () => held.daemons.snapshot(),
  );
  return createElement(
    'div',
    { className: 'flex min-w-0 flex-col' },
    snapshot.daemons.map(daemon => createElement(PairAgainFor, { key: daemon.daemon, daemon, ports: held, navigate })),
  );
}
