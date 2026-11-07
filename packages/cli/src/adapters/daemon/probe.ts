import { HealthSchema } from '@ferretry/kernel/contract';
import type { Probe } from '../../lib/world.ts';
import type { Fetcher } from './http-transport.ts';

/**
 * Reads the public `GET /v1/health`. No credential is read or sent: a fresh install has none yet, and `fy daemon
 * status` must be able to say the daemon is up before one exists.
 */
export async function probeHealth(
  baseUrl: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  timeoutMs = 3_000,
): Promise<Probe> {
  try {
    const response = await fetcher(`${baseUrl}/v1/health`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { state: 'down', baseUrl, why: `HTTP ${String(response.status)}` };
    const parsed = HealthSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success
      ? { state: 'up', baseUrl, health: parsed.data }
      : { state: 'down', baseUrl, why: 'something answered that is not a Ferretry daemon' };
  } catch (error) {
    return { state: 'down', baseUrl, why: error instanceof Error ? error.message : String(error) };
  }
}
