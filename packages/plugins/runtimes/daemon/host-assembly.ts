/**
 * What Runtimes' daemon half builds from the kernel's ports today (docs/design/redesign.md §7.7), each piece one the
 * kernel now offers and the plugin declares in its manifest:
 *
 *  - the published fleet, read through the `fleet` root ({@link publishedFleet}): `manifest.json` beside the wrappers;
 *  - an ended Codex ferret's follow-up ({@link endedSeams}): the app-server supervisor over the fleet root and
 *    `kernel.processes`, and a runtime's published wrapper;
 *  - the machine's "Auto-resume after restart" switch, from Runtimes' own `runtimes.yaml`.
 *
 * What is NOT here: the catalogue's apply (the file provisioner) and the fleet's setup, which wait for a kernel
 * rename member (see `ports-pending.json`, `[compose]` Runtimes lines), so the catalogue and setup stay the
 * assembly that refuses in a sentence.
 */
import type { KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { readFleetManifest } from './adapters/manifest-file.ts';
import { fleetMounts, rootHostFiles } from './adapters/root-host-files.ts';
import type { FleetManifest } from './lib/manifest.ts';
import { CodexAppServerSupervisor } from './lib/service/codex-runtime.ts';
import type { RuntimeEndSeams } from './lib/service/runtime-end-supervision.ts';

/** The published manifest's name in the fleet folder. */
const MANIFEST_FILE = 'manifest.json';

/**
 * The fleet folder's absolute path, as the `fleet` root names it (the manifest's absolute paths are spelled with it).
 * The kernel keeps no link from the home down to the root, so the root's own spelling is its real one.
 */
function fleetDirectory(fleet: RootHandle): string {
  const base = fleet.resolve('.');
  if (!base.ok) throw new Error(`the fleet folder could not be opened (${base.error})`);
  return base.value.endsWith('/.') ? base.value.slice(0, -2) : base.value;
}

/** The published fleet: its folder and the manifest an apply wrote, or `undefined` for a machine no apply has reached. */
async function publishedFleet(
  fleet: RootHandle,
): Promise<{ readonly directory: string; readonly manifest: FleetManifest | undefined }> {
  const directory = fleetDirectory(fleet);
  const files = rootHostFiles(fleetMounts(fleet, directory));
  return { directory, manifest: await readFleetManifest(files, `${directory}/${MANIFEST_FILE}`) };
}

/** What an ended Codex ferret's follow-up stands on, from the kernel's roots, processes and clock. */
export function endedSeams(kernel: Pick<KernelPorts, 'roots' | 'processes' | 'clock'>): RuntimeEndSeams {
  const fleet = kernel.roots.root('fleet');
  const supervisor = new CodexAppServerSupervisor({
    inventory: { accounts: async () => (await publishedFleet(fleet)).manifest?.accounts ?? [] },
    host: { fleet, processes: kernel.processes },
    homesDirectory: () => `${fleetDirectory(fleet)}/homes`,
    sleep: async ms =>
      await new Promise<void>(resolve => {
        kernel.clock.after(milliseconds(ms), resolve);
      }),
  });
  return {
    supervisor,
    wrapperOf: async runtime =>
      (await publishedFleet(fleet)).manifest?.runtimes.find(published => published.name === runtime)?.wrapper,
  };
}
