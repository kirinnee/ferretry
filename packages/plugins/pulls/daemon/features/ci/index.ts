import type { RouteHandler } from '@ferretry/kernel/contract';
import { CiReader } from './reader.ts';
import { type CiRouteDeps, runRoute, runsRoute } from './routes.ts';
import type { GithubClient } from '../../adapters/github/client.ts';

export interface CiServices {
  readonly github: GithubClient;
  readonly nowMs: () => number;
  readonly projects: CiRouteDeps['projects'];
  readonly accounts: CiRouteDeps['accounts'];
}

/** CI data (r9 E8): a pull request's or branch's runs, and one run with its jobs, steps and timing. */
export function ciRoutes(
  services: CiServices,
): Readonly<Record<'GET /v1/pulls/:project/:repo/runs' | 'GET /v1/pulls/:project/:repo/runs/:runId', RouteHandler>> {
  const deps: CiRouteDeps = {
    reader: new CiReader(services.github, services.nowMs),
    projects: services.projects,
    accounts: services.accounts,
  };
  return {
    'GET /v1/pulls/:project/:repo/runs': runsRoute(deps),
    'GET /v1/pulls/:project/:repo/runs/:runId': runRoute(deps),
  };
}
