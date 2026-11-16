/**
 * The kernel's own real adapters, for the integration tier: a real child process, a real socket and the real clock,
 * handed to the adapters under test exactly as the host hands them to a plugin.
 */
import { bunSpawn, globalFetch, systemClock } from '@ferretry/kernel/host';
import { spawnHarnessLoginChild, harnessLoginTimer } from '../../daemon/adapters/harness-login/login-child.ts';
import { systemPortHolders } from '../../daemon/adapters/harness-login/port-holders.ts';
import { deliverCodexCallback } from '../../daemon/adapters/harness-login/callback-delivery.ts';

export const realClock = systemClock();
const realSpawn = bunSpawn({});
export const realFetch = globalFetch();

export const spawnChild = spawnHarnessLoginChild(realSpawn);
export const timer = harnessLoginTimer(realClock);
export const deliverCallback = deliverCodexCallback(realFetch, realClock);
export const realPortHolders = (tools?: Parameters<typeof systemPortHolders>[2]) =>
  systemPortHolders(realSpawn, realClock, tools);

/** The package's one condition wait: poll until something HAPPENED, never sleep for a time. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  options: { readonly within?: number; readonly every?: number } = {},
): Promise<void> {
  const within = options.within ?? 30_000;
  const every = options.every ?? 10;
  const deadline = Date.now() + within;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${within} ms waiting for ${what}`);
    await Bun.sleep(every);
  }
}

/** Resolve with the first value `read` returns that is not `undefined`; fail naming `what` at the safety net. */
export async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  options: { readonly within?: number; readonly every?: number } = {},
): Promise<T> {
  const within = options.within ?? 30_000;
  const every = options.every ?? 10;
  const deadline = Date.now() + within;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${within} ms waiting for ${what}`);
    await Bun.sleep(every);
  }
}
