import { describe, expect, test } from 'bun:test';
import { showsSomething } from '@ferretry/kernel/contract';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const tools = manifest.actions.agentTools;

describe('browsers manifest', () => {
  test("declares today's browser, login-window, proxy and surface routes, the open-url route (G27) and the page stream", () => {
    expect(routes).toHaveLength(10);
    expect(manifest.actions.sockets.map(socket => socket.key)).toEqual(['GET /v1/ferrets/:ferretId/browser/stream']);
  });
  test('the page stream and the per-ferret browser are built inside one Redaction.read', () => {
    expect(manifest.actions.sockets[0]?.guard).toBe('secrets');
    expect(routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/browser')?.guard).toBe('secrets');
  });
  test("declares today's 29 browser tools; an act that shows something is guarded, a write answers an Ack", () => {
    expect(tools).toHaveLength(29);
    for (const entry of tools) {
      if (entry.op === undefined) continue;
      expect(entry.guard === 'secrets').toBe(showsSomething(entry.op));
    }
    expect(tools.find(entry => entry.name === 'browser_eval')?.op).toBe('script');
  });
  test('a ferret may never test the proxy (it dials out with stored credentials)', () => {
    expect(routes.find(route => route.key === 'POST /v1/browser/proxy/test')?.caller).toBe('person');
  });
  describe("browsers.yaml holds a new or re-aimed proxy for the owner (today's browserProxyLoosening)", () => {
    const def = manifest.data.config.find(entry => entry.shape === 'file' && entry.file === 'browsers.yaml');
    const loosens = (before: unknown, after: unknown): readonly string[] =>
      (def as unknown as { loosens: (b: unknown, a: unknown) => readonly string[] }).loosens(before, after);
    const proxy = { url: 'http://proxy.example:8080', bypass: [] as string[] };
    const sentence = 'the agent browser now sends its traffic through the proxy at ';

    test('a proxy newly set, on a first file or an existing one, is held', () => {
      expect(loosens(undefined, { mode: 'headless', proxy })).toEqual([`${sentence}${proxy.url}`]);
      expect(loosens({ mode: 'headless' }, { mode: 'headless', proxy })).toEqual([`${sentence}${proxy.url}`]);
    });
    test('a proxy re-aimed, or given other credentials, is held', () => {
      const before = { mode: 'headless', proxy };
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, url: 'http://other.example:8080' } })).toEqual([
        `${sentence}http://other.example:8080`,
      ]);
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, username: '${secret:PROXY_USER}' } })).toHaveLength(
        1,
      );
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, password: '${secret:PROXY_PASS}' } })).toHaveLength(
        1,
      );
    });
    test('removing the proxy, or editing only its bypass list or the mode, hands an agent nothing', () => {
      const before = { mode: 'headless', proxy };
      expect(loosens(before, { mode: 'headless' })).toEqual([]);
      expect(loosens(before, { mode: 'headless', proxy: { ...proxy, bypass: ['<local>'] } })).toEqual([]);
      expect(loosens(before, { mode: 'headed', proxy })).toEqual([]);
      expect(loosens(undefined, { mode: 'headless' })).toEqual([]);
    });
  });
  test('takes the page input target and the %browser reference menu', () => {
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'input.targets:page',
      'reference.catalog:%browser',
    ]);
  });
});
