import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { ProjectIdSchema, SetProjectAccountsRequestSchema } from '../../../contract/index.ts';
import { parseBody } from '../../lib/body.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { belowHome } from '../folders/fence.ts';
import { outsideHomeGate } from '../folders/outside-gate.ts';
import { type ScanDeps, scanRepos } from './scan.ts';

const projectId = (raw: string | undefined) => {
  const id = ProjectIdSchema.safeParse(decodeParameter(raw ?? ''));
  if (!id.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
  return id.data;
};

/**
 * `GET /v1/projects/:id/repos`: scans the project folder now and answers (and keeps) what it found. A scan that did not
 * see everything (`truncated`: a bound, a refused or missing folder, an unreadable one) only ADDS what it found: a stored
 * repository it did not see, and the account linked to it, stay.
 *
 * Two stages, as the folder explorer has them (owner decision D3, lead decision R1). The route declares `filesystem.use`: that
 * reads what is SAVED for a project. STARTING a scan of a project folder OUTSIDE the home is new disk I/O outside the home
 * and needs `filesystem.configure` too (`outside-gate.ts`: a passkey step-up for a remote device; the caller at the machine
 * is ungoverned). A caller the gate refuses is answered what was saved, `truncated` (nothing was looked at, so it is not the
 * whole list), with no I/O and nothing written. A call with no standing at all is refused, never read on a guess.
 */
export const reposRoute =
  (registry: ProjectRegistry, scan: ScanDeps): RouteHandler =>
  async call => {
    const id = projectId(call.params.get('id'));
    const project = await registry.find(id);
    if (project === undefined) throw new ApiError(404, `no project ${id}`, 'not-found');
    // ONE decision per call (a step-up is spent once): asked here for a stored spelling outside the home, and by the scan for
    // where the folder RESOLVES to, which a spelling under the home can differ from.
    let decided: Promise<void> | undefined;
    const gate = (): Promise<void> => {
      decided ??= outsideHomeGate(call)();
      return decided;
    };
    // Only the gate's own refusal means "saved results only"; a daemon that cannot decide (503) stays an error.
    const savedOnly = (refusal: unknown) => {
      if (!(refusal instanceof ApiError) || refusal.status !== 403) throw refusal;
      return jsonResponse({ repos: project.repos ?? [], truncated: true });
    };
    if (belowHome(project.path, await scan.browser.home()) === undefined) {
      try {
        await gate();
      } catch (refusal) {
        return savedOnly(refusal);
      }
    }
    let result: Awaited<ReturnType<typeof scanRepos>>;
    try {
      result = await scanRepos(project.path, { ...scan, outsideHome: gate });
    } catch (refusal) {
      return savedOnly(refusal);
    }
    const kept = await registry.recordRepos(id, result.repos, !result.truncated);
    if (!kept.ok) throw new ApiError(404, kept.error.message, 'not-found');
    return jsonResponse({ repos: kept.value.repos ?? [], truncated: result.truncated });
  };

/** `PUT /v1/projects/:id/accounts` `{accounts}`: the whole list, in order. Answers the project. */
export const accountsRoute =
  (registry: ProjectRegistry): RouteHandler =>
  async call => {
    const id = projectId(call.params.get('id'));
    const body = await parseBody(call.request, SetProjectAccountsRequestSchema);
    const set = await registry.setAccounts(id, body.accounts);
    if (!set.ok) throw new ApiError(404, set.error.message, 'not-found');
    return jsonResponse(set.value);
  };
