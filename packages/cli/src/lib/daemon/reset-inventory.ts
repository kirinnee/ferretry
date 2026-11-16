import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { IResetInventoryPort, ResetCounts } from './ports.ts';

/** The three reads, by the route keys their owners declare. A route no manifest declares is refused by the guard. */
export const RESET_ROUTES = {
  secrets: 'GET /v1/secrets',
  devices: 'GET /v1/pair/devices',
  ferrets: 'GET /v1/ferrets',
} as const;

/** Only the length of each list is read; the shape of an element is its owner's business, and a value is never read. */
const SecretsAnswer = z.object({ secrets: z.array(z.unknown()) });
const DevicesAnswer = z.object({ devices: z.array(z.unknown()) });
const FerretsAnswer = z.union([z.array(z.unknown()), z.object({ ferrets: z.array(z.unknown()) })]);

/**
 * Counts what a reset destroys unrecoverably, by asking the daemon that still holds it, through the guarded client of
 * this invocation (each owner is checked against this fy's contract hashes before the read goes out).
 *
 * NOTHING HERE FAILS A RESET. A daemon that will not answer is a daemon somebody is very likely resetting BECAUSE it
 * will not answer, so every failure is `undefined` and the preflight says the counts are unavailable while still
 * printing the paths and sizes it measured itself.
 */
export class ClientResetInventory implements IResetInventoryPort {
  constructor(
    private readonly secrets: Pick<PluginClient, 'call'>,
    private readonly devices: Pick<PluginClient, 'call'>,
    private readonly ferrets: Pick<PluginClient, 'call'>,
  ) {}

  async count(): Promise<ResetCounts | undefined> {
    try {
      const secrets = SecretsAnswer.parse(await this.secrets.call(RESET_ROUTES.secrets));
      const devices = DevicesAnswer.parse(await this.devices.call(RESET_ROUTES.devices));
      const listed = FerretsAnswer.parse(await this.ferrets.call(RESET_ROUTES.ferrets));
      return {
        secrets: secrets.secrets.length,
        devices: devices.devices.length,
        ferrets: Array.isArray(listed) ? listed.length : listed.ferrets.length,
      };
    } catch {
      return undefined;
    }
  }
}
