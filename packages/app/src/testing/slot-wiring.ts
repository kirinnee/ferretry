/// <reference types="vite/client" />
/**
 * What a plugin's own slot suite reads of the real compiled manifests (§5.2): which panels sit in a slot, which slots a
 * plugin contributes to, and what each plugin depends on. A slot is an agreement by name, and each plugin proves its own
 * half here against the registry the shell is built from, so renaming either side fails in the plugin that wrote it
 * instead of drawing an empty field. Read-only: nothing here places or draws a panel (`WithSlotPanels` does that).
 *
 * The registry names every plugin's app half, whose stylesheet and `?url` imports only the bundler resolves; the
 * reference above gives a plugin's own tsconfig project (which declares none of them) the bundler's asset types.
 */
import { generated } from '../generated/surfaces.ts';
import { viewsOf } from '../layout/engine.ts';

const entries = generated.surfaces;

const entryOf = (id: string) => entries.find(entry => entry.id === id);

/** The panels a slot shows in the real layout order, each as `<plugin>.<panel id>`. */
export const panelsInSlot = (slot: string): readonly string[] =>
  (viewsOf(entries).panels.get(slot) ?? []).map(panel => `${panel.plugin}.${panel.id}`);

/** Every slot any plugin places a panel in whose name starts with `prefix` (once per panel, in registry order). */
export const contributedSlots = (prefix: string): readonly string[] =>
  entries.flatMap(entry =>
    (entry.manifest.ui?.panels ?? []).map(panel => panel.slot as string).filter(slot => slot.startsWith(prefix)),
  );

/** The slots one plugin's own panels sit in, in manifest order. */
export const slotsPlacedBy = (id: string): readonly string[] =>
  (entryOf(id)?.manifest.ui?.panels ?? []).map(panel => panel.slot as string);

/** The ids a plugin's manifest `needs` and `uses`. */
export const dependenciesOf = (id: string): { readonly needs: readonly string[]; readonly uses: readonly string[] } => {
  const manifest = entryOf(id)?.manifest;
  return { needs: Object.keys(manifest?.needs ?? {}), uses: Object.keys(manifest?.uses ?? {}) };
};

/** The ids a plugin's registry entry folds into its hash (§9.6 `consumes`). */
export const consumesOf = (id: string): readonly string[] => entryOf(id)?.consumes ?? [];

/**
 * Everything a plugin reaches through the DEPENDENCY graph: each manifest's `needs` and `uses`. Not `consumes`, which
 * is the §9.6 hash-folding set and runs the other way for an offered hook such as Vault's `input.targets` (the offerer
 * re-hashes when a taker changes), so it may hold cycles the generator folds as one component.
 */
export const reachFrom = (from: string): ReadonlySet<string> => {
  const seen = new Set<string>();
  const walk = (id: string): void => {
    const { needs, uses } = dependenciesOf(id);
    for (const next of [...needs, ...uses]) {
      if (seen.has(next)) continue;
      seen.add(next);
      walk(next);
    }
  };
  walk(from);
  return seen;
};

/** Every non-core plugin id in the registry (the ones that may not reach themselves). */
export const pluginIds = (): readonly string[] => entries.filter(entry => !entry.core).map(entry => entry.id);
