/**
 * Adding an MCP server for one ferret, in either of its two scopes (the `session-mcp` wire in the contract).
 *
 * PROJECT: the repo's `.mcp.json`, at the root of the checkout the ferret runs in. A root is only ever a
 * folder this daemon already KNOWS — a registered project or a managed worktree — and the longest one
 * that contains the ferret's working directory wins, so a worktree inside a registered project writes
 * its own file rather than the project's. A folder outside every known root has no project scope, because
 * a write into a person's files is only ever made at a root the operator registered or Ferretry made.
 *
 * LOGIN: the runtime. The server becomes an MCP item (`config/mcp/<name>.yaml`) and is appended to the profile the
 * ferret's runtime launches with — two reviewed changes written through {@link McpLoginTarget}, which is Gate's config
 * route under the caller's own standing, so nothing here is a second way to change the setup.
 *
 * Both scopes run {@link mcpServerRefusal} first, the same rule the form runs as a person types.
 */
import { posix } from 'node:path';
import {
  type McpItem,
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
} from '../../../contract/index.ts';
import type { McpFerretView } from '../inventory/service.ts';
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
  read(ferret: string, path: string): Promise<McpProjectFileReading>;
  /**
   * Replace the file with `text` only while it still reads as `expected` (null: still absent), keeping
   * its mode. Throws {@link McpProjectFileChanged} otherwise. Answers the new etag.
   */
  replace(ferret: string, path: string, text: string, expected: string | null): Promise<string>;
}

/** A runtime as a login add needs it: its name and the profile it launches with. */
export interface McpLoginRuntime {
  readonly name: string;
  readonly profile: string;
}

/** A profile as a login add needs it: its name, the layers it names (`mcp/<name>` references among them) and its etag. */
export interface McpLoginProfile {
  readonly name: string;
  readonly layers: readonly string[];
  /** The profile file's etag as read now; the layer write is refused as a conflict when the file moved since. */
  readonly etag: string;
}

/**
 * The runtime half of a login add: the two reviewed changes. Reads come from Runtimes; `putItem` writes this plugin's
 * own item file and `layerProfile` asks Runtimes to add ONE `mcp/<name>` layer to one profile, under the caller's own
 * standing (`governance`, which Runtimes judges: an unknown or insufficient standing is refused with nothing written).
 */
export interface McpLoginTarget {
  runtime(name: string): Promise<McpLoginRuntime | undefined>;
  profile(name: string): Promise<McpLoginProfile | undefined>;
  hasItem(name: string): Promise<boolean>;
  /** Writes the item (`create`: it must not exist yet) and answers the etag of the file as written. */
  putItem(name: string, item: McpItem, create: boolean): Promise<string>;
  /** Takes back an item this add created, only while the file is still the one written (`etag`); false when it stays. */
  removeItem(name: string, etag: string): Promise<boolean>;
  layerProfile(profile: McpLoginProfile, layer: string, governance: unknown): Promise<void>;
}

export interface SessionMcpServiceDeps {
  readonly ferrets: {
    get(ferretId: string): Promise<McpFerretView | undefined>;
    list(): Promise<readonly McpFerretView[]>;
  };
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly files: McpProjectFiles;
  readonly login: McpLoginTarget;
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

const CODEX_PROJECT =
  'Codex does not read .mcp.json, so a project server would never reach this ferret. Add it to This login instead.';

/** Runtimes' own sentence for a caller it cannot place; said here first so nothing is written for such a caller. */
const NO_STANDING = 'this daemon cannot say whether this caller may change the fleet';

const NOT_TAKEN_BACK = (name: string): string =>
  `The new server ${name} could not be taken back and is still in effect: remove it from the MCP servers if you do not want it.`;

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
  readonly runtime: McpLoginRuntime;
  readonly profile: McpLoginProfile;
  readonly replaces: boolean;
}

export class SessionMcpService {
  constructor(private readonly deps: SessionMcpServiceDeps) {}

