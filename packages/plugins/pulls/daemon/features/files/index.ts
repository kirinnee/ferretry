import type { RouteHandler } from '@ferretry/kernel/contract';
import type { PullsServices } from '../../routes.ts';
import { filesRoute } from './routes.ts';

/** The files route (r9 E5). */
export const filesRoutes = (
  services: PullsServices,
): Readonly<Record<'GET /v1/pulls/:project/:repo/:number/files', RouteHandler>> => ({
  'GET /v1/pulls/:project/:repo/:number/files': filesRoute(services),
});
