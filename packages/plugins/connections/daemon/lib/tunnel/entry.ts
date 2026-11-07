import { z } from 'zod';

/** The resolved tunnel entry; configuration storage is owned by the Connections builder. */
export const DaemonTunnelCarrierSchema = z.strictObject({
  kind: z.literal('tunnel'),
  source: z.literal('discovery'),
  enabled: z.boolean().default(false),
});
export type DaemonTunnelCarrierEntry = z.infer<typeof DaemonTunnelCarrierSchema>;
export const IMPLIED_TUNNEL_CARRIER: DaemonTunnelCarrierEntry = {
  kind: 'tunnel',
  source: 'discovery',
  enabled: false,
};
