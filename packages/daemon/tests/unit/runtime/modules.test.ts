import type { SocketRoute } from '../../../src/lib/api/socket.ts';
import { AUDITED_ROUTES } from '../../../src/lib/audit/routes.ts';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { describe, expect, it } from 'bun:test';
import type { ApiRoute, RoutePattern } from '../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import {
  compareRouteSpecificity,
  composeModules,
  orderRoutesBySpecificity,
  type BuiltModule,
} from '../../../src/lib/runtime/modules.ts';
import { base, subsystems } from './mounts/surface-world.ts';
import { request } from '../api/support.ts';

const route = (path: string, precedence?: number): RoutePattern => ({
  method: 'GET',
  path,
  ...(precedence === undefined ? {} : { precedence }),
});

describe('route specificity', () => {
  it('compares segment by segment, literal before parameter before catch-all', () => {
    expect(compareRouteSpecificity(route('/a/literal/*rest'), route('/a/:id/fixed'))).toBeLessThan(0);
    expect(compareRouteSpecificity(route('/a/:id'), route('/a/*rest'))).toBeLessThan(0);
    expect(compareRouteSpecificity(route('/a'), route('/a/*rest'))).toBeLessThan(0);
    expect(compareRouteSpecificity(route('/'), route('/*rest'))).toBeLessThan(0);
    expect(compareRouteSpecificity(route('/a/:first'), route('/z/:second'))).toBe(0);
    expect(compareRouteSpecificity(route('/a/:first/'), route('/a/:second'))).toBe(0);
    expect(compareRouteSpecificity(route('/a/*first/ignored'), route('/a/*second'))).toBe(0);
  });
  it('uses an explicit precedence before specificity', () => {
    expect(compareRouteSpecificity(route('/a/*rest', 1), route('/a/literal'))).toBeLessThan(0);
    expect(compareRouteSpecificity(route('/a/literal', -1), route('/a/:id'))).toBeGreaterThan(0);
    expect(compareRouteSpecificity(route('/a/literal', 1), route('/a/:id', 1))).toBeLessThan(0);
  });
  it('sorts a copy stably and keeps duplicate availability fallthrough dynamic', () => {
    let available = false;
    const first = { ...route('/a/:id'), available: () => available };
    const second = route('/a/:name');
    const literal = route('/a/literal');
    const registered = [first, second, literal];
    const ordered = orderRoutesBySpecificity(registered);
    expect(registered).toEqual([first, second, literal]);
    expect(ordered).toEqual([literal, first, second]);
    const router = new ApiRouter(ordered);
    const lookup = () => router.lookup('GET', '/a/value');
    let selected = lookup();
    expect(selected.kind === 'matched' && selected.route).toBe(second);
    available = true;
    selected = lookup();
    expect(selected.kind === 'matched' && selected.route).toBe(first);
    // Other router users retain registration order.
    const unsorted = new ApiRouter(registered).lookup('GET', '/a/literal');
    expect(unsorted.kind === 'matched' && unsorted.route).toBe(first);
  });
});

describe('module composition', () => {
  it('keeps inventories in module order while HTTP dispatch prefers specificity', async () => {
    const mounted = subsystems();
    const make = (path: string, body: string) => ({
      method: 'GET',
      path,
      minimum: 'none' as const,
      caller: 'any' as const,
      handle: async () => ({ status: 200, headers: new Map<string, string>(), body }),
    });
    const broad = make('/composed/:id', 'parameter');
    const specific = make('/composed/literal', 'literal');
    const modules: readonly BuiltModule<void>[] = [
      { id: 'broad', provides: undefined, jobs: {}, contributes: { routes: [broad] } },
      { id: 'empty', provides: undefined, jobs: {}, contributes: {} },
      { id: 'specific', provides: undefined, jobs: {}, contributes: { routes: [specific] } },
    ];
    const host = composeModules({ ...mounted, credentials: base.credentials }, modules);
    expect(host.routes.map(route => route.path)).toEqual([broad.path, specific.path]);
    expect((await host.dispatcher.dispatch(request({ path: '/composed/literal' }))).body).toBe('literal');
  });
  it('appends carriers after decoration and after the ordered module socket table', async () => {
    const mounted = subsystems();
    let carrierCalls = 0;
    const carrier = {
      method: 'GET',
      path: '/carrier/:id',
      minimum: 'none' as const,
      caller: 'any' as const,
      accept: async () => {
        carrierCalls += 1;
        return async () => ({ open: async () => {}, fromClient: () => {}, close: () => {} });
      },
    };
    const host = composeModules({ ...mounted, credentials: base.credentials }, []);
    const answer = await host.socketDispatcher([carrier]).upgrade(request({ path: '/carrier/test' }));
    expect(answer.outcome).toBe('accepted');
    expect(carrierCalls).toBe(1);
    expect(host.sockets).toEqual([]);
    expect(
      await host
        .socketDispatcher()
        .upgrade(request({ path: '/carrier/test', headers: { authorization: `Bearer ${base.credentials.admin}` } })),
    ).toEqual({ outcome: 'unclaimed' });
  });
  it('keeps a carrier behind an overlapping module socket even when the carrier is more specific', async () => {
    const mounted = subsystems();
    let moduleCalls = 0;
    let carrierCalls = 0;
    const accept = async () => async () => ({ open: async () => {}, fromClient: () => {}, close: () => {} });
    const moduleSocket: SocketRoute = {
      method: 'GET',
      path: '/carrier/:id',
      minimum: 'none',
      caller: 'any',
      accept: async () => {
        moduleCalls += 1;
        return accept();
      },
    };
    const carrier: SocketRoute = {
      ...moduleSocket,
      path: '/carrier/literal',
      precedence: 100,
      accept: async () => {
        carrierCalls += 1;
        return accept();
      },
    };
    const host = composeModules({ ...mounted, credentials: base.credentials }, [
      { id: 'socket', provides: undefined, jobs: {}, contributes: { sockets: [moduleSocket] } },
    ]);
    expect((await host.socketDispatcher([carrier]).upgrade(request({ path: '/carrier/literal' }))).outcome).toBe(
      'accepted',
    );
    expect(moduleCalls).toBe(1);
    expect(carrierCalls).toBe(0);
  });
});

