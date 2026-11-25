import type { RoutePattern } from '../contract/route.ts';
import type { RouteLookup } from './router.ts';

/** Public declarations are literal endpoints. Neither a path alias nor a method map is a public surface. */
export class PublicRouter<Route extends RoutePattern> {
  constructor(readonly routes: readonly Route[]) {}

  lookup(method: string, path: string): RouteLookup<Route> {
    const route = this.routes.find(
      route => route.method === method && route.path === path && route.available?.() !== false,
    );
    return route === undefined ? { kind: 'not-found' } : { kind: 'matched', route, params: new Map() };
  }
}
