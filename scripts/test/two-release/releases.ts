/**
 * One RELEASE of the fixture (redesign §10.5): a fresh folder, written by {@link writeWorkspace}, run through the real
 * generator exactly as CI runs it for the real tree (`buildModel` → `generateGlobal` → `writeFiles`), then the three
 * registries it wrote are imported:
 *
 *   daemon    `daemonImplementations` + `contractHashes`: what a daemon of this release boots and says
 *   surfaces  `generated`: what an app of this release compiled in (hashes + `consumes`)
 *   commands  `registry`: what an `fy` of this release compiled in
 *
 * "This commit" is `A`. "A daemon built with a change" is the same fixture workspace with one change, generated again.
 * Nothing here knows a hash: they come out of the real `surfaceOf` / `consumedBy` / `effectiveHashes`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractHashes } from '../../gen/lib/hashes.ts';
import { buildModel, generateGlobal, GENERATED, type Model, writeFiles } from '../../gen/registries.ts';
import { APP_VERSION, VARIANTS, type VariantName, writeWorkspace } from './workspace.ts';

/** The four releases every test file builds: this commit, and this commit with each kind of change. */
export type ReleaseSet = readonly [a: Release, bB: Release, bC: Release, bD: Release];

/** What `packages/core/kernel/src/generated/plugins.ts` exports, structurally (the rig imports no package's halves). */
export interface DaemonRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: each half is typed by its own manifest, as in the real generated file.
  readonly daemonImplementations: readonly any[];
  readonly contractHashes: Readonly<Record<string, { readonly canonical: string; readonly effective: string }>>;
}

/** What `packages/app/src/generated/surfaces.ts` exports, structurally. */
export interface SurfaceRegistry {
  readonly generated: {
    readonly appVersion: string;
    // biome-ignore lint/suspicious/noExplicitAny: SurfaceEntry is the app's own type; the test narrows it.
    readonly surfaces: readonly any[];
  };
}

/** What `packages/cli/src/generated/commands.ts` exports, structurally. */
export interface CommandsRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: CommandRegistry is the CLI's own type; the test narrows it.
  readonly registry: any;
}

export interface Release {
  readonly name: VariantName;
  readonly root: string;
  readonly model: Model;
  /** Every package's canonical and effective hash, straight from the generator. */
  readonly hashes: ReadonlyMap<string, ContractHashes>;
  readonly appVersion: string;
  readonly daemon: DaemonRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: see SurfaceRegistry.
  readonly surfaces: readonly any[];
  // biome-ignore lint/suspicious/noExplicitAny: see CommandsRegistry.
  readonly commands: any;
  /** Imports a file of this release's workspace (a fixture contract, say) by its path relative to the root. */
  load(rel: string): Promise<Record<string, unknown>>;
  dispose(): void;
}

/** The effective hash a daemon of this release reports for a package: `fyd.ts`'s `contractHash`, character for character. */
export const contractHashOf =
  (daemon: DaemonRegistry): ((id: string) => string) =>
  id =>
    daemon.contractHashes[id]?.effective ?? 'unhashed';

/** The hashes only: the generator table's input. Never booted. */
export async function buildModelOnly(name: VariantName): Promise<{ readonly model: Model; dispose(): void }> {
  const root = mkdtempSync(join(tmpdir(), `fy-tworel-${name.toLowerCase()}-`));
  writeWorkspace(root, VARIANTS[name]);
  const model = await buildModel(root, false);
  return { model, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Builds A, B_b, B_c and B_d together. When one fails, the ones that built are disposed BEFORE the failure is rethrown,
 * so a half-built set leaves no folder behind (a plain `Promise.all` would drop the others unreferenced).
 */
export async function buildReleases(): Promise<ReleaseSet> {
  const settled = await Promise.allSettled([
    buildRelease('A'),
    buildRelease('B_b'),
    buildRelease('B_c'),
    buildRelease('B_d'),
  ]);
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed !== undefined) {
    for (const outcome of settled) if (outcome.status === 'fulfilled') outcome.value.dispose();
    throw failed.reason;
  }
  const [a, bB, bC, bD] = settled.map(outcome => (outcome as PromiseFulfilledResult<Release>).value);
  return [a as Release, bB as Release, bC as Release, bD as Release];
}

/** Writes, generates and imports one release. Throws when the generator reports a failure: a fixture that does not load is a bug in the rig. */
export async function buildRelease(name: VariantName): Promise<Release> {
  const root = mkdtempSync(join(tmpdir(), `fy-tworel-${name.toLowerCase()}-`));
  try {
    writeWorkspace(root, VARIANTS[name]);
    const model = await buildModel(root, false);
    if (model.failures.length > 0) throw new Error(`release ${name} did not generate: ${model.failures.join('; ')}`);
    writeFiles(root, generateGlobal(model));
    const daemon = (await import(join(root, GENERATED.plugins))) as DaemonRegistry;
    const surfaces = (await import(join(root, GENERATED.surfaces))) as SurfaceRegistry;
    const commands = (await import(join(root, GENERATED.commands))) as CommandsRegistry;
    return {
      name,
      root,
      model,
      hashes: model.hashes,
      appVersion: surfaces.generated.appVersion ?? APP_VERSION,
      daemon,
      surfaces: surfaces.generated.surfaces,
      commands: commands.registry,
      load: async rel => (await import(join(root, rel))) as Record<string, unknown>,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
