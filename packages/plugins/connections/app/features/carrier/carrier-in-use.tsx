/**
 * "IN USE NOW" — the one line that sits above the connection preference (`docs/relay-protocol.md` §1, §15).
 *
 * The preference is what a person ASKED for; this is what is carrying the connection. They differ exactly when it
 * matters: the default preference ticked as "Relay (default)" while the direct address carries, because the relay
 * could not be reached. So the line states the measured carrier on its own — never the preference, never a guess
 * ("Not measured yet" before anything was carried) — and says plainly when direct stands in for a relay. It is a
 * status, not an error: nothing here is red.
 */

import type { ConnectionChoice } from '../../lib/connection.ts';
import type { ConnectionHealthState } from '../../lib/connection-health.ts';
import {
  CONNECTION_STATUS_LABEL,
  carrierDetail,
  connectionStatusKind,
  NOT_CONNECTED_LABEL,
} from './active-carrier-card.tsx';

export interface CarrierInUseProps {
  /** What the router measured for this machine, or `undefined` before anything has been carried. */
  readonly choice: ConnectionChoice | undefined;
  /** The reconnect loop's state for this machine; absent reads as nothing measured yet. */
  readonly health?: ConnectionHealthState | undefined;
  /** Said while the paired direct address stands in for an unreachable relay (the default preference only). */
  readonly relayFallback?: string | undefined;
}

export function CarrierInUse({ choice, health, relayFallback }: CarrierInUseProps) {
  const method = choice?.ok === true ? choice.method : undefined;
  const status = connectionStatusKind(method, health);
  const detail = method === undefined || status === 'reconnecting' ? undefined : carrierDetail(method);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-carrier-in-use={status}>
      <p role="status" className="m-0 text-cell leading-base text-fg">
        <span className="text-muted">In use now: </span>
        <span className="font-semibold">
          {status === 'none' && choice?.ok === false ? NOT_CONNECTED_LABEL : CONNECTION_STATUS_LABEL[status]}
        </span>
        {detail === undefined ? null : <span className="text-muted"> — {detail}</span>}
      </p>
      {relayFallback === undefined ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-carrier-in-use-why="">
          {relayFallback}
        </p>
      )}
    </div>
  );
}
