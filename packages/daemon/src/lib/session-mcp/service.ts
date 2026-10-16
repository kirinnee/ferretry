/**
 * Adding an MCP server for one ferret, in either of its two scopes (`@ferretry/protocol` session-mcp).
 *
 * PROJECT: the repo's `.mcp.json`, at the root of the checkout the ferret runs in. A root is only ever a
 * folder this daemon already KNOWS — a registered project or a managed worktree — and the longest one
 * that contains the ferret's working directory wins, so a worktree inside a registered project writes
 * its own file rather than the project's. A folder outside every known root has no project scope, because
 * a write into a person's files is only ever made at a root the operator registered or Ferretry made.
 *
 * LOGIN: the fleet. The server becomes an MCP component and is appended to the profile the ferret's
 * runtime launches with — two reviewed changes staged and applied through the same
 * {@link FleetCatalogService} the Settings catalogue uses, under the caller's own governance, so
 * nothing here is a second way to change the fleet.
 *
 * Both scopes run {@link mcpServerRefusal} first, the same rule the form runs as a person types.
 */
import { posix } from 'node:path';
import {
  type FleetComponentInput,
  type FleetLayeredProfileView,
  type FleetRuntimeView,
  mcpServerRefusal,
  SESSION_MCP_PROJECT_FILE,
  type SessionMcpAdded,
  type SessionMcpAddRequest,
  type SessionMcpDiffLine,
  type SessionMcpListing,
  type SessionMcpPreview,
  type SessionMcpPreviewRequest,
  type SessionMcpScope,
  type SessionMcpServer,
  type SessionView,
} from '@ferretry/protocol';
import type { CallerGovernance } from '../api/capability.ts';
import type { FleetCatalogService, FreshStepUpContext } from '../fleet/catalog-service.ts';
import {
  hasProjectServer,
  lineDiff,
  type McpProjectDocument,
  McpProjectFileError,
  parseMcpProjectFile,
  projectServers,
  renderMcpProjectFile,
  withProjectServer,
} from './project-file.ts';

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** A project file as it is on disk now: its text and the SHA-256 of its bytes, both null when absent. */
export interface McpProjectFileReading {
  readonly text: string | null;
  readonly etag: string | null;
}

/** The file changed between the read a person approved and the write. */
export class McpProjectFileChanged extends Error {
  constructor() {
    super('.mcp.json changed since the preview. Review the new diff, then add the server again.');
    this.name = 'McpProjectFileChanged';
  }
}

/**
 * The one project file, by absolute path. Both calls refuse a path that is a symbolic link or not a
 * regular file with an {@link McpProjectFileError}: a link could point anywhere, and the write would
 * land wherever it pointed.
 */
export interface McpProjectFiles {
  read(path: string): Promise<McpProjectFileReading>;
  /**
   * Replace the file with `text` only while it still reads as `expected` (null: still absent), keeping
   * its mode. Throws {@link McpProjectFileChanged} otherwise. Answers the new etag.
   */
  replace(path: string, text: string, expected: string | null): Promise<string>;
}

export interface SessionMcpServiceDeps {
  readonly sessions: {
    get(sessionId: string): Promise<SessionView | undefined>;
    list(): Promise<readonly SessionView[]>;
  };
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly files: McpProjectFiles;
  readonly fleet: Pick<FleetCatalogService, 'runtimes' | 'profiles' | 'components' | 'propose' | 'apply'>;
}

/** Every refusal, with the HTTP status and code the mount answers it with. */
export class SessionMcpRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionMcpRefusal';
  }
}

/** The roots a project write may use, read fresh per request so a project registered a moment ago counts. */
export const knownProjectRoots =
  (
    catalogs: { projects(): Promise<readonly { readonly path: string }[]> },
    worktrees: {
      list(): Promise<{ readonly worktrees: readonly { readonly path: string; readonly removedAt?: string }[] }>;
    },
  ) =>
  async (): Promise<readonly string[]> => {
    const [projects, managed] = await Promise.all([catalogs.projects(), worktrees.list()]);
    return [
      ...projects.map(project => project.path),
      ...managed.worktrees.filter(worktree => worktree.removedAt === undefined).map(worktree => worktree.path),
    ];
  };

