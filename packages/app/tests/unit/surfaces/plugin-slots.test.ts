import { describe, expect, test } from 'bun:test';
import { FERRET_SLOTS } from '../../../../core/ferrets/contract/slots.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { viewsOf } from '../../../src/layout/engine.ts';
import { isSlotName } from '../../../src/layout/slots.ts';

/**
 * Slots a plugin screen offers (§5.2) are an agreement by name: Ferrets' contract names its two account slots and the
 * props they carry, Runtimes contributes the panels, and neither half imports the other. Proved against the real
 * compiled manifests, so renaming either side fails here instead of drawing an empty field.
 */

const entries = generated.surfaces;
const entryOf = (id: string) => entries.find(entry => entry.id === id);

describe('the slots Ferrets offers', () => {
  test('each is a plugin slot name owned by Ferrets, and Runtimes contributes a panel to each', () => {
    const views = viewsOf(entries);
    for (const slot of FERRET_SLOTS) {
      expect(isSlotName(slot)).toBe(true);
      expect(slot.startsWith('ferrets.')).toBe(true);
      const panels = views.panels.get(slot) ?? [];
      expect(panels.map(panel => `${panel.plugin}.${panel.id}`)).toEqual([
        `runtimes.${slot === 'ferrets.new-ferret-account' ? 'new-ferret-account' : 'move-account'}`,
      ]);
    }
  });

  test('every panel contributed to a Ferrets slot is one of the slots its contract names', () => {
    const named: readonly string[] = FERRET_SLOTS;
    const contributed = entries.flatMap(entry =>
      (entry.manifest.ui?.panels ?? []).map(panel => panel.slot as string).filter(slot => slot.startsWith('ferrets.')),
    );
    expect(contributed.length).toBe(FERRET_SLOTS.length);
    for (const slot of contributed) expect(named).toContain(slot);
  });

  test('Ferrets imports nothing of Runtimes: the offer is its contract, the contribution is Runtimes’ manifest', () => {
    expect(entryOf('ferrets')?.consumes).not.toContain('runtimes');
    const own = (entryOf('ferrets')?.manifest.ui?.panels ?? []).map(panel => panel.slot as string);
    expect(own.filter(slot => slot.startsWith('ferrets.'))).toEqual([]);
  });
});

describe('the plugin graph with Runtimes using Usage', () => {
  // The DEPENDENCY graph: each manifest's `needs` and `uses`. Not `consumes`, which is the §9.6 hash-folding set and
  // runs the other way for an offered hook such as Vault's `input.targets` (the offerer re-hashes when a taker
  // changes), so it may hold cycles the generator folds as one component.
  const dependsOn = (id: string): readonly string[] => {
    const manifest = entryOf(id)?.manifest;
    return [...Object.keys(manifest?.needs ?? {}), ...Object.keys(manifest?.uses ?? {})];
  };
  const reach = (from: string): ReadonlySet<string> => {
    const seen = new Set<string>();
    const walk = (id: string): void => {
      for (const next of dependsOn(id)) {
        if (seen.has(next)) continue;
        seen.add(next);
        walk(next);
      }
    };
    walk(from);
    return seen;
  };

  test('Runtimes uses Usage, optionally: declared in `uses`, not `needs`', () => {
    const manifest = entryOf('runtimes')?.manifest;
    expect(Object.keys(manifest?.uses ?? {})).toEqual(['usage']);
    expect(Object.keys(manifest?.needs ?? {})).not.toContain('usage');
    expect(reach('runtimes')).toContain('usage');
  });

  test('Usage does not reach Runtimes, directly or through anything it consumes', () => {
    expect(reach('usage')).not.toContain('runtimes');
  });

  test('no plugin reaches itself (core pieces consume each other through hooks and are ordered by the kernel)', () => {
    for (const entry of entries.filter(candidate => !candidate.core)) expect(reach(entry.id)).not.toContain(entry.id);
  });
});
