import { expect, test } from 'bun:test';
import { definePlugin, route } from '../../../manifest/index.ts';
import { planGraph } from '../../../host/graph.ts';

const declaration = (extra = {}) =>
  route('GET /oauth/authorize', {
    minimum: 'none',
    caller: 'any',
    door: 'public',
    audit: { skip: 'fixture' },
    guard: { none: 'fixture' },
    ...extra,
  });
const plugin = (id: string, extra = {}, permissions = {}) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    permissions,
    actions: { routes: [declaration(extra)] },
  });
test('only connector may declare public routes, and only without authentication or capability', () => {
  expect(() => plugin('connector')).not.toThrow();
  expect(() => plugin('other')).toThrow(/GET \/oauth\/authorize/);
  expect(() => plugin('connector', { minimum: 'operator' })).toThrow(/GET \/oauth\/authorize/);
  expect(() => plugin('connector', { capability: { capability: 'fleet', axis: 'use' } })).toThrow(
    /GET \/oauth\/authorize/,
  );
  expect(() => plugin('connector', { caller: 'person' })).toThrow(/GET \/oauth\/authorize/);
  expect(() => plugin('connector', { wardenRemedy: 'anything' })).toThrow(/GET \/oauth\/authorize/);
  expect(() => plugin('connector', { privilegedOnly: true })).toThrow(/GET \/oauth\/authorize/);
});
test('publicDoor permission is refused for every plugin outside the security allow-list', () => {
  expect(() =>
    definePlugin({
      id: 'other',
      title: 'Other',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { publicDoor: true },
    }),
  ).toThrow(/publicDoor/);
});
test('boot refuses an invalid public descriptor even when definePlugin was bypassed', () => {
  const manifest = { ...plugin('connector'), id: 'other' };
  const plan = planGraph(
    [manifest],
    () => true,
    () => [],
  );
  expect(plan.order).toEqual([]);
  expect(plan.refused[0]?.reason).toBe('public-door');
  expect(plan.refused[0]?.sentence).toContain('GET /oauth/authorize');
});
