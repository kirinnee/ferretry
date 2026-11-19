import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { ConfigCollectionDef, ConfigWriteAllDocument, KernelPorts } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { fakeLoginChanges, fakeLoginEnvImport, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { PROFILE_ITEMS, RuntimesPort, type RuntimesApi } from '../../contract/index.ts';
import { type RuntimesAssembly, runtimesDaemon, unavailableAssembly } from '../../daemon/index.ts';

// The `runtimes` port on the kernel's testing host, and the lattice of shared bases: shared by the profile-layers tests
// of the unit tier and the perf tier.

const stoppers: (() => Promise<void>)[] = [];
/** Stops every world a test built; each test file hooks it to `afterEach`. */
export const stopWorlds = async (): Promise<void> => {
  for (const stop of stoppers.splice(0)) await stop();
};

export const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };

const FILES = {
  runtimes: {
    work: { login: 'claude-you', profile: 'a', agent: true },
    other: { login: 'claude-you', profile: 'c' },
  },
  profiles: {
    a: { contents: ['instructions/notes', 'mcp/shared'] },
    b: { contents: ['mcp/shared', 'skills/pdf'] },
    c: { contents: ['skills/pdf'] },
  },
  'model-sets': { fast: { models: ['m1'], default: 'm1' } },
};

export interface World {
  readonly kernel: KernelPorts;
  readonly port: RuntimesApi;
  /** Every document handed to `writeAll`, one array per call. */
  readonly writes: (readonly ConfigWriteAllDocument[])[];
  readonly values: (def: ConfigCollectionDef<unknown>) => string;
  /** The catalogue's one-at-a-time section, the one every apply runs in (the very one `changeProfileLayers` must use). */
  readonly section: <T>(act: () => Promise<T>) => Promise<T>;
}

export interface WorldOptions {
  /** `false`: the profile files cannot be read (no etag seam). */
  readonly etag?: boolean;
  /** Runs right AFTER a profile's etag was read and BEFORE anything is written: a concurrent edit lands here. */
  readonly afterEtag?: (profile: string, kernel: KernelPorts) => Promise<void>;
}

export async function world(files: Record<string, unknown> = FILES, options: WorldOptions = {}): Promise<World> {
  const seen: { kernel?: KernelPorts; section?: World['section'] } = {};
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx => {
        seen.kernel = ctx.kernel;
        const assembly: RuntimesAssembly = unavailableAssembly(ctx);
        seen.section = async act => await assembly.catalog.serialise(act);
        // The testing host's own etag of a stored profile: its value's JSON, as its writes answer it.
        return options.etag === false
          ? assembly
          : {
              ...assembly,
              profileEtag: async name => {
                // A profile with no file is `'absent'`, as the port's contract says (`ProfileLayerDeps.etag`).
                const etag =
                  JSON.stringify(
                    ctx.kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).get(name),
                  ) ?? 'absent';
                await options.afterEtag?.(name, ctx.kernel);
                return etag;
              },
            };
      }),
    ] as never,
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: files,
  });
  stoppers.push(async () => await host.stop());
  const kernel = seen.kernel as KernelPorts;
  const writes: (readonly ConfigWriteAllDocument[])[] = [];
  const real = kernel.config.writeAll.bind(kernel.config);
  (kernel.config as { writeAll: typeof kernel.config.writeAll }).writeAll = async documents => {
    writes.push(documents);
    return await real(documents);
  };
  return {
    kernel,
    port: host.provided(RuntimesPort),
    section: act => (seen.section as World['section'])(act),
    writes,
    values: def => JSON.stringify([...kernel.config.collection(def).entries()]),
  };
}

/** Two profiles per level, each naming BOTH profiles of the next level and one item of its own. */
export const lattice = (depth: number): Record<string, { contents: string[] }> => {
  const profiles: Record<string, { contents: string[] }> = {};
  for (let level = 0; level <= depth; level++)
    for (const side of ['a', 'b'])
      profiles[`${side}${String(level)}`] = {
        contents:
          level === depth
            ? [`mcp/${side}${String(level)}`]
            : [`profile/a${String(level + 1)}`, `profile/b${String(level + 1)}`, `mcp/${side}${String(level)}`],
      };
  return profiles;
};
