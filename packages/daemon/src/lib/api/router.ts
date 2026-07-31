import type { RouteParameters } from './http.ts';
import type { ApiRoute } from './route.ts';

export type RouteLookup =
  | { readonly kind: 'matched'; readonly route: ApiRoute; readonly params: RouteParameters }
  /** The path exists but not under this verb. `allowed` populates the `Allow` header. */
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly string[] }
  | { readonly kind: 'not-found' };

interface Segment {
  readonly kind: 'literal' | 'parameter' | 'catch-all';
  readonly value: string;
}

function parsePattern(path: string): readonly Segment[] {
  return splitPath(path).map(segment => {
    if (segment.startsWith(':')) return { kind: 'parameter', value: segment.slice(1) } as const;
    if (segment.startsWith('*')) return { kind: 'catch-all', value: segment.slice(1) } as const;
    return { kind: 'literal', value: segment } as const;
  });
}

/**
 * Splits on '/', dropping ONLY the empties a leading or trailing slash produces, so `/v1/usage` and
 * `/v1/usage/` are the same route rather than a silent 404 for the trailing-slash caller.
 *
 * Interior empties are deliberately kept: `/v1/sessions//send` names no session, and collapsing it
 * would hand a handler an empty identifier that every downstream lookup then has to defend against.
 */
function splitPath(path: string): readonly string[] {
  const segments = path.split('/');
  if (segments[0] === '') segments.shift();
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

interface CompiledRoute {
  readonly route: ApiRoute;
  readonly segments: readonly Segment[];
}

/**
 * The route table.
 *
 * Matching is over RAW path segments — the pathname is never normalized or decoded first, so an
 * encoded traversal cannot present one shape to the authorization check and another to the handler.
 * Routes are tried in registration order, so a literal registered before a parameter wins; that is
 * how `/v1/sessions/summary` can coexist with `/v1/sessions/:id`.
 */
export class ApiRouter {
  private readonly compiled: readonly CompiledRoute[];

  constructor(routes: readonly ApiRoute[]) {
    this.compiled = routes.map(route => ({ route, segments: parsePattern(route.path) }));
  }

  /** Every registered route, for callers that need to describe the surface. */
  get routes(): readonly ApiRoute[] {
    return this.compiled.map(entry => entry.route);
  }

  lookup(method: string, path: string): RouteLookup {
    const segments = splitPath(path);
    const pathMatches = this.compiled.filter(entry => match(entry.segments, segments) !== undefined);
    if (pathMatches.length === 0) return { kind: 'not-found' };
    const verb = method.toUpperCase();
    const matched = pathMatches.find(entry => entry.route.method.toUpperCase() === verb);
    if (matched === undefined) {
      // De-duplicated because two routes may share a verb on the same path pattern only by mistake,
      // and a repeated `Allow` entry would be a confusing thing to hand a client.
      const allowed = [...new Set(pathMatches.map(entry => entry.route.method.toUpperCase()))].sort();
      return { kind: 'method-not-allowed', allowed };
    }
    return { kind: 'matched', route: matched.route, params: match(matched.segments, segments) ?? new Map() };
  }
}

/** Returns the captured parameters, or `undefined` when the pattern does not match. */
function match(pattern: readonly Segment[], path: readonly string[]): RouteParameters | undefined {
  const params = new Map<string, string>();
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index]!;
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
    // A parameter must capture something: `/v1/sessions//send` names no session.
    if (actual === '') return undefined;
    params.set(segment.value, actual);
  }
  return path.length === pattern.length ? params : undefined;
}
