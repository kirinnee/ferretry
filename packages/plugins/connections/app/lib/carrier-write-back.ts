import type { DaemonList, PairedDaemon } from '@ferretry/app';
import { PublishedCarriersSchema, type PublishedCarriers } from '../../contract/index.ts';

/**
 * THE DAEMON IS AUTHORITATIVE AND A DEVICE'S STORED CARRIERS ARE A CACHE OF ITS ANSWER (P51, R170, R186, R210).
 *
 * `GET /v1/carriers` answers inside a session the paired device key opened, so the answer proves the connection worked.
 * What this device stores for that daemon is then REPLACED by the answer: never merged with what was stored before, so a
 * relay the daemon withdrew disappears here too (R198), and the router, which tells a republish from the same set by
 * comparing them, closes what stood on it at the next walk.
 *
 * Two refusals keep that replacement honest:
 *
 * - An answer for a pairing that has since changed is dropped. The refresh began as one pairing (a device id, the address
 *   it was paired over); if this device was re-paired or unpaired while the request was in flight, the answer belongs to
 *   a pairing that no longer exists and must not overwrite the new one's set.
 * - An empty answer is not written. It travelled a carrier that worked, so it contradicts its own evidence; written
 *   through it would leave a reachable daemon with nothing to dial and no request left that could ever say otherwise.
 */
export type StoredCarrierSets = Pick<DaemonList, 'get' | 'setCarriers'>;

export interface CarrierWriteBack {
  /**
   * Begin a refresh for `daemon`, as the pairing the device holds right now. The returned adopter writes the daemon's
   * answer for that pairing, and answers whether it wrote anything.
   */
  begin(daemon: string): (carriers: PublishedCarriers) => boolean;
  /**
   * Keep (`tunnel` given) or forget (`undefined`) the tunnel this device stores for `daemon`, on what the DAEMON said
   * about its own switch (R635): up at a hostname is kept, off or unable to run is forgotten. The one write that can
   * tell a withdrawn tunnel from one that is only reconnecting. Fenced to the pairing the device holds right now.
   */
  replaceTunnel(daemon: string, tunnel: TunnelCarrier | undefined): boolean;
  /** Whether the set stored for `daemon` names a tunnel. */
  holdsTunnel(daemon: string): boolean;
}

/** The tunnel this device keeps, as the connection model names it. */
interface TunnelCarrier {
  readonly kind: 'tunnel';
  readonly tunnelUrl: string;
}

const sameSet = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** The tunnel entries of a stored set, as the contract admits them. */
const tunnelsOf = (stored: readonly unknown[]): PublishedCarriers => {
  const parsed = PublishedCarriersSchema.safeParse(stored.filter(isTunnelEntry));
  return parsed.success ? parsed.data : [];
};

const isTunnelEntry = (entry: unknown): boolean => (entry as { kind?: unknown } | null)?.kind === 'tunnel';

const samePairing = (left: PairedDaemon, right: PairedDaemon | undefined): boolean =>
  right !== undefined && left.deviceId === right.deviceId && left.address === right.address;

export function carrierWriteBack(daemons: StoredCarrierSets): CarrierWriteBack {
  return {
    begin(daemon) {
      const issued = daemons.get(daemon);
      return carriers => {
        if (issued === undefined || carriers.length === 0) return false;
        // The set is parsed again at the door: what is stored is exactly what the contract admits.
        const parsed = PublishedCarriersSchema.safeParse(carriers);
        if (!parsed.success) return false;
        const current = daemons.get(daemon);
        if (current === undefined || !samePairing(issued, current)) return false;
        // A TUNNEL IS THE ONE ENTRY A REFRESH DOES NOT WITHDRAW BY OMISSION (R635, §15). The daemon publishes its
        // tunnel only while `cloudflared` holds an edge connection, so a set read during the connector's reconnect says
        // "not right now", not "gone", and under "Tunnel only" the hostname is the one thing this device cannot learn
        // back without it. The last tunnel stays until the daemon publishes a different one, or says its tunnel is off
        // (`replaceTunnel`); a hostname that really is gone fails to dial, which sends a "Tunnel only" walk to ask.
        const kept = parsed.data.some(carrier => carrier.kind === 'tunnel') ? [] : tunnelsOf(current.carriers);
        const next = PublishedCarriersSchema.safeParse([...parsed.data, ...kept]);
        if (!next.success) return false;
        // The same answer is not a new snapshot: no write, no notification.
        if (sameSet(current.carriers, next.data)) return false;
        daemons.setCarriers(daemon, next.data);
        return true;
      };
    },
    replaceTunnel(daemon, tunnel) {
      const current = daemons.get(daemon);
      if (current === undefined) return false;
      const parsed = PublishedCarriersSchema.safeParse(current.carriers.filter(carrier => !isTunnelEntry(carrier)));
      if (!parsed.success) return false;
      const next = PublishedCarriersSchema.safeParse(
        tunnel === undefined ? parsed.data : [...parsed.data, { kind: 'tunnel', url: tunnel.tunnelUrl }],
      );
      if (!next.success || sameSet(current.carriers, next.data)) return false;
      daemons.setCarriers(daemon, next.data);
      return true;
    },
    holdsTunnel: daemon => daemons.get(daemon)?.carriers.some(isTunnelEntry) === true,
  };
}