const CODEX_PROJECT =
  'Codex does not read .mcp.json, so a project server would never reach this ferret. Add it to This login instead.';

const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** The longest root that is `cwd` or contains it, lexically. */
export const projectRootFor = (cwd: string, roots: readonly string[]): string | undefined => {
  const target = withoutTrailingSlash(cwd);
  return roots
    .map(withoutTrailingSlash)
    .filter(root => target === root || target.startsWith(root === '/' ? '/' : `${root}/`))
    .sort((left, right) => right.length - left.length)[0];
};

type ProjectTarget = { readonly path: string } | { readonly unavailable: string };

interface ProjectState {
  readonly path: string;
  readonly reading: McpProjectFileReading;
  readonly document: McpProjectDocument;
}

interface LoginTarget {
  readonly runtime: FleetRuntimeView;
  readonly profile: FleetLayeredProfileView;
  readonly replaces: boolean;
}

/** Whether a session's `config.agent` names this runtime, by any of the three names it is known by. */
const runsAs = (runtime: FleetRuntimeView, agent: string): boolean =>
  runtime.wrapper === agent || runtime.name === agent || runtime.id === agent;

export class SessionMcpService {
  constructor(private readonly deps: SessionMcpServiceDeps) {}

  /** `GET /v1/sessions/:id/mcp`: the project file's servers, or why there is no project scope here. */
  async list(sessionId: string): Promise<SessionMcpListing> {
    const target = await this.#projectTarget(await this.#session(sessionId));
    if ('unavailable' in target) return { project: null, projectUnavailable: target.unavailable };
    try {
      const reading = await this.deps.files.read(target.path);
      const servers = projectServers(parseMcpProjectFile(reading.text));
      return { project: { path: target.path, etag: reading.etag, servers } };
    } catch (error) {
      if (error instanceof McpProjectFileError) return { project: null, projectUnavailable: error.message };
      throw error;
    }
  }

  /** What adding `request` to the project file would change. Writes nothing. */
  async previewProject(sessionId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview> {
    const session = await this.#session(sessionId);
    refuseServer('project', request.server);
    const state = await this.#projectState(session);
    return {
      scope: 'project',
      path: state.path,
      etag: state.reading.etag,
      replaces: hasProjectServer(state.document, request.name),
      diff: lineDiffOf(state, request),
    };
  }

  /** Write exactly the previewed change, or refuse because the file moved. */
  async addProject(sessionId: string, request: SessionMcpAddRequest): Promise<SessionMcpAdded> {
    const session = await this.#session(sessionId);
    refuseServer('project', request.server);
    const expected = request.etag;
    if (expected === undefined)
      throw new SessionMcpRefusal(
        400,
        'mcp_etag_required',
        'Preview the change first: a project add carries the etag its preview answered with.',
      );
    const state = await this.#projectState(session);
    if (state.reading.etag !== expected)
      throw new SessionMcpRefusal(409, 'mcp_file_changed', new McpProjectFileChanged().message);
    const text = renderMcpProjectFile(withProjectServer(state.document, request.name, request.server));
    try {
      const etag = await this.deps.files.replace(state.path, text, expected);
      return { scope: 'project', name: request.name, path: state.path, etag };
    } catch (error) {
      throw projectRefusal(error);
    }
  }

  /**
   * Which runtime and profile a login add would change, and how many ferrets that reaches: EVERY
   * session this daemon knows that runs as that runtime, ended ones included, because each of them
   * picks the server up the next time it starts.
   */
  async previewLogin(sessionId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview> {
    const session = await this.#session(sessionId);
    refuseServer('login', request.server);
    const target = await this.#loginTarget(session, request.name);
    const sessions = await this.deps.sessions.list();
    return {
      scope: 'login',
      runtime: target.runtime.name,
      profile: target.profile.name,
      replaces: target.replaces,
      ferrets: sessions.filter(view => runsAs(target.runtime, view.config.agent)).length,
    };
  }

  /**
   * The component, then the profile: two reviewed changes, each applied under the caller's governance.
   * The profile change is skipped when the profile already names the component. If the second is
   * refused the component exists and is not in the profile yet; adding again repeats both halves.
   */
  async addLogin(
    sessionId: string,
    request: SessionMcpPreviewRequest,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<SessionMcpAdded> {
    const session = await this.#session(sessionId);
    refuseServer('login', request.server);
    const { runtime, profile, replaces } = await this.#loginTarget(session, request.name);
    const component = await this.deps.fleet.propose({
      kind: 'component.put',
      name: request.name,
      component: componentInput(request.server),
      create: !replaces,
    });
    await this.deps.fleet.apply(component.id, governance, freshStepUp);
    const reference = `mcp/${request.name}`;
    if (!profile.layers.includes(reference)) {
      const layered = await this.deps.fleet.propose({
        kind: 'profile.put',
        name: profile.name,
        layers: [...profile.layers, reference],
        create: false,
      });
      await this.deps.fleet.apply(layered.id, governance, freshStepUp);
    }
    return { scope: 'login', name: request.name, runtime: runtime.name, profile: profile.name };
  }

  async #session(sessionId: string): Promise<SessionView> {
    const session = await this.deps.sessions.get(sessionId);
    if (session === undefined) throw new SessionMcpRefusal(404, 'not-found', `no session ${sessionId}`);
    return session;
  }

  async #projectTarget(session: SessionView): Promise<ProjectTarget> {
    if (session.config.harness === 'codex') return { unavailable: CODEX_PROJECT };
    const root = projectRootFor(session.config.cwd, await this.deps.projectRoots());
    if (root === undefined)
      return {
        unavailable: `This ferret's folder, ${session.config.cwd}, is not inside a registered project or a Ferretry worktree, so there is no project file to write. Register the project, or add the server to This login.`,
      };
    return { path: posix.join(root, SESSION_MCP_PROJECT_FILE) };
  }

  async #projectState(session: SessionView): Promise<ProjectState> {
    const target = await this.#projectTarget(session);
    if ('unavailable' in target) throw new SessionMcpRefusal(409, 'mcp_project_unavailable', target.unavailable);
    try {
      const reading = await this.deps.files.read(target.path);
      return { path: target.path, reading, document: parseMcpProjectFile(reading.text) };
    } catch (error) {
      throw projectRefusal(error);
    }
  }

