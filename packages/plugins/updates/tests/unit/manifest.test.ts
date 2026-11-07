import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('updates manifest', () => {
  test("declares today's daemon update routes (harness updates are the harness plugins')", () => {
    expect(manifest.actions.routes.map(route => route.key).sort()).toEqual([
      'GET /v1/daemon/update',
      'PATCH /v1/daemon/update/settings',
      'POST /v1/daemon/update',
    ]);
  });
  test('every act that runs new code is a person act on fleet.configure, kept in the audit log', () => {
    for (const route of manifest.actions.routes.filter(route => route.method !== 'GET')) {
      expect(route.caller).toBe('person');
      expect(route.capability?.axis).toBe('configure');
      expect(route.audit).toHaveProperty('record');
    }
  });
  test('listens for ferret changes to install when idle, and owns `fy update`', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['ferret.changed']);
    expect(manifest.actions.cli.map(verb => verb.verb)).toEqual(['update']);
  });
});
