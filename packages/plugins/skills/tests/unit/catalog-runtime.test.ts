/**
 * The runtime half of a catalog skill install and removal: the skill's files into Skills' store, its item file, and
 * its one `skills/<name>` profile layer, with what THIS call wrote taken back when a later step is refused. Fakes of
 * the three things it talks to (Runtimes, the item writer, the store) record every write, so the order and the
 * rollback are what is asserted.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { CatalogItemRefusal, type CatalogInstallChange } from '@ferretry/plugin-catalogs/contract';
import type { ProfileLayerChange, ProfileLayerOutcome } from '@ferretry/plugin-runtimes/contract';
import type { SkillsItem } from '../../contract/index.ts';
import { skillsCatalogRuntime } from '../../daemon/lib/catalog-runtime.ts';
import { InstalledSkillConflict, InstalledSkillRefused } from '../../daemon/lib/skill-store.ts';

const WRITTEN: ConfigWriteOutcome = { kind: 'written', etag: 'e1', loosened: [] };
const LAYERED: ProfileLayerOutcome = { kind: 'written', profiles: ['work'] };

interface Fixture {
  readonly log: string[];
  readonly layerChanges: ProfileLayerChange[];
  readonly writes: { name: string; patch: Readonly<Record<string, unknown>>; ifMatch: 'absent' | undefined }[];
  readonly items: Map<string, SkillsItem>;
  readonly installer: ReturnType<typeof skillsCatalogRuntime>;
}

function fixture(
  options: {
    runtimes?: 'absent';
    profiles?: { name: string; layers: string[]; etag: string }[];
    layered?: ProfileLayerOutcome;
    written?: ConfigWriteOutcome;
    removed?: ConfigWriteOutcome;
    installError?: Error;
    removeItemFails?: boolean;
    uninstallFails?: boolean;
    existing?: string[];
  } = {},
): Fixture {
  const log: string[] = [];
  const layerChanges: ProfileLayerChange[] = [];
  const writes: Fixture['writes'] = [];
  const items = new Map<string, SkillsItem>((options.existing ?? []).map(name => [name, { items: [name] } as never]));
  const profiles = options.profiles ?? [{ name: 'work', layers: ['base'], etag: 'p1' }];
  const runtimes = {
    list: async () => [
      { id: 'claude-default', profile: 'work', harness: 'claude-code' },
      { id: 'codex-main', profile: 'work', harness: 'codex' },
    ],
    profiles: async () => profiles,
    changeProfileLayers: async (change: ProfileLayerChange) => {
      layerChanges.push(change);
      log.push(`layer:${change.kind}`);
      return options.layered ?? LAYERED;
    },
  };
  const installer = skillsCatalogRuntime({
    runtimes: () => (options.runtimes === 'absent' ? undefined : (runtimes as never)),
    items: () => items,
    writeItem: async (name, patch, ifMatch) => {
      writes.push({ name, patch, ifMatch });
      log.push('item:write');
      const outcome = options.written ?? WRITTEN;
      if (outcome.kind === 'written') items.set(name, patch as never);
      return outcome;
    },
    removeItem: async name => {
      log.push('item:remove');
      if (options.removeItemFails === true) throw new Error('disk gone');
      items.delete(name);
      return options.removed ?? WRITTEN;
    },
    store: {
      install: async () => {
        log.push('store:install');
        if (options.installError !== undefined) throw options.installError;
      },
      uninstall: async () => {
        log.push('store:uninstall');
        if (options.uninstallFails === true) throw new Error('disk gone');
      },
    },
  });
  return { log, layerChanges, writes, items, installer };
}

const CHANGE: CatalogInstallChange = {
  kind: 'catalog.install',
  name: 'review',
  component: { kind: 'skills', items: ['review'] },
  files: [{ path: 'SKILL.md', content: 'x' }] as never,
  profile: 'work',
  installedFrom: { source: 'a-catalog' } as never,
  replace: false,
};

const refusal = async (run: () => Promise<unknown>): Promise<CatalogItemRefusal> => {
  const caught = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(CatalogItemRefusal);
  return caught as CatalogItemRefusal;
};

describe('what Skills offers a catalog to install into', () => {
  test('runtimes carry their profile and a harness of claude or codex; profiles carry their names', async () => {
    const { installer } = fixture();
    expect(await installer.runtimes()).toEqual({
      runtimes: [
        { id: 'claude-default', name: 'claude-default', profile: 'work', harness: 'claude' },
        { id: 'codex-main', name: 'codex-main', profile: 'work', harness: 'codex' },
      ],
    });
    expect(await installer.profiles()).toEqual({ profiles: [{ name: 'work' }] });
  });

  test('without Runtimes there are no runtimes and no profiles to offer, and nothing throws', async () => {
    const { installer } = fixture({ runtimes: 'absent' });
    expect(await installer.runtimes()).toEqual({ runtimes: [] });
    expect(await installer.profiles()).toEqual({ profiles: [] });
  });

  test('a stored component is the item this machine holds under that name', async () => {
    const { installer } = fixture({ existing: ['review'] });
    expect(await installer.storedComponent('review')).toEqual({ items: ['review'] });
    expect(await installer.storedComponent('other')).toBeUndefined();
  });
});

describe('removing a skill', () => {
  const remove = async (f: Fixture) => {
    const { id } = await f.installer.propose({ kind: 'component.remove', name: 'review', removeFromProfiles: true });
    return id;
  };

  test('takes the skills/<name> layer out of every profile first, then the item, and answers the name', async () => {
    const f = fixture({ existing: ['review'] });
    const id = await remove(f);
    expect(id).toBe('remove:review');
    expect(await f.installer.apply(id, undefined, undefined as never)).toEqual({ removed: 'review' });
    expect(f.layerChanges).toEqual([{ kind: 'remove-everywhere', layer: 'skills/review' }]);
    expect(f.log).toEqual(['layer:remove-everywhere', 'item:remove']);
  });

  test('a proposal is used once: a second apply, or one never proposed, is a change that is no longer held', async () => {
    const f = fixture();
    const id = await remove(f);
    await f.installer.apply(id, undefined, undefined as never);
    for (const again of [id, 'remove:never-proposed']) {
      const refused = await refusal(() => f.installer.apply(again, undefined, undefined as never));
      expect(refused.code).toBe('fleet_change_unknown');
      expect(refused.message).toBe('The skill removal proposal is no longer held.');
    }
  });

  test('with no Runtimes the removal refuses in words and removes no item', async () => {
    const f = fixture({ runtimes: 'absent' });
    const refused = await refusal(async () => f.installer.apply(await remove(f), undefined, undefined as never));
    expect(refused.code).toBe('catalog_target_unknown');
    expect(refused.message).toContain('Runtimes is not available');
    expect(f.log).toEqual([]);
  });

  const layerCases: readonly (readonly [string, ProfileLayerOutcome, string, string])[] = [
    [
      'held for the owner',
      { kind: 'held', sentence: 'Confirm it.' },
      'catalog_install_conflict',
      'The profile change is held for the owner to confirm: Confirm it.',
    ],
    [
      'a profile that moved',
      { kind: 'conflict', profile: 'work' },
      'catalog_install_conflict',
      'The profile work changed since you looked.',
    ],
    [
      'an unknown fleet change',
      { kind: 'refused', code: 'fleet_change_unknown', sentence: 'No such change.' },
      'fleet_change_unknown',
      'No such change.',
    ],
    [
      'any other refusal',
      { kind: 'refused', code: 'fleet_change_refused', sentence: 'Not allowed.' },
      'catalog_install_conflict',
      'Not allowed.',
    ],
  ];
  for (const [what, outcome, code, message] of layerCases)
    test(`a layer change ${what} stops the removal before the item is touched`, async () => {
      const f = fixture({ layered: outcome });
      const refused = await refusal(async () => f.installer.apply(await remove(f), undefined, undefined as never));
      expect([refused.code, refused.message]).toEqual([code, message]);
      expect(f.log).toEqual(['layer:remove-everywhere']);
    });

  const itemCases: readonly (readonly [string, ConfigWriteOutcome, string])[] = [
    [
      'held for the owner',
      { kind: 'held', etag: 'e', id: 'h1', sentences: ['Confirm A.', 'Confirm B.'] },
      'The skill is not in effect: the owner has to confirm it first. Confirm A. Confirm B.',
    ],
    ['moved', { kind: 'conflict' }, 'This skill changed while it was being installed.'],
    [
      'refused with the problem named',
      { kind: 'refused', reason: 'schema', issues: [{ path: 'items', message: 'must be a list' }] },
      'The skill was not written. items: must be a list',
    ],
    [
      'refused without a problem to name',
      { kind: 'refused', reason: 'would_hold', issues: [], sentences: [] },
      'The skill was not written.',
    ],
  ];
  for (const [what, outcome, message] of itemCases)
    test(`an item removal ${what} is a refusal in words`, async () => {
      const f = fixture({ removed: outcome });
      const refused = await refusal(async () => f.installer.apply(await remove(f), undefined, undefined as never));
      expect([refused.code, refused.message]).toEqual(['catalog_install_conflict', message]);
    });
});

describe('installing a skill', () => {
  test('writes the files, then the item (which must be new), then adds the layer at the profile etag the person saw', async () => {
    const f = fixture();
    const result = await f.installer.installCatalogItem(CHANGE, undefined);
    expect(f.log).toEqual(['store:install', 'item:write', 'layer:add']);
    expect(f.writes).toEqual([
      { name: 'review', patch: { items: ['review'], installedFrom: CHANGE.installedFrom }, ifMatch: 'absent' },
    ]);
    expect(f.layerChanges).toEqual([{ kind: 'add', profile: 'work', layer: 'skills/review', ifMatch: 'p1' }]);
    expect(result).toEqual({ component: { items: ['review'], installedFrom: CHANGE.installedFrom } });
  });

  test('a profile that already names the layer is not written again', async () => {
    const f = fixture({ profiles: [{ name: 'work', layers: ['base', 'skills/review'], etag: 'p1' }] });
    await f.installer.installCatalogItem(CHANGE, undefined);
    expect(f.log).toEqual(['store:install', 'item:write']);
  });

  test('a replacement of a skill already here writes over it with no absent guard, and keeps it when a later step fails', async () => {
    const f = fixture({ existing: ['review'], layered: { kind: 'held', sentence: 'Confirm it.' } });
    const refused = await refusal(() => f.installer.installCatalogItem({ ...CHANGE, replace: true }, undefined));
    expect(refused.message).toContain('held for the owner');
    expect(f.writes[0]?.ifMatch).toBeUndefined();
    // What was there before this call is not this call's to take back.
    expect(f.log).toEqual(['store:install', 'item:write', 'layer:add']);
  });

  test('a skill that is already here and was not asked to be replaced is refused before anything is written', async () => {
    const f = fixture({ existing: ['review'] });
    const refused = await refusal(() => f.installer.installCatalogItem(CHANGE, undefined));
    expect(refused.code).toBe('catalog_install_conflict');
    expect(refused.message).toBe('review is already a skill on this machine, and no install of ours put it there.');
    expect(f.log).toEqual([]);
  });

  test('something that is not a skill, a profile that is not here, and a machine without Runtimes each refuse with nothing written', async () => {
    const f = fixture();
    const notSkill = await refusal(() =>
      f.installer.installCatalogItem({ ...CHANGE, component: { kind: 'mcp', command: 'x' } }, undefined),
    );
    expect([notSkill.code, notSkill.message]).toEqual([
      'catalog_not_installable',
      'review is not a skill, so Skills cannot install it.',
    ]);
    const noProfile = await refusal(() => f.installer.installCatalogItem({ ...CHANGE, profile: 'ghost' }, undefined));
    expect([noProfile.code, noProfile.message]).toEqual([
      'catalog_target_unknown',
      'ghost is not a profile on this machine.',
    ]);
    const none = fixture({ runtimes: 'absent' });
    expect((await refusal(() => none.installer.installCatalogItem(CHANGE, undefined))).code).toBe(
      'catalog_target_unknown',
    );
    expect([...f.log, ...none.log]).toEqual([]);
  });

  test('the store refusing the files says why, and a failure of the store itself is passed on as it is', async () => {
    const conflict = fixture({ installError: new InstalledSkillConflict('a file was added by hand') });
    const first = await refusal(() => conflict.installer.installCatalogItem(CHANGE, undefined));
    expect([first.code, first.message]).toEqual(['catalog_install_conflict', 'a file was added by hand']);
    const refused = fixture({ installError: new InstalledSkillRefused('no SKILL.md') });
    const second = await refusal(() => refused.installer.installCatalogItem(CHANGE, undefined));
    expect([second.code, second.message]).toEqual(['catalog_not_installable', 'no SKILL.md']);
    const broken = fixture({ installError: new Error('disk full') });
    await expect(broken.installer.installCatalogItem(CHANGE, undefined)).rejects.toThrow('disk full');
    // Nothing was written after the store said no.
    expect([conflict.log, refused.log, broken.log]).toEqual([['store:install'], ['store:install'], ['store:install']]);
  });

  test('an item that is not written takes back the files this call put down, and says why', async () => {
    const f = fixture({ written: { kind: 'conflict' } });
    const refused = await refusal(() => f.installer.installCatalogItem(CHANGE, undefined));
    expect(refused.message).toBe('This skill changed while it was being installed.');
    expect(f.log).toEqual(['store:install', 'item:write', 'item:remove', 'store:uninstall']);
  });

  test('a layer that is refused takes back the item and the files, and a take-back that itself fails hides nothing', async () => {
    const f = fixture({
      layered: { kind: 'conflict', profile: 'work' },
      removeItemFails: true,
      uninstallFails: true,
    });
    const refused = await refusal(() => f.installer.installCatalogItem(CHANGE, undefined));
    expect(refused.message).toBe('The profile work changed since you looked.');
    expect(f.log).toEqual(['store:install', 'item:write', 'layer:add', 'item:remove', 'store:uninstall']);
  });
});
