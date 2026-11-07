import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('conversation manifest', () => {
  const routes = manifest.actions.routes;
  test('declares every route of the conversation mounts, each with a full descriptor', () => {
    expect(routes).toHaveLength(40);
    expect(manifest.actions.sockets).toHaveLength(1);
    for (const route of routes) {
      expect(['operator', 'authenticated']).toContain(route.minimum);
      expect(route.audit).toBeDefined();
      expect(route.guard).toBeDefined();
    }
    expect(new Set(routes.map(route => route.key)).size).toBe(routes.length);
  });
  test('no route keeps the old session or import spelling', () => {
    for (const route of [...routes, ...manifest.actions.sockets])
      expect(route.path).not.toMatch(/\/v1\/sessions\/|\/v1\/imports\//);
  });
  test('answering a question and every shared-draft route are the owner’s, never a ferret’s', () => {
    const mine = [...routes, ...manifest.actions.sockets].filter(
      route => /\/answer$|shared-draft/.test(route.path) || route.path.endsWith('/composer'),
    );
    expect(mine.length).toBe(5);
    for (const route of mine) expect(route.caller).toBe('person');
  });
  test('a body that can show a transcript, pane or draft is built under the secrets guard', () => {
    const secrets = (path: string) =>
      [...routes, ...manifest.actions.sockets].filter(route => route.path === path).map(route => route.guard);
    for (const path of [
      '/v1/ferrets/:ferretId/messages',
      '/v1/ferrets/:ferretId/logs',
      '/v1/ferrets/:ferretId/shared-draft',
    ])
      expect(secrets(path).every(guard => guard === 'secrets')).toBe(true);
    expect(secrets('/v1/ferrets/:ferretId/shared-draft/stream')).toEqual(['secrets']);
  });
  test('takes the question source and sitrep lines, offers message.before-send and turn.ended', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['ask.sources', 'sitrep.lines']);
    expect(manifest.hooks.takes[0]?.key).toBe('question');
    expect(manifest.hooks.offers.map(offer => offer.hook.name)).toEqual(['message.before-send', 'turn.ended']);
  });
  test('state files are format 1 and the two caches are marked as caches', () => {
    for (const file of manifest.data.state) expect(file.format).toBe(1);
    expect(manifest.data.state.find(file => file.name === 'search')?.store).toBe('sqlite-cache');
    expect(manifest.data.state.find(file => file.name === 'message-token-key')?.mode).toBe(0o600);
  });
  test('the verbs and the one agent tool are declared', () => {
    expect(manifest.actions.cli.map(verb => verb.verb)).toContain('link keep');
    expect(manifest.actions.agentTools.map(item => item.name)).toEqual(['search_work']);
  });
});
