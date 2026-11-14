import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BUILT_IN_LAYOUTS } from '../../contract/index.ts';

/**
 * THE DEFAULT LAYOUT PLACES EVERY PANEL THE PLUGINS PROVIDE FOR A FERRET'S SIDE PANE.
 *
 * A layout that lists a slot draws exactly what it lists (`planFrame`), so a panel a plugin declares for `ferret.side`
 * but the default omits is never drawn: the ferret page showed no terminals, console, processes or browser, which v4's
 * ferret page had as its Chat / Console / Processes tabs and its side pane (+ New terminal / New browser / Open file).
 * The workspace's real manifests are the one source of what is declared; this test reads them, so a plugin that gains a
 * `ferret.side` panel fails here until the default layout (the YAML and the contract's copy, held together by
 * `contract.test.ts`) lists it.
 */

const workspace = resolve(import.meta.dir, '../../../../..');

interface Declared {
  readonly plugin: string;
  readonly id: string;
  readonly order: number;
}

const declaredFor = async (slot: string): Promise<readonly Declared[]> => {
  const found: Declared[] = [];
  for (const root of ['packages/core', 'packages/plugins']) {
    for await (const file of new Bun.Glob('*/manifest.ts').scan({ cwd: resolve(workspace, root) })) {
      const manifest = (await import(resolve(workspace, root, file))).default as {
        readonly id: string;
        readonly ui?: {
          readonly panels?: readonly { readonly slot: string; readonly id: string; readonly order: number }[];
        };
      };
      for (const panel of manifest.ui?.panels ?? [])
        if (panel.slot === slot) found.push({ plugin: manifest.id, id: panel.id, order: panel.order });
    }
  }
  return found;
};

describe('the default layout and the ferret side pane', () => {
  test('every panel declared for ferret.side is listed, once, in the default layout', async () => {
    const listed = BUILT_IN_LAYOUTS.find(layout => layout.id === 'default')?.panels['ferret.side'] ?? [];
    const declared = (await declaredFor('ferret.side')).map(panel => panel.id);
    expect(declared.length).toBeGreaterThan(6);
    expect([...listed].sort()).toEqual([...declared].sort());
  });

  test('the terminals, console, processes and browser panels (v4’s Console, Processes and side pane) are among them', async () => {
    const listed = BUILT_IN_LAYOUTS.find(layout => layout.id === 'default')?.panels['ferret.side'] ?? [];
    for (const id of ['terminals', 'console', 'processes', 'browser']) expect(listed).toContain(id);
  });
});
