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
    const auto = { searchPaths: [], permissionMode: 'auto' as const, questionTool: false };
    const skip = { searchPaths: [], permissionMode: 'skip' as const, questionTool: false };
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

  test('any change of the binary or the search paths is held (code execution); the file is judged by that rule', () => {
    // What the file is judged by (the plugin's own def), not a helper the contract exports.
    const held = CODEX_CONFIG.loosens;
    const base = { searchPaths: ['/a', '/b'], permissionMode: 'auto' as const };
    const binary = (path: string) => ({ ...base, binary: path });
    expect(held(base, base)).toEqual([]);
    expect(held(undefined, { searchPaths: [], permissionMode: 'auto' })).toEqual([]);
    expect(held(base, binary('/x'))).toEqual(['agents now launch a different Codex program (binary changed)']);
    expect(held(binary('/x'), binary('/y'))).toHaveLength(1);
    expect(held(binary('/x'), base)).toHaveLength(1);
    // A first document that names a binary AND search paths changes both: each is said.
    expect(held(undefined, binary('/x'))).toHaveLength(2);
    expect(held(undefined, { ...binary('/x'), searchPaths: [] })).toHaveLength(1);
    const searched = (paths: string[]) => ({ ...base, searchPaths: paths });
    const dirs = ['agents now look for the Codex program in different directories (searchPaths changed)'];
    expect(held(base, searched(['/a']))).toEqual(dirs);
    expect(held(base, searched(['/b', '/a']))).toEqual(dirs);
    expect(held(base, searched(['/a /b']))).toEqual(dirs);
    expect(held(undefined, searched(['/a']))).toEqual(dirs);
    expect(held(base, { ...base, permissionMode: 'skip', binary: '/x' })).toHaveLength(2);
    expect(held({ ...base, permissionMode: 'skip' }, base)).toEqual([]);
  });
});
