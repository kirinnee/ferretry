/**
 * The runtime half of an MCP catalog install and removal, judged on its own: Runtimes and the config writer are
 * stood in, so every refusal sentence and every take-back is proved without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { CatalogItemRefusal, type CatalogInstallChange } from '@ferretry/plugin-catalogs/contract';
import type { ProfileLayerOutcome } from '@ferretry/plugin-runtimes/contract';
import type { McpItem } from '../../contract/index.ts';
import { mcpCatalogRuntime, type McpCatalogRuntimeDeps } from '../../daemon/lib/catalog-runtime.ts';

const written: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] };
const layerWritten: ProfileLayerOutcome = { kind: 'written', profiles: ['default'] };

const CHANGE = {
  kind: 'catalog.install',
  name: 'acme',
  component: { kind: 'mcp', command: 'npx', args: ['acme-mcp'] },
  files: [],
  profile: 'default',
  installedFrom: {} as never,
  replace: false,
} as unknown as CatalogInstallChange;

interface Options {
  readonly writeItem?: ConfigWriteOutcome;
  readonly removeItem?: ConfigWriteOutcome | 'throws';
  readonly layer?: ProfileLayerOutcome;
  readonly profileLayers?: readonly string[];
  readonly noRuntimes?: boolean;
  readonly runtimeList?: readonly { id: string; harness: string; profile: string }[];
}

function world(options: Options = {}) {
  const items = new Map<string, McpItem>();
  const calls: string[] = [];
  const runtimes = {
    list: async () => options.runtimeList ?? [],
    profiles: async () => [{ name: 'default', layers: options.profileLayers ?? [], etag: 'p1' }],
    changeProfileLayers: async (change: { kind: string; layer: string }) => {
      calls.push(`layer ${change.kind} ${change.layer}`);
      return options.layer ?? layerWritten;
    },
  };
  const deps: McpCatalogRuntimeDeps = {
    runtimes: () => (options.noRuntimes ? undefined : (runtimes as never)),
    items: () => items,
    writeItem: async name => {
      calls.push(`write ${name}`);
      const outcome = options.writeItem ?? written;
      if (outcome.kind === 'written') items.set(name, {} as McpItem);
      return outcome;
    },
    removeItem: async name => {
      calls.push(`remove ${name}`);
      if (options.removeItem === 'throws') throw new Error('disk gone');
      items.delete(name);
      return options.removeItem ?? written;
    },
  };
  return { runtime: mcpCatalogRuntime(deps), items, calls };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a CatalogItemRefusal');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CatalogItemRefusal);
      return error as CatalogItemRefusal;
    },
  );

describe('what the installer lists of Runtimes', () => {
  test('names each runtime by its id and carries its harness as the plugin key, a third included', async () => {
    const w = world({
      runtimeList: [
        { id: 'a', harness: 'codex', profile: 'p1' },
        { id: 'b', harness: 'anything-else', profile: 'p2' },
      ],
    });
    expect(await w.runtime.runtimes()).toEqual({
      runtimes: [
        { id: 'a', name: 'a', profile: 'p1', harness: 'codex' },
        { id: 'b', name: 'b', profile: 'p2', harness: 'anything-else' },
      ],
    });
    expect(await w.runtime.profiles()).toEqual({ profiles: [{ name: 'default' }] });
  });

  test('lists nothing, rather than failing, while Runtimes is off', async () => {
    const w = world({ noRuntimes: true });
    expect(await w.runtime.runtimes()).toEqual({ runtimes: [] });
    expect(await w.runtime.profiles()).toEqual({ profiles: [] });
  });

  test('reads a stored component from the live items', async () => {
    const w = world();
    const item = { command: 'npx' } as McpItem;
    w.items.set('acme', item);
    expect(await w.runtime.storedComponent('acme')).toBe(item);
    expect(await w.runtime.storedComponent('other')).toBeUndefined();
  });
});

describe('installing', () => {
  test('refuses in words, writing nothing, while Runtimes is off', async () => {
    const w = world({ noRuntimes: true });
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.code).toBe('catalog_target_unknown');
    expect(error.message).toContain('Runtimes is not available');
    expect(w.calls).toEqual([]);
  });

  test('refuses a component that is not an MCP server', async () => {
    const w = world();
    const error = await refusal(
      w.runtime.installCatalogItem(
        { ...CHANGE, component: { kind: 'skill' } } as unknown as CatalogInstallChange,
        undefined,
      ),
    );
    expect(error.code).toBe('catalog_not_installable');
    expect(error.message).toBe('acme is not an MCP server, so MCP cannot install it.');
    expect(w.calls).toEqual([]);
  });

  test('refuses a profile this machine does not have', async () => {
    const w = world();
    const error = await refusal(w.runtime.installCatalogItem({ ...CHANGE, profile: 'ghost' }, undefined));
    expect(error.code).toBe('catalog_target_unknown');
    expect(error.message).toBe('ghost is not a profile on this machine.');
    expect(w.calls).toEqual([]);
  });

  test('refuses to replace a server no install of ours put there', async () => {
    const w = world();
    w.items.set('acme', {} as McpItem);
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.code).toBe('catalog_install_conflict');
    expect(error.message).toContain('already a server on this machine');
    expect(w.calls).toEqual([]);
  });

  test('writes the item and adds the layer, returning the stored component', async () => {
    const w = world();
    const result = await w.runtime.installCatalogItem(CHANGE, undefined);
    expect(w.calls).toEqual(['write acme', 'layer add mcp/acme']);
    expect(result).toEqual({ component: {} as McpItem });
  });

  test('adds no layer to a profile that already names it', async () => {
    const w = world({ profileLayers: ['mcp/acme'] });
    await w.runtime.installCatalogItem(CHANGE, undefined);
    expect(w.calls).toEqual(['write acme']);
  });

  test('says the owner has to confirm a held item, and takes the new item back', async () => {
    const w = world({
      writeItem: { kind: 'held', etag: 'e', id: 'h1', sentences: ['It runs a command.', 'Confirm it.'] },
    });
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.code).toBe('catalog_install_conflict');
    expect(error.message).toBe(
      'The server is not in effect: the owner has to confirm it first. It runs a command. Confirm it.',
    );
    expect(w.calls).toEqual(['write acme', 'remove acme']);
  });

  test('says an item that changed mid-install changed', async () => {
    const w = world({ writeItem: { kind: 'conflict' } });
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.message).toBe('This server changed while it was being installed.');
  });

  test('says why a refused write was refused, issue by issue', async () => {
    const w = world({
      writeItem: {
        kind: 'refused',
        reason: 'schema',
        issues: [
          { path: 'command', message: 'must be text' },
          { path: 'args', message: 'must be a list' },
        ],
      },
    });
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.message).toBe('The server was not written. command: must be text args: must be a list');
  });

  test('takes the layer refusals back to the person in words', async () => {
    const held = await refusal(
      world({ layer: { kind: 'held', sentence: 'the owner has to confirm' } }).runtime.installCatalogItem(
        CHANGE,
        undefined,
      ),
    );
    expect(held.message).toBe('The profile change is held for the owner to confirm: the owner has to confirm');

    const conflict = world({ layer: { kind: 'conflict', profile: 'default' } });
    const changed = await refusal(conflict.runtime.installCatalogItem(CHANGE, undefined));
    expect(changed.message).toBe('The profile default changed since you looked.');
    expect(conflict.calls).toEqual(['write acme', 'layer add mcp/acme', 'remove acme']);

    const unknown = await refusal(
      world({
        layer: { kind: 'refused', code: 'fleet_change_unknown', sentence: 'no such change' },
      }).runtime.installCatalogItem(CHANGE, undefined),
    );
    expect([unknown.code, unknown.message]).toEqual(['fleet_change_unknown', 'no such change']);

    const refused = await refusal(
      world({
        layer: { kind: 'refused', code: 'fleet_change_refused', sentence: 'not yours to change' },
      }).runtime.installCatalogItem(CHANGE, undefined),
    );
    expect([refused.code, refused.message]).toEqual(['catalog_install_conflict', 'not yours to change']);
  });

  test('still tells the real refusal when taking the new item back fails', async () => {
    const w = world({ layer: { kind: 'held', sentence: 'wait' }, removeItem: 'throws' });
    const error = await refusal(w.runtime.installCatalogItem(CHANGE, undefined));
    expect(error.message).toContain('wait');
    expect(w.calls).toEqual(['write acme', 'layer add mcp/acme', 'remove acme']);
  });

  test('keeps a replaced item when the layer change is refused', async () => {
    const w = world({ layer: { kind: 'held', sentence: 'wait' } });
    w.items.set('acme', {} as McpItem);
    await refusal(w.runtime.installCatalogItem({ ...CHANGE, replace: true }, undefined));
    expect(w.calls).toEqual(['write acme', 'layer add mcp/acme']);
    expect(w.items.has('acme')).toBe(true);
  });
});

describe('removing', () => {
  async function proposed(w: ReturnType<typeof world>) {
    return w.runtime.propose({ kind: 'component.remove', name: 'acme', removeFromProfiles: true } as never);
  }
  const fresh = { claim: () => false, agent: false } as never;

  test('takes the layer out of every profile, then the item', async () => {
    const w = world();
    const proposal = await proposed(w);
    expect(proposal.id).toBe('remove:acme');
    expect(await w.runtime.apply(proposal.id, undefined, fresh)).toEqual({ removed: 'acme' });
    expect(w.calls).toEqual(['layer remove-everywhere mcp/acme', 'remove acme']);
  });

  test('forgets a proposal once applied, so a second apply is refused', async () => {
    const w = world();
    const proposal = await proposed(w);
    await w.runtime.apply(proposal.id, undefined, fresh);
    const error = await refusal(w.runtime.apply(proposal.id, undefined, fresh));
    expect(error.code).toBe('fleet_change_unknown');
    expect(error.message).toBe('The server removal proposal is no longer held.');
  });

  test('stops at a refused layer change and keeps the item', async () => {
    const w = world({ layer: { kind: 'held', sentence: 'wait' } });
    const proposal = await proposed(w);
    const error = await refusal(w.runtime.apply(proposal.id, undefined, fresh));
    expect(error.message).toContain('wait');
    expect(w.calls).toEqual(['layer remove-everywhere mcp/acme']);
  });

  test('says so when the item itself cannot be removed', async () => {
    const w = world({ removeItem: { kind: 'conflict' } });
    const proposal = await proposed(w);
    const error = await refusal(w.runtime.apply(proposal.id, undefined, fresh));
    expect(error.message).toBe('This server changed while it was being installed.');
  });

  test('refuses in words while Runtimes is off', async () => {
    const w = world({ noRuntimes: true });
    const proposal = await proposed(w);
    const error = await refusal(w.runtime.apply(proposal.id, undefined, fresh));
    expect(error.code).toBe('catalog_target_unknown');
    expect(w.calls).toEqual([]);
  });
});
