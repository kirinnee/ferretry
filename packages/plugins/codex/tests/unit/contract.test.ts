import { describe, expect, test } from 'bun:test';
import { CODEX_CONFIG, harnessConfigLoosens } from '../../contract/index.ts';
import { codexConformance, fakeCodex } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('codex contract', () => {
  test('the fake passes the conformance suite', async () => {
    const result = await codexConformance(fakeCodex);
    expect(result.ok).toBe(true);
  });

  test('the manifest declares its two routes, the harness take and the start.decide take', () => {
    expect(manifest.actions.routes.map(route => route.key)).toEqual(['GET /v1/codex/update', 'POST /v1/codex/update']);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['harnesses', 'start.decide']);
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
});
