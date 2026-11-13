/**
 * The slice of the kernel the file adapters' host stands on (`fleetHost`), over a {@link FleetWorld}: the real roots,
 * the person's home, a clock that advances a little on every wait, and a configuration port that holds nothing.
 */
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { FleetWorld } from '../../unit/support/fleet-world.ts';

export const kernelOver = (world: FleetWorld) => {
  let now = 1_000;
  const warned: string[] = [];
  const kernel = {
    roots: world.roots,
    paths: { home: () => world.person },
    clock: {
      nowMs: () => now,
      after: (_duration: unknown, run: () => void) => {
        now += 25;
        queueMicrotask(run);
        return () => undefined;
      },
    },
    log: { warn: (message: string) => warned.push(message) },
    identity: { daemonId: 'fy_daemon_test', daemonName: 'test' },
    config: {
      writeAll: async () => ({ kind: 'written' as const }),
      collection: () => new Map(),
      file: () => undefined,
      etag: async () => 'absent',
    },
  } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log' | 'identity'> & {
    config: Pick<KernelPorts['config'], 'writeAll' | 'collection' | 'file' | 'etag'>;
  };
  return { kernel, warned };
};
