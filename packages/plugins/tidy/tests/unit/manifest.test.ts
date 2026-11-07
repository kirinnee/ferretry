import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('tidy manifest', () => {
  test('declares today’s scratch and tidy-plan routes, at their old paths', () => {
    expect(manifest.actions.routes.map(route => route.key).sort()).toEqual([
      'GET /v1/gc',
      'POST /v1/gc',
      'POST /v1/tidy/plan',
    ]);
  });
  test('the plan is a fleet read and the sweep is ungoverned, as today', () => {
    const byKey = new Map(manifest.actions.routes.map(route => [route.key, route]));
    expect(byKey.get('POST /v1/tidy/plan')?.capability?.axis).toBe('use');
    expect(byKey.get('GET /v1/gc')?.capability).toBeUndefined();
    expect(byKey.get('POST /v1/gc')?.capability).toBeUndefined();
  });
  test('owns `fy gc` and `fy tidy`, hears ferret changes, and touches only the worktrees root', () => {
    expect(manifest.actions.cli.map(verb => verb.verb)).toEqual(['gc', 'tidy']);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['ferret.changed']);
    expect(manifest.permissions.roots).toEqual(['worktrees']);
    expect(manifest.permissions.network).toBeUndefined();
  });
});