  /** `GET /v1/ferrets/:id/mcp`: the project file's servers, or why there is no project scope here. */
  async list(sessionId: string): Promise<SessionMcpListing> {
    const session = await this.#session(sessionId);
    const target = await this.#projectTarget(session);
    if ('unavailable' in target) return { project: null, projectUnavailable: target.unavailable };
    try {
      const reading = await this.deps.files.read(session.id, target.path);
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
      const etag = await this.deps.files.replace(session.id, state.path, text, expected);
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
    const ferrets = await this.deps.ferrets.list();
    return {
      scope: 'login',
      runtime: target.runtime.name,
      profile: target.profile.name,
      replaces: target.replaces,
      ferrets: ferrets.filter(view => view.runtime === target.runtime.name).length,
    };
  }

  /**
   * The component, then the profile: two reviewed changes, each applied under the caller's governance.
   * A caller with no standing at all is refused BEFORE anything is written (as v4 did). The profile change is skipped
   * when the profile already names the component. If it is refused or conflicts, an item this add CREATED is taken
   * back, so a refused add leaves nothing in effect; an item it only REPLACED stays as written, and adding again
   * repeats both halves.
   */
  async addLogin(sessionId: string, request: SessionMcpPreviewRequest, governance?: unknown): Promise<SessionMcpAdded> {
    const session = await this.#session(sessionId);
    refuseServer('login', request.server);
    const { runtime, profile, replaces } = await this.#loginTarget(session, request.name);
    // Every read above writes nothing; from here on a caller with no standing writes nothing either.
    if (governance === undefined) throw new SessionMcpRefusal(409, 'mcp_profile_refused', NO_STANDING);
    const etag = await this.deps.login.putItem(request.name, itemInput(request.server), !replaces);
    const reference = `mcp/${request.name}`;
    if (!profile.layers.includes(reference)) {
      try {
        await this.deps.login.layerProfile(profile, reference, governance);
      } catch (error) {
        const taken = replaces || (await this.deps.login.removeItem(request.name, etag));
        throw taken || !(error instanceof SessionMcpRefusal)
          ? error
          : new SessionMcpRefusal(error.status, error.code, `${error.message} ${NOT_TAKEN_BACK(request.name)}`);
      }
    }
    return { scope: 'login', name: request.name, runtime: runtime.name, profile: profile.name };
  }

  async #session(sessionId: string): Promise<McpFerretView> {
    const ferret = await this.deps.ferrets.get(sessionId);
    if (ferret === undefined) throw new SessionMcpRefusal(404, 'not-found', `no ferret ${sessionId}`);
    return ferret;
  }

  async #projectTarget(session: McpFerretView): Promise<ProjectTarget> {
    if (session.harness === 'codex') return { unavailable: CODEX_PROJECT };
    const root = projectRootFor(session.folder, await this.deps.projectRoots());
    if (root === undefined)
      return {
        unavailable: `This ferret's folder, ${session.folder}, is not inside a registered project or a Ferretry worktree, so there is no project file to write. Register the project, or add the server to This login.`,
      };
    return { path: posix.join(root, SESSION_MCP_PROJECT_FILE) };
  }

  async #projectState(session: McpFerretView): Promise<ProjectState> {
    const target = await this.#projectTarget(session);
    if ('unavailable' in target) throw new SessionMcpRefusal(409, 'mcp_project_unavailable', target.unavailable);
    try {
      const reading = await this.deps.files.read(session.id, target.path);
      return { path: target.path, reading, document: parseMcpProjectFile(reading.text) };
    } catch (error) {
      throw projectRefusal(error);
    }
  }

  async #loginTarget(session: McpFerretView, name: string): Promise<LoginTarget> {
    const agent = session.runtime ?? '';
    const runtime = agent === '' ? undefined : await this.deps.login.runtime(agent);
    if (runtime === undefined)
      throw new SessionMcpRefusal(
        409,
        'mcp_runtime_unknown',
        `${agent} is not a runtime on this machine, so there is no login to add the server to. Add it to This project instead.`,
      );
    const profile = await this.deps.login.profile(runtime.profile);
    if (profile === undefined)
      throw new SessionMcpRefusal(
        409,
        'mcp_runtime_unknown',
        `${runtime.name} launches with the profile ${runtime.profile}, which this machine does not have.`,
      );
    const replaces = await this.deps.login.hasItem(name);
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

/** One server as an MCP item spells it. */
function itemInput(server: SessionMcpServer): McpItem {
  if (server.transport === 'url') return { url: server.url, ...(server.oauth ? { auth: 'oauth' as const } : {}) };
  return {
    command: server.command,
    args: [...server.args],
    ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
  };
}
