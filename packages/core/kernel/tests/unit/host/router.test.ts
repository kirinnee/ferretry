import { describe, expect, test } from 'bun:test';
import { orderRoutesBySpecificity, Router } from '../../../host/router.ts';

const routes = (paths: readonly string[]) => paths.map(path => ({ method: 'GET', path }));

describe('routing by specificity (§7.10)', () => {
  test('a literal beats a parameter, which beats a catch-all, whatever the declaration order', () => {
    const ordered = orderRoutesBySpecificity(routes(['/v1/files/*rest', '/v1/ferrets/:id', '/v1/ferrets/summary']));
    const router = new Router(ordered);
    const summary = router.lookup('GET', '/v1/ferrets/summary');
    expect(summary.kind === 'matched' && summary.route.path).toBe('/v1/ferrets/summary');
    const one = router.lookup('GET', '/v1/ferrets/F1');
    expect(one.kind === 'matched' && one.params.get('id')).toBe('F1');
    const rest = router.lookup('GET', '/v1/files/a/b');
    expect(rest.kind === 'matched' && rest.params.get('rest')).toBe('a/b');
  });

  test('explicit precedence wins over specificity', () => {
    const ordered = orderRoutesBySpecificity([
      { method: 'GET', path: '/v1/x/literal' },
      { method: 'GET', path: '/v1/x/:id', precedence: 1 },
    ]);
    expect(ordered[0]?.path).toBe('/v1/x/:id');
  });

  test('raw segments: an encoded slash is one segment, an empty segment names nothing', () => {
    const router = new Router(routes(['/v1/ferrets/:id/send']));
    expect(router.lookup('GET', '/v1/ferrets//send').kind).toBe('not-found');
    const encoded = router.lookup('GET', '/v1/ferrets/a%2Fb/send');
    expect(encoded.kind === 'matched' && encoded.params.get('id')).toBe('a%2Fb');
  });

  test('a wrong verb is 405 with the allowed verbs; a trailing slash is the same route', () => {
    const router = new Router([
      { method: 'GET', path: '/v1/board' },
      { method: 'POST', path: '/v1/board' },
    ]);
    expect(router.lookup('DELETE', '/v1/board')).toEqual({ kind: 'method-not-allowed', allowed: ['GET', 'POST'] });
    expect(router.lookup('GET', '/v1/board/').kind).toBe('matched');
  });

  test('a route whose available() is false is not in the table', () => {
    const router = new Router([{ method: 'GET', path: '/v1/x', available: () => false }]);
    expect(router.lookup('GET', '/v1/x').kind).toBe('not-found');
  });
});
