/**
 * The app's reads of this machine's runtimes (`GET /v1/runtimes`), parsed at the edge through the contract's
 * schema. Pure over an injected client; no hook, no clock, no network of its own.
 */

import { type RuntimeCatalog, RuntimeCatalogSchema } from '../../contract/index.ts';
import type { RuntimesClient } from './client.ts';

export const RUNTIMES_ROUTE = 'GET /v1/runtimes' as const;

export const readRuntimes = async (client: RuntimesClient): Promise<RuntimeCatalog> =>
  RuntimeCatalogSchema.parse(await client.call(RUNTIMES_ROUTE));

/**
 * WHETHER THIS MACHINE HAS NO RUNTIME, so the empty Sessions list can say what to do about it.
 *
 * It claims nothing until the machine has answered: a machine that cannot be read is "unknown" (`undefined`), never
 * "needs one".
 */
export const readNeedsRuntime = async (client: RuntimesClient): Promise<boolean | undefined> => {
  try {
    return (await readRuntimes(client)).runtimes.length === 0;
  } catch {
    return undefined;
  }
};
