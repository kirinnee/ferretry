import type { StatePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { TunnelOriginSchema } from '../../contract/index.ts';
import manifest from '../../manifest.ts';
import type { TunnelHolding, TunnelHoldingPort } from '../../daemon/lib/tunnel/carrier.ts';

const HoldingSchema = z.strictObject({ origin: z.string().min(1).max(2048), tunnelUrl: TunnelOriginSchema });

/** The kernel stamps format:1 and writes atomically with owner-only permissions. Never stores the connector token. */
export class FileTunnelHolding implements TunnelHoldingPort {
  constructor(private readonly state: StatePort) {}
  async read(): Promise<TunnelHolding | undefined> {
    const found = await this.state.read(manifest.data.state[0]);
    if (!found.ok) throw new Error(found.error.sentence);
    return found.value === undefined ? undefined : HoldingSchema.parse(found.value);
  }
  async record(holding: TunnelHolding): Promise<void> {
    await this.state.write(manifest.data.state[0], HoldingSchema.parse(holding));
  }
  async forget(): Promise<void> {
    await this.state.remove(manifest.data.state[0]);
  }
}
