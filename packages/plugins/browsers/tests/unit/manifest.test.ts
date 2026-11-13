import { describe, expect, test } from 'bun:test';
import { showsSomething } from '@ferretry/kernel/contract';
import manifest from '../../manifest.ts';

const routes = manifest.actions.routes;
const tools = manifest.actions.agentTools;

describe('browsers manifest', () => {
  test("declares today's browser, login-window, proxy and surface routes, the open-url route (G27) and the page stream", () => {
    expect(routes).toHaveLength(10);
    expect(manifest.actions.sockets.map(socket => socket.key)).toEqual(['GET /v1/sessions/:sessionId/browser/stream']);
  });
  test('the page stream and the per-ferret browser are built inside one Redaction.read', () => {
    expect(manifest.actions.sockets[0]?.guard).toBe('secrets');
    expect(routes.find(route => route.key === 'GET /v1/sessions/:sessionId/browser')?.guard).toBe('secrets');
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
  test('takes the page input target and the %browser reference menu', () => {
    expect(manifest.hooks.takes.map(take => `${take.hook.name}:${take.key}`)).toEqual([
      'input.targets:page',
      'reference.catalog:%browser',
    ]);
  });
});
