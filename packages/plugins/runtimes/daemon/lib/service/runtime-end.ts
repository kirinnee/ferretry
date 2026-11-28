/**
 * What an ended ferret's runtime leaves behind, asked of each harness's own plugin.
 *
 * Ferrets never calls a plugin (§2.1): Runtimes hears that a ferret stopped (`ferrets.changed`) and hands the change to every
 * harness kit that answers one (`onFerretChanged`). Each plugin looks after its own harness and ignores the rest, so Runtimes
 * names no harness here; a harness whose plugin is off has no kit, and nothing is done for it.
 */
import type { KitEndHost, KitEndInput, KitFerretChange, RuntimesHarnessKit } from '../../../contract/harness-kit.ts';

export interface RuntimeEndDeps extends Omit<KitEndInput, 'host'> {
  /** `undefined` while the host offers none: the plugins' follow-ups then do nothing. */
  readonly host: KitEndHost | undefined;
  /** The kits the harness plugins give now. */
  readonly kits: () => ReadonlyMap<string, RuntimesHarnessKit>;
}

export class RuntimeEnd {
  constructor(private readonly deps: RuntimeEndDeps) {}

  async onChanged(change: KitFerretChange): Promise<void> {
    const { kits, ...input } = this.deps;
    for (const kit of kits().values()) await kit.onFerretChanged?.(input, change);
  }
}
