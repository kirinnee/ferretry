import { describe, expect, test } from 'bun:test';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import {
  CODEX_CONFIG,
  CODEX_HOOKS,
  CODEX_SETTINGS,
  HarnessConfigSchema,
  harnessConfigLoosens,
} from '../../contract/index.ts';
import { codexConformance, fakeCodex } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('codex contract', () => {
  test('its settings and hooks collections name their items by the one shared item-name pattern, never a copy of it', () => {
    for (const def of [CODEX_SETTINGS, CODEX_HOOKS]) {
      expect((def as unknown as { name: RegExp }).name).toBe(ITEM_NAME_PATTERN);
    }
  });

  test('the fake passes the conformance suite', async () => {
    const result = await codexConformance(fakeCodex);
    expect(result.ok).toBe(true);
  });

  test('the manifest declares its two routes, the harness take and the start.decide take', () => {
    expect(manifest.actions.routes.map(route => route.key)).toEqual(['GET /v1/codex/update', 'POST /v1/codex/update']);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual([
      'harnesses',
      'start.decide',
      'runtimes.components.settings.codex',
      'runtimes.components.hooks.codex',
    ]);
    expect(manifest.hooks.takes[0]?.key).toBe('codex');
  });

  test('starting an update is a person act on fleet.configure; the read is fleet.use', () => {
    const [read, start] = manifest.actions.routes;
    expect(String(read?.capability?.capability)).toBe('fleet');
    expect(read?.capability?.axis).toBe('use');
    expect(start?.caller).toBe('person');
    expect(start?.capability?.axis).toBe('configure');
  });

  test('skipping every permission prompt is a loosening; asking again is not', () => {
    const auto = { searchPaths: [], permissionMode: 'auto' as const };
    const skip = { searchPaths: [], permissionMode: 'skip' as const };
    expect(harnessConfigLoosens(auto, skip)).toEqual(['agents now skip every permission prompt']);
    expect(harnessConfigLoosens(skip, auto)).toEqual([]);
    expect(CODEX_CONFIG.axis).toBe('configure');
  });

  test('!A525 a harness file with no permissionMode means skip; an explicit auto stays auto', () => {
    expect(HarnessConfigSchema.parse({}).permissionMode).toBe('skip');
    expect(HarnessConfigSchema.parse({ permissionMode: 'auto' }).permissionMode).toBe('auto');
    expect(HarnessConfigSchema.parse({ permissionMode: 'skip' }).permissionMode).toBe('skip');
  });

  test('!A525 the hold judges explicit values: auto to skip or to nothing is a loosening, nothing to auto a tightening', () => {
    const explicitAuto = HarnessConfigSchema.parse({ permissionMode: 'auto' });
    const nothing = HarnessConfigSchema.parse({});
    const explicitSkip = HarnessConfigSchema.parse({ permissionMode: 'skip' });
    const held = ['agents now skip every permission prompt'];
    expect(harnessConfigLoosens(explicitAuto, explicitSkip)).toEqual(held);
    expect(harnessConfigLoosens(explicitAuto, nothing)).toEqual(held);
    expect(harnessConfigLoosens(nothing, explicitAuto)).toEqual([]);
    expect(harnessConfigLoosens(explicitSkip, nothing)).toEqual([]);
    expect(harnessConfigLoosens(undefined, explicitSkip)).toEqual([]);
    expect(harnessConfigLoosens(undefined, nothing)).toEqual([]);
    expect(harnessConfigLoosens(undefined, explicitAuto)).toEqual([]);
  });
});
