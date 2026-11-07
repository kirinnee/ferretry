/**
 * The generated command registry, as the shell consumes it (§7.5).
 *
 * `src/generated/commands.ts` is written by `scripts/gen/registries.ts` and exports `registry`. The generator is
 * the only place that imports a plugin's `manifest.ts` or `cli/index.ts` by path (`context-imports`); the shell
 * sees only this shape, so a plugin added to the workspace adds a line to the generated file and edits nothing here.
 */
import type { CliImplementation, Manifest } from '@ferretry/kernel/manifest';

/**
 * A half built for one manifest. `CliImplementation<M>` is not assignable to `CliImplementation<Manifest>` (its `build`
 * takes a `CliContext<M>`), so the registry holds them as `any` and the shell reads only `skeleton` and `build`.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance of the leaf's CliImplementation<M>
export type AnyCliImplementation = CliImplementation<any>;

export interface RegistryEntry {
  /** The plugin id (`board`), also the first word of its noun. */
  readonly id: string;
  /** The manifest, imported statically: verbs, routes and words are known without loading any half. */
  readonly manifest: Manifest;
  /** The effective contract hash compiled into this `fy` (§9.6). Compared with the daemon's before every call. */
  readonly contract: string;
  /** Loads the `cli/` half. Lazy, so a verb loads only the plugin it runs. */
  load(): Promise<AnyCliImplementation>;
}

export interface CommandRegistry {
  readonly plugins: readonly RegistryEntry[];
}
