import type { RouteParameters } from '../contract/http.ts';
import type { RoutePattern } from '../contract/route.ts';

/**
 * Today's route table, copied from `packages/daemon/src/lib/api/router.ts` and `runtime/modules.ts`
 * (`orderRoutesBySpecificity`), unchanged: matching over RAW segments, routes tried in specificity order, explicit
 * precedence first, then literal > parameter > catch-all at the first differing segment.
 *
 * The test host uses this until the kernel host exports its dispatcher; then the test host takes the host's.
 */
export type RouteLookup<TRoute extends RoutePattern> =
  | { readonly kind: 'matched'; readonly route: TRoute; readonly params: RouteParameters }
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly string[] }
  | { readonly kind: 'not-found' };

interface Segment {
  readonly kind: 'literal' | 'parameter' | 'catch-all';
  readonly value: string;
}

/** Splits on '/', dropping only the empties a leading or trailing slash produces. Interior empties are kept. */
function splitPath(path: string): readonly string[] {
  const segments = path.split('/');
  if (segments[0] === '') segments.shift();
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

function parsePattern(path: string): readonly Segment[] {
  return splitPath(path).map(segment => {
    if (segment.startsWith(':')) return { kind: 'parameter', value: segment.slice(1) } as const;
    if (segment.startsWith('*')) return { kind: 'catch-all', value: segment.slice(1) } as const;
    return { kind: 'literal', value: segment } as const;
  });
}

/** Explicit precedence first, then literal > parameter > catch-all at the first differing segment. */
export function compareRouteSpecificity(left: RoutePattern, right: RoutePattern): number {
  const precedence = (right.precedence ?? 0) - (left.precedence ?? 0);
  if (precedence !== 0) return precedence;
  const a = splitPath(left.path);
  const b = splitPath(right.path);
  const rank = (part: string | undefined): number =>
    part === undefined ? 4 : part.startsWith('*') ? 1 : part.startsWith(':') ? 2 : 3;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = rank(b[index]) - rank(a[index]);
    if (difference !== 0) return difference;
    if (a[index]?.startsWith('*') && b[index]?.startsWith('*')) return 0;
  }
  return 0;
}

/** A sorted copy; the stable sort keeps duplicates and their `available()` fallthrough order. */
export function orderRoutesBySpecificity<T extends RoutePattern>(routes: readonly T[]): readonly T[] {
  return [...routes].sort(compareRouteSpecificity);
}

function match(pattern: readonly Segment[], path: readonly string[]): RouteParameters | undefined {
  const params = new Map<string, string>();
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index] as Segment;
    if (segment.kind === 'catch-all') {
      params.set(segment.value, path.slice(index).join('/'));
      return params;
    }
    const actual = path[index];
    if (actual === undefined) return undefined;
    if (segment.kind === 'literal') {
      if (segment.value !== actual) return undefined;
      continue;
    }
    if (actual === '') return undefined;
    params.set(segment.value, actual);
  }
  return path.length === pattern.length ? params : undefined;
}

export class RouteTable<TRoute extends RoutePattern> {
  private readonly compiled: readonly { readonly route: TRoute; readonly segments: readonly Segment[] }[];

  constructor(routes: readonly TRoute[]) {
    this.compiled = orderRoutesBySpecificity(routes).map(route => ({ route, segments: parsePattern(route.path) }));
  }

  get routes(): readonly TRoute[] {
    return this.compiled.map(entry => entry.route);
  }

  lookup(method: string, path: string): RouteLookup<TRoute> {
    const segments = splitPath(path);
    const pathMatches = this.compiled.filter(
      entry => match(entry.segments, segments) !== undefined && entry.route.available?.() !== false,
    );
    if (pathMatches.length === 0) return { kind: 'not-found' };
    const verb = method.toUpperCase();
    const matched = pathMatches.find(entry => entry.route.method.toUpperCase() === verb);
    if (matched === undefined)
      return {
        kind: 'method-not-allowed',
        allowed: [...new Set(pathMatches.map(e => e.route.method.toUpperCase()))].sort(),
      };
    return { kind: 'matched', route: matched.route, params: match(matched.segments, segments) ?? new Map() };
  }
}
