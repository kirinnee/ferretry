import type { RouteParameters } from '../contract/http.ts';
import type { RoutePattern } from '../contract/route.ts';

/**
 * The route table, copied from today's `ApiRouter` (§7.10 "routing by specificity"). Matching is over RAW path
 * segments: the pathname is never normalised or decoded first, so an encoded traversal cannot present one shape to
 * admission and another to the handler. Routes are tried in table order; the host orders them by specificity first.
 */
export type RouteLookup<Route extends RoutePattern> =
  | { readonly kind: 'matched'; readonly route: Route; readonly params: RouteParameters }
  /** The path exists but not under this verb. `allowed` fills the `Allow` header. */
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly string[] }
  | { readonly kind: 'not-found' };

interface Segment {
  readonly kind: 'literal' | 'parameter' | 'catch-all';
  readonly value: string;
}

/**
 * Splits on '/', dropping ONLY the empties a leading or trailing slash produces. Interior empties are kept:
 * `/v1/ferrets//send` names no ferret, and collapsing it would hand a handler an empty identifier.
 */
export function splitPath(path: string): readonly string[] {
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
    // A parameter must capture something.
    if (actual === '') return undefined;
    params.set(segment.value, actual);
  }
  return path.length === pattern.length ? params : undefined;
}

export class Router<Route extends RoutePattern> {
  private readonly compiled: readonly { readonly route: Route; readonly segments: readonly Segment[] }[];

  constructor(routes: readonly Route[]) {
    this.compiled = routes.map(route => ({ route, segments: parsePattern(route.path) }));
  }

  get routes(): readonly Route[] {
    return this.compiled.map(entry => entry.route);
  }

  lookup(method: string, path: string): RouteLookup<Route> {
    const segments = splitPath(path);
    const pathMatches = this.compiled.filter(
      entry => match(entry.segments, segments) !== undefined && entry.route.available?.() !== false,
    );
    if (pathMatches.length === 0) return { kind: 'not-found' };
    const verb = method.toUpperCase();
    const matched = pathMatches.find(entry => entry.route.method.toUpperCase() === verb);
    if (matched === undefined) {
      const allowed = [...new Set(pathMatches.map(entry => entry.route.method.toUpperCase()))].sort();
      return { kind: 'method-not-allowed', allowed };
    }
    return { kind: 'matched', route: matched.route, params: match(matched.segments, segments) ?? new Map() };
  }
}

/** Explicit precedence first, then literal > parameter > catch-all at the first differing segment (today's rule). */
export function compareRouteSpecificity(left: RoutePattern, right: RoutePattern): number {
  const precedence = (right.precedence ?? 0) - (left.precedence ?? 0);
  if (precedence !== 0) return precedence;
  const a = splitPath(left.path);
  const b = splitPath(right.path);
  // An exact endpoint beats a catch-all that can capture an empty suffix.
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
export function orderRoutesBySpecificity<Route extends RoutePattern>(routes: readonly Route[]): readonly Route[] {
  return [...routes].sort(compareRouteSpecificity);
}