  async #loginTarget(session: SessionView, name: string): Promise<LoginTarget> {
    const agent = session.config.agent;
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(candidate => runsAs(candidate, agent));
    if (runtime === undefined)
      throw new SessionMcpRefusal(
        409,
        'mcp_runtime_unknown',
        `${agent} is not a runtime in this machine's fleet setup, so there is no login to add the server to. Add it to This project instead.`,
      );
    const profile = (await this.deps.fleet.profiles()).profiles.find(candidate => candidate.name === runtime.profile);
    if (profile === undefined)
      throw new SessionMcpRefusal(
        409,
        'mcp_runtime_unknown',
        `${runtime.name} launches with the profile ${runtime.profile}, which this machine does not have.`,
      );
    const mcp = (await this.deps.fleet.components()).kinds.find(group => group.kind === 'mcp');
    const replaces = (mcp?.components ?? []).some(component => component.name === name);
    return { runtime, profile, replaces };
  }
}

function refuseServer(scope: SessionMcpScope, server: SessionMcpServer): void {
  const refusal = mcpServerRefusal(scope, server);
  if (refusal !== null) throw new SessionMcpRefusal(400, 'mcp_server_refused', refusal);
}

/** A file this daemon will not read or rewrite, or one that moved, in the HTTP vocabulary. */
function projectRefusal(error: unknown): unknown {
  if (error instanceof McpProjectFileChanged) return new SessionMcpRefusal(409, 'mcp_file_changed', error.message);
  if (error instanceof McpProjectFileError) return new SessionMcpRefusal(409, 'mcp_file_unreadable', error.message);
  return error;
}

function lineDiffOf(state: ProjectState, request: SessionMcpPreviewRequest): SessionMcpDiffLine[] {
  const after = renderMcpProjectFile(withProjectServer(state.document, request.name, request.server));
  return lineDiff(state.reading.text ?? '', after);
}

/** One server as a fleet MCP component spells it. */
function componentInput(server: SessionMcpServer): FleetComponentInput {
  if (server.transport === 'url')
    return { kind: 'mcp', url: server.url, ...(server.oauth ? { auth: 'oauth' as const } : {}) };
  return {
    kind: 'mcp',
    command: server.command,
    args: [...server.args],
    ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
  };
}
