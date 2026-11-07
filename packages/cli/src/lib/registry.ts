/**
 * The generated command registry, as the shell consumes it (§7.5).
 *
 * `src/generated/commands.ts` is written by `scripts/gen/registries.ts` and exports `registry`. The generator is
 * the only place that imports a plugin's `manifest.ts` or `cli/index.ts` by path (`context-imports`); the shell
 * sees only this shape, so a plugin added to the workspace adds a line to the generated file and edits nothing here.
 */
import type { CliImplementation, Manifest } from '@ferretry/kernel/manifest';

export interface RegistryEntry {
  /** The plugin id (`board`), also the first word of its noun. */
  readonly id: string;
  /** The manifest, imported statically: verbs, routes and words are known without loading any half. */
  readonly manifest: Manifest;
  /** The effective contract hash compiled into this `fy` (§9.6). Compared with the daemon's before every call. */
  readonly contract: string;
  /** Loads the `cli/` half. Lazy, so a verb loads only the plugin it runs. */
  load(): Promise<CliImplementation>;
}

export interface CommandRegistry {
  readonly plugins: readonly RegistryEntry[];
}
