import { describe, expect, it } from 'bun:test';
import type { RoutePattern } from '../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { mountedDaemonRoutes, mountedSocketRoutes } from '../../../src/lib/runtime/mounts/index.ts';
import { orderRoutesBySpecificity } from '../../../src/lib/runtime/modules.ts';
import { surfaceCarrier } from './mounts/surface-carrier.ts';
import { base, subsystems } from './mounts/surface-world.ts';

const parts = (path: string) =>
  path
    .replace(/^\/|\/$/gu, '')
    .split('/')
    .filter((part, index, all) => part !== '' || all.length > 1 || index > 0);
const variable = (part: string) => part.startsWith(':') || part.startsWith('*');

/** Intersection of the router's segment languages; catch-alls include an empty suffix. */
function witness(left: string, right: string): string | undefined {
  const a = parts(left);
  const b = parts(right);
  const path: string[] = [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index],
      y = b[index];
    if (x?.startsWith('*') || y?.startsWith('*')) {
      const rest = x?.startsWith('*') ? b.slice(index) : a.slice(index);
      path.push(...rest.map(part => (variable(part) ? 'witness' : part)));
      return `/${path.join('/')}`;
    }
    if (x === undefined || y === undefined) return undefined;
    if (!variable(x) && !variable(y) && x !== y) return undefined;
    const segment = !variable(x) ? x : !variable(y) ? y : 'witness';
    if (segment === '' && (variable(x) || variable(y))) return undefined;
    path.push(segment);
  }
  return `/${path.join('/')}`;
}

function equivalent<T extends RoutePattern>(routes: readonly T[], method: string, path: string) {
  const original = new ApiRouter(routes).lookup(method, path);
  const ordered = new ApiRouter(orderRoutesBySpecificity(routes)).lookup(method, path);
  expect(ordered.kind).toBe(original.kind);
  if (original.kind === 'matched' && ordered.kind === 'matched') {
    // Identity, not just the route's pattern: duplicates may have different handlers or authority.
    expect(ordered.route).toBe(original.route);
    expect(ordered.params).toEqual(original.params);
  } else expect(ordered).toEqual(original);
  return original;
}

function prove(table: string, routes: readonly RoutePattern[]) {
  const overlaps: Array<{ left: RoutePattern; right: RoutePattern; path: string }> = [];
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const left = routes[i],
        right = routes[j];
      if (left === undefined || right === undefined) throw new Error('route pair outside inventory');
      if (left.method.toUpperCase() !== right.method.toUpperCase()) continue;
      const path = witness(left.path, right.path);
      if (path !== undefined) overlaps.push({ left, right, path });
    }
  }
  describe(`${table}: ${overlaps.length} overlapping pairs`, () => {
    for (const { left, right, path } of overlaps) {
      it(`${left.method} ${left.path} vs ${right.path}, at ${path}`, () => {
        // Verify the witness independently, so a broken intersection cannot quietly weaken the proof.
        expect(new ApiRouter([left]).lookup(left.method, path).kind).toBe('matched');
        expect(new ApiRouter([right]).lookup(right.method, path).kind).toBe('matched');
        equivalent([left, right], left.method, path);
        equivalent(routes, left.method, path);
        expect(equivalent(routes, 'NO-SUCH-VERB', path).kind).toBe('method-not-allowed');
        expect(equivalent(routes, left.method, `/__unmounted__${path}`).kind).toBe('not-found');
      });
    }
    it('preserves every mounted route witness, allowed verbs, and missing paths', () => {
      for (const route of routes) {
        const path = witness(route.path, route.path);
        if (path === undefined) throw new Error(`no witness for ${route.method} ${route.path}`);
        expect(equivalent(routes, route.method, path).kind).toBe('matched');
        const denied = equivalent(routes, 'NO-SUCH-VERB', path);
        expect(denied.kind).toBe('method-not-allowed');
        expect(equivalent(routes, route.method, `/__unmounted__${path}`).kind).toBe('not-found');
      }
    });
  });
}

const mounted = subsystems();
prove('HTTP', mountedDaemonRoutes(base, mounted));
prove('sockets with carrier', [...mountedSocketRoutes(mounted), surfaceCarrier()]);

describe('overlap witness construction', () => {
  it('covers literals, parameters, catch-all suffixes, empty captures and incompatible lengths', () => {
    expect(witness('/a/:id', '/a/literal')).toBe('/a/literal');
    expect(witness('/a/*tail', '/a')).toBe('/a');
    expect(witness('/a/*tail', '/a/:id/b')).toBe('/a/witness/b');
    expect(witness('/a/*tail', '/a/*rest')).toBe('/a/witness');
    expect(witness('/a/:id', '/a')).toBeUndefined();
    expect(witness('/a/b', '/a/c')).toBeUndefined();
    expect(witness('/a/:id/b', '/a//b')).toBeUndefined();
  });
});
