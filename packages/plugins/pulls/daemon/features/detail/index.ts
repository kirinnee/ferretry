import type { RouteHandler } from '@ferretry/kernel/contract';
import { type DetailDeps, detailRoute } from './routes.ts';

/** The PR page's route (E4). Registered by one line in `daemon/routes.ts`. */
export const detailRoutes = (
  deps: DetailDeps,
): Readonly<Record<'GET /v1/pulls/:project/:repo/:number', RouteHandler>> => ({
  'GET /v1/pulls/:project/:repo/:number': detailRoute(deps),
});
