/**
 * Connections' port (§2.3): the carriers this daemon publishes, for the screens and answers that name them (the
 * pairing mint, a member's join answer). Read-only: a carrier moves sealed bytes and can never mark a call local.
 */
import type { ConnectionAdvertisement } from './advertisement.ts';
import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { CarrierKindSchema, type PublishedCarriers, type TunnelStatusView } from './wire.ts';

export interface ConnectionsApi {
  /** What `GET /v1/carriers` answers now: current, never cached. */
  carriers(): PublishedCarriers;
  /** Host-facing pairing reach; provenance is never inferred from the carrier list. */
  advertisement(): ConnectionAdvertisement;
  tunnel(): Promise<TunnelStatusView>;
}

export const ConnectionsPort = definePort<ConnectionsApi>('connections');

/** The published carrier set changed (a tunnel came up, the relay was switched off). Read the port for the truth. */
export const CarriersChanged = defineEvent(
  'connections.carriers-changed',
  z.strictObject({ kinds: z.array(CarrierKindSchema).readonly() }),
);
