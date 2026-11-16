/**
 * How a ferret's `fy` reaches its daemon: the address it reads, the restart it waits out, the plugin inventory it holds
 * and the one connection built from them. The full world (`adapters/world.ts`) and the slim `mcp serve` entry both build
 * a ferret's connection here, so the two cannot disagree about what a ferret sends or where.
 */
import { PluginInventorySchema } from '@ferretry/kernel/contract';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { isLocalDaemonUrl, parseDaemonRun, resolveDaemonUrl } from '../../lib/address.ts';
import { InventoryCache } from '../../lib/client.ts';
import { type Environment, ownFerretId } from '../../lib/credential.ts';
import { DaemonRefusal, ShellError } from '../../lib/errors.ts';
import { daemonRunPath } from '../../lib/home.ts';
import type { Connection } from '../../lib/world.ts';
import { SessionCredentialGateway } from '../agent-tools/session-credential-gateway.ts';
import type { DaemonTransport } from '../../lib/client.ts';
import { type Fetcher, type RestartWaiting } from './http-transport.ts';
import { readDaemonRunDocument, readHomePort } from './run-file.ts';
import { sleepUnlessAborted } from './sleep.ts';

/** Where the daemon is and which process answers there: the run record, read each time (a new daemon decides its own port). */
export interface DaemonAddressing {
  /** Whether `FY_URL` pins the address, so the run record is not consulted. */
  readonly pinned: boolean;
  readonly baseUrl: () => Promise<string>;
  /** Which daemon process answers: a new pid in the run record is a restart, and drops the held inventory (§9.6). */
  readonly instance: () => Promise<string | undefined>;
}

export function daemonAddressing(environment: Environment, home: string): DaemonAddressing {
  const pinned = (environment.FY_URL?.trim() ?? '') !== '';
  const run = async () => parseDaemonRun(await readDaemonRunDocument(daemonRunPath(home)));
  return {
    pinned,
    baseUrl: async () =>
      resolveDaemonUrl(
        environment.FY_URL ?? '',
        pinned ? undefined : await run(),
        pinned ? undefined : await readHomePort(home),
      ),
    instance: async () => {
      if (pinned) return undefined;
      const recorded = await run();
      return recorded === undefined ? undefined : String(recorded.pid);
    },
  };
}

/** A restart is waited out, and said once on the terminal's error channel. */
export function restartWaiting(io: Pick<TerminalIo, 'err'>, binary: string): RestartWaiting {
  let told = false;
  return {
    patience: {
      expected: () => true,
      waiting: () => {
        if (told) return;
        told = true;
        io.err(`${binary}: daemon restarting, retrying for up to 60s…\n`);
      },
    },
    nowMs: () => Date.now(),
    sleep: sleepUnlessAborted,
  };
}

/** The held plugin inventory, read through `transport` (the safe bootstrap read). */
export function inventoryCache(transport: DaemonTransport, instance: DaemonAddressing['instance']): InventoryCache {
  return new InventoryCache(async () => {
    const reply = await transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true });
    if (reply.status !== 200) {
      const said = (reply.body as { error?: unknown } | undefined)?.error;
      throw new DaemonRefusal(
        typeof said === 'string' ? said : `the daemon answered HTTP ${String(reply.status)} to the plugin list`,
        reply.status,
      );
    }
    const parsed = PluginInventorySchema.safeParse(reply.body);
    if (!parsed.success)
      throw new ShellError('the daemon’s plugin list was not in a shape this fy reads; update fy or the daemon');
    return parsed.data;
  }, instance);
}

/** Said when a local credential would go to an address that is not this machine (S57). */
export const remoteRefusal = (address: string): string =>
  `FY_TOKEN is required when the daemon is not on this machine (${address}); local daemon credentials are never sent remotely. Set FY_TOKEN to that daemon's own token.`;

export interface FerretConnectionInputs {
  readonly environment: Environment;
  readonly addressing: DaemonAddressing;
  readonly restart: RestartWaiting;
  readonly fetcher: Fetcher;
  /** The ferret's own `fys_` credential. */
  readonly bearer: string;
}

/** A ferret never starts a daemon: it exists because one ran. So this probes nothing and launches nothing. */
export async function openFerretConnection(inputs: FerretConnectionInputs): Promise<Connection> {
  const { environment, addressing, restart, fetcher, bearer } = inputs;
  const address = await addressing.baseUrl();
  if (!isLocalDaemonUrl(address)) throw new ShellError(remoteRefusal(address));
  const ferretId = ownFerretId(environment);
  const transport = new SessionCredentialGateway({
    baseUrl: addressing.baseUrl,
    bearer,
    ...(ferretId === undefined ? {} : { ferretId }),
    restart,
    fetcher,
  });
  return { baseUrl: address, transport, inventory: inventoryCache(transport, addressing.instance) };
}