describe('module audit contributions', () => {
  const http = (path: string, method = 'POST'): ApiRoute => ({
    method,
    path,
    minimum: 'none',
    caller: 'any',
    handle: async () => ({ status: 200, headers: new Map(), body: '{}' }),
  });
  const socket = (path: string): SocketRoute => ({
    method: 'GET',
    path,
    minimum: 'none',
    caller: 'any',
    accept: async () => async () => ({ open: async () => {}, fromClient: () => {}, close: () => {} }),
  });
  it('unions HTTP and socket rules from multiple modules', async () => {
    const mounted = subsystems();
    const entries: AuditEntry[] = [];
    const audit = {
      ...mounted.audit,
      log: {
        record: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      },
    };
    const modules: BuiltModule<void>[] = ['one', 'two'].map(id => ({
      id,
      provides: undefined,
      jobs: {},
      contributes: {
        routes: [http(`/custom/${id}`)],
        sockets: [socket(`/custom/${id}/stream`)],
        audit: {
          routes: [{ method: 'POST', path: `/custom/${id}`, event: 'browser.opened' }],
          sockets: [{ path: `/custom/${id}/stream`, event: 'terminal.opened', subject: 'id' }],
        },
      },
    }));
    const host = composeModules({ ...mounted, audit }, modules);
    for (const route of host.routes)
      await route.handle({ request: request({ method: route.method, path: route.path }), params: new Map() });
    for (const route of host.sockets)
      await route.accept({ request: request({ path: route.path }), params: new Map([['id', 'target']]) });
    expect(entries.map(entry => entry.event)).toEqual([
      'browser.opened',
      'browser.opened',
      'terminal.opened',
      'terminal.opened',
    ]);
  });
  it('applies no audit when no module contributes rules, and reports an empty inventory', async () => {
    const mounted = subsystems();
    const entries: AuditEntry[] = [];
    const audit = {
      ...mounted.audit,
      log: {
        record: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      },
    };
    const httpRule = AUDITED_ROUTES[0];
    const socketRule = { path: '/v1/sessions/:sessionId/browser/stream' };
    if (httpRule === undefined) throw new Error('the shared audit inventories must exist');
    const contribution = { routes: [http(httpRule.path, httpRule.method)], sockets: [socket(socketRule.path)] };
    // Three shapes of "no rules": no audit key, an audit with no arrays, and explicitly empty arrays.
    const shapes = [undefined, {}, { routes: [], sockets: [] }];
    for (const auditRules of shapes) {
      entries.length = 0;
      const host = composeModules({ ...mounted, audit }, [
        {
          id: 'extracted',
          provides: undefined,
          jobs: {},
          contributes: { ...contribution, ...(auditRules === undefined ? {} : { audit: auditRules }) },
        },
      ]);
      for (const route of host.routes)
        await route.handle({ request: request({ method: route.method, path: route.path }), params: new Map() });
      for (const route of host.sockets)
        await route.accept({ request: request({ path: route.path }), params: new Map() });
      expect(entries).toEqual([]);
      expect(host.audit).toEqual({ routes: [], sockets: [] });
    }
  });
  it('does not inherit shared rules from an unrelated module that contributes an empty union', async () => {
    const mounted = subsystems();
    const entries: AuditEntry[] = [];
    const audit = {
      ...mounted.audit,
      log: {
        record: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      },
    };
    const httpRule = AUDITED_ROUTES[0];
    const socketRule = { path: '/v1/sessions/:sessionId/browser/stream' };
    if (httpRule === undefined) throw new Error('the shared audit inventories must exist');
    const mounting: BuiltModule<void> = {
      id: 'mounting',
      provides: undefined,
      jobs: {},
      contributes: { routes: [http(httpRule.path, httpRule.method)], sockets: [socket(socketRule.path)] },
    };
    const empty: BuiltModule<void> = {
      id: 'empty',
      provides: undefined,
      jobs: {},
      contributes: { audit: { routes: [], sockets: [] } },
    };
    for (const modules of [[mounting], [mounting, empty], [empty, mounting]]) {
      entries.length = 0;
      const host = composeModules({ ...mounted, audit }, modules);
      for (const route of host.routes)
        await route.handle({ request: request({ method: route.method, path: route.path }), params: new Map() });
      for (const route of host.sockets)
        await route.accept({ request: request({ path: route.path }), params: new Map() });
      expect(entries).toEqual([]);
      expect(host.audit).toEqual({ routes: [], sockets: [] });
    }
  });
});
