/**
 * A fleet world for the provisioner's tests: the kernel's REAL roots (`fleet`, `harness-home`) over a temp directory,
 * so a plugin test hears the refusals production gives. Tests are exempt from `banned-globals`; nothing here reads a
 * real home, and every directory is one this test made.
 *
 *   <parent>/fy-home/fleet      the fleet folder (the `fleet` root)
 *   <parent>/person/.claude     a person's own Claude home (a `harness-home` source)
 *   <parent>/person/.codex      a person's own Codex home
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { applyClaimFor } from '../../../daemon/adapters/apply-claim.ts';
import { FleetDisk, sourceMounts } from '../../../daemon/adapters/fleet-disk.ts';
import { FileFleetProvisioner } from '../../../daemon/adapters/file-provisioner.ts';
import type { ApplyLock, SharedHistoryPooling } from '../../../daemon/adapters/ports.ts';

export interface FleetWorld {
  readonly parent: string;
  readonly home: string;
  readonly fleet: string;
  readonly person: string;
  readonly roots: RootsPort;
  readonly disk: FleetDisk;
  /** The claim for the fleet, on a manual clock that never really waits. */
  readonly claimFor: (manifestPath: string, waitMs?: number) => ApplyLock;
  provisioner(options?: {
    readonly sharedHistory?: SharedHistoryPooling;
    readonly publishing?: <T>(mutate: () => Promise<T>) => Promise<T>;
    readonly disk?: FleetDisk;
  }): FileFleetProvisioner;
  cleanup(): Promise<void>;
}

const made: FleetWorld[] = [];

/** Removes every world a test made. Call from `afterEach`. */
export async function cleanupWorlds(): Promise<void> {
  for (const world of made.splice(0)) await world.cleanup();
}

export async function fleetWorld(): Promise<FleetWorld> {
  // realpath: macOS hands out /var/… for /private/var/…, and a folder compared by path must be canonical.
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-fleet-world-')));
  const home = join(parent, 'fy-home');
  const person = join(parent, 'person');
  await mkdir(join(home, 'fleet'), { recursive: true });
  await mkdir(join(person, '.claude'), { recursive: true });
  await mkdir(join(person, '.codex'), { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes', worktrees: join(parent, 'worktrees') },
    ['fleet', 'harness-home'],
    () => undefined,
    { harnessFiles: ['.claude.json'], setMode: true },
  );
  const fleetRoot = roots.root('fleet');
  const base = fleetRoot.resolve('.');
  if (!base.ok) throw new Error('the fleet root did not open');
  const fleet = base.value.endsWith('/.') ? base.value.slice(0, -2) : base.value;
  const disk = new FleetDisk({
    fleet: fleetRoot,
    directory: fleet,
    sources: sourceMounts(roots, fleetRoot, fleet, [join(person, '.claude'), join(person, '.codex')]),
  });
  let clock = 0;
  const claimFor = (manifestPath: string, waitMs = 50): ApplyLock =>
    applyClaimFor(disk, manifestPath, {
      now: () => clock,
      sleep: async ms => {
        clock += ms;
      },
      waitMs,
      pollMs: 10,
    });
  const world: FleetWorld = {
    parent,
    home,
    fleet,
    person,
    roots,
    disk,
    claimFor,
    provisioner: options =>
      new FileFleetProvisioner(options?.disk ?? disk, claimFor, options?.sharedHistory, options?.publishing),
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
  made.push(world);
  return world;
}
