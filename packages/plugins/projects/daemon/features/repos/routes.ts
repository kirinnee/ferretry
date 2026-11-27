import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  CloneRepoRequestSchema,
  cloneFolderName,
  type ProjectId,
  ProjectIdSchema,
  type ProjectInfo,
  SetProjectAccountsRequestSchema,
} from '../../../contract/index.ts';
import type { ProjectFolders } from '../../lib/ports.ts';
import { parseBody } from '../../lib/body.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { belowHome } from '../folders/fence.ts';
import { folderPolicy } from '../folders/policy.ts';
import { outsideHomeGate } from '../folders/outside-gate.ts';
import { isScannableRepoName, type ScanDeps, scanRepos } from './scan.ts';

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
  (registry: ProjectRegistry, scan: ScanDeps, listChanged: (id: ProjectId) => void = () => undefined): RouteHandler =>
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
    return await keepScan(registry, scan, listChanged, project, gate);
  };

/** Scans the project folder, keeps what it found on the record and answers it; the gate is the call's one outside-home decision. */
const keepScan = async (
  registry: ProjectRegistry,
  scan: ScanDeps,
  listChanged: (id: ProjectId) => void,
  project: ProjectInfo,
  gate: () => Promise<void>,
  cloned?: string,
) => {
  const id = project.id;
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
    if (cloned !== undefined) throw refusal;
    return savedOnly(refusal);
  }
  if (cloned !== undefined && !result.repos.some(repo => repo.path === cloned))
    throw cloneRefused(
      'Git finished, but the new repository could not be listed. Check the project folder before trying again.',
    );
  // A scan that changed the list means the folder changed under what the file index holds (plan §3.5): it is out of date.
  // The registry says so from inside its serial update: a scan that overlapped another is judged against what that one wrote.
  const kept = await registry.recordRepos(id, result.repos, !result.truncated, () => listChanged(id));
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

/** The one sentence a clone refused for a reason the owner can fix says; each is a 422 `project_clone_failed`. */
const cloneRefused = (message: string): ApiError => new ApiError(422, message, 'project_clone_failed');

/**
 * `POST /v1/projects/:id/repos` `{url}`: clones another repository into an existing project, as a folder named after it,
 * then scans the project so the new repository is on the record. Remote sources only, cloned inside a held, exclusively
 * created destination, never over something that is already there. A project that is itself a repository is
 * refused: a scan never looks inside a repository, so a clone made there would not be listed.
 *
 * The route declares `filesystem.configure` (it writes the disk). A project outside the home is gated BEFORE anything is cloned,
 * as the scan is, and the one decision serves both. Answers what `GET .../repos` answers.
 */
export const cloneRoute =
  (
    registry: ProjectRegistry,
    folders: ProjectFolders,
    scan: ScanDeps,
    listChanged: (id: ProjectId) => void = () => undefined,
  ): RouteHandler =>
  async call => {
    const id = projectId(call.params.get('id'));
    const body = await parseBody(call.request, CloneRepoRequestSchema);
    const project = await registry.find(id);
    if (project === undefined) throw new ApiError(404, `no project ${id}`, 'not-found');
    const leaf = cloneFolderName(body.url);
    if (leaf === null) throw cloneRefused('That address does not name a repository to clone.');
    if (!isScannableRepoName(leaf))
      throw cloneRefused('That repository name is hidden or skipped by the project scanner.');
    const target = `${project.path === '/' ? '' : project.path}/${leaf}`;
    let decided: Promise<void> | undefined;
    const gate = (): Promise<void> => {
      decided ??= outsideHomeGate(call)();
      return decided;
    };
    const home = await scan.browser.home();
    if (belowHome(project.path, home) === undefined) await gate();
    if (!(await folders.mayName(target))) throw cloneRefused('That folder is one Ferretry keeps for itself.');
    if (project.git !== undefined)
      throw cloneRefused(
        'This project is itself a repository, so a clone inside it would not be listed. Clone beside it.',
      );
    const policy = await folderPolicy(scan.browser, home, gate);
    const verdict = async (real: string) => {
      if (real !== project.path && real !== target) return 'outside' as const;
      const look = await policy.look(real);
      return look.complete ? look.verdict : ('private' as const);
    };
    if ((await scan.browser.leaf(project.path)) !== 'present')
      throw cloneRefused('The project folder changed. Choose it again.');
    const parent = await scan.browser.open(project.path, verdict);
    if (!parent.ok) throw cloneRefused('The project folder changed or is not allowed. Choose it again.');
    try {
      if ((await parent.folder.lookup('.git')) !== 'missing')
        throw cloneRefused(
          'This project is itself a repository, so a clone inside it would not be listed. Clone beside it.',
        );
      if ((await parent.folder.lookup(leaf)) !== 'missing')
        throw cloneRefused(`${leaf} already exists in this project.`);
    } finally {
      await parent.folder.close();
    }
    try {
      await folders.gitCloneInto(body.url, project.path, leaf, verdict);
    } catch (failure) {
      if (failure instanceof ApiError) throw failure;
      throw cloneRefused('git clone failed');
    }
    return await keepScan(registry, scan, listChanged, project, gate, leaf);
  };
