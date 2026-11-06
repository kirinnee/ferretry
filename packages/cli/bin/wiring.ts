/**
 * The wiring every entry shares: the program skeleton, where the daemon is, which credential this
 * invocation presents, and the one lazy client every command group talks through.
 *
 * WHY THIS IS ITS OWN MODULE. `bin/fy.ts` routes a long-lived command (`fy wait`, `fy mcp serve`) to a
 * slice that loads only what that command runs, and every other command to the full program
 * (`bin/program.ts`). Both must reach the daemon in exactly the same way — the same address rule, the
 * same credential choice, the same restart patience — so that one way lives here, and neither the
 * slices nor the program spell their own. Anything imported here is loaded by every slice, so keep it
 * to what a connection needs: a heavy import here is paid by every waiting `fy`.
 */
import type {
  DaemonRestartPatience,
  IFyApiClient,
  IFyHttpTransport,
  AnalyticsResponse,
  SessionView,
} from '@ferretry/protocol';
import { DAEMON_RESTART_PATIENCE_MS } from '@ferretry/protocol/daemon-restart';
import { FetchHttpTransport, FyApiClient } from '@ferretry/protocol/client';
import { resolveUserHome } from '@ferretry/fleet/user-home';
import { Command } from 'commander';
import type { z } from 'zod';
// The root manifest is the single source for the PRODUCT name; this package's own name is the BINARY.
import root from '../../../package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { SessionCredentialGateway } from '../src/adapters/agent-tools/session-credential-gateway';
import { readDaemonToken } from '../src/adapters/daemon/api-token';
import { readDaemonConfigDocument } from '../src/adapters/daemon/daemon-config-file';
import {
  assertOwnLoopbackListener,
  type LoopbackListenerGuardPorts,
} from '../src/adapters/daemon/loopback-listener-guard';
import { FileDaemonRestartMarker, restartMarkerPath } from '../src/adapters/daemon/restart-marker';
import {
  DaemonInstanceCache,
  HealthInstanceReader,
  RevisitedConnection,
  SessionBearerTransport,
} from '../src/adapters/daemon/session-credential';
import { environmentSessionId } from '../src/adapters/tasks/task-environment';
import { ConsoleIo, type ICliIo } from '../src/adapters/terminal/console-io';
import type { AgentToolsGateways } from '../src/lib/agent-tools/client';
import { isLocalDaemonUrl, resolveDaemonUrl } from '../src/lib/daemon/address';
import {
  AS_OWNER_NOTE,
  type CredentialPlan,
  credentialPlan,
  presentsSessionBearer,
} from '../src/lib/daemon/credential';
import { resolveDaemonStateHome } from '../src/lib/daemon/layout';
import { assertSemver } from '../src/lib/version';

// Identity is single-sourced from package.json: the bin key names the binary, version feeds --version.
export const BINARY_NAME = Object.keys(pkg.bin)[0] ?? pkg.name;
export const PRODUCT_NAME = root.name;
const DESCRIPTION = 'Command-line client for the per-host agent daemon';

/**
 * What a connection needs from the invocation: where it is, whose home, which environment, and where a
 * diagnostic goes. `CliWorld` (bin/program.ts) satisfies it structurally; a slice builds only this.
 */
export interface ConnectionWorld {
  readonly io: ICliIo;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly environment: Record<string, string | undefined>;
}

/**
 * `fy --as-owner …`: inside a ferret's pane, use the host's admin token instead of the ferret's own
 * credential — for a person who attached to that pane. It works only where `api-token` is readable, so it
 * is a convenience, not a permission: a ferret that passes it has made the same visible act as one that
 * reads the file (docs/secrets.md § "What a ferret's `fy` presents").
 */
const AS_OWNER_FLAG = '--as-owner';
const AS_OWNER_HELP = "inside a ferret's pane, act with the owner's admin token instead of the ferret's own credential";

/** Scaffold: the commander program skeleton (identity + `--help`/`--version`), domain-free. */
export function createProgram(): Command {
  return new Command()
    .name(BINARY_NAME)
    .description(DESCRIPTION)
    .version(assertSemver(pkg.version), '-v, --version', 'print the CLI version')
    .option(AS_OWNER_FLAG, AS_OWNER_HELP)
    .showHelpAfterError();
}

/**
 * Where this invocation should look for the daemon.
 *
 * READ EACH TIME rather than resolved once per invocation, because the answer can change while a
 * single command is running: `daemon start` spawns a daemon that decides its own port and records it,
 * and the poll that follows must see the record it wrote. The document read is one small local file.
 */
export async function daemonBaseUrl(
  environment: Record<string, string | undefined>,
  stateHome: string,
): Promise<string> {
  const explicitUrl = environment.FY_URL?.trim() ?? '';
  // An operator who pinned an address has said where to look; nothing local may override that, and
  // this installation may not even have a state home to consult.
  if (explicitUrl !== '') return explicitUrl;
  return resolveDaemonUrl('', await readDaemonConfigDocument(`${stateHome}/config/daemon.json`));
}

/**
 * How the CLI finds the daemon, and which credential it may use to talk to it.
 *
 * WHERE: an explicit `FY_URL` first, then the address the local daemon recorded for itself, then the
 * well-known default. The middle step is what stops this client reporting a healthy daemon
 * unreachable — a daemon whose preferred port was taken binds another and writes the choice down,
 * and a client that assumed the default would never look at it.
 *
 * WHICH CREDENTIAL: decided from the URL, never from whether one was given. Testing "is `FY_URL`
 * set" classified a daemon on this very machine as remote and demanded `FY_TOKEN` for it, while the
 * owner-only token file that is exactly the right credential sat unread. A loopback daemon uses the
 * minted file; a genuinely remote one still must carry its own token, because a local admin
 * credential must never leave this machine.
 *
 * THE URL IT DECIDES FROM IS THE BIND. What a daemon advertises to other devices is a different
 * fact, and reading it here made an operator who advertised a routed address — on the advice of the
 * pairing screen — unable to run the pairing command at all. Widening the loopback test to admit
 * that address would have been the same defect wearing a security hole: the document naming it is
 * writable by anything that can write the state home.
 *
 * A FERRET PRESENTS ITS OWN CREDENTIAL (`lib/daemon/credential.ts`, docs/secrets.md § "What a ferret's
 * `fy` presents"): with a `fys_` value in its environment and no `FY_TOKEN`, the daemon's public health
 * route is asked once, and a daemon that offers `session.credential.1` gets that bearer and nothing else —
 * `api-token` is not opened, and every refusal is the answer. Only a daemon that does not offer it, now or
 * on the one re-read a `401` earns, is answered with the admin token as before.
 */
export async function daemonConnection(
  environment: Record<string, string | undefined>,
  homeDirectory: string,
  /** Whose program holds the port; the host's own socket tables unless a test says otherwise. */
  listeners?: LoopbackListenerGuardPorts,
  options: DaemonCredentialOptions = {},
): Promise<{
  baseUrl: string;
  token: string;
  version: string;
  /** Which credential `token` is; `session` connections must use {@link transport}. */
  credential: CredentialPlan['kind'];
  /** Present for a session bearer: the one place a `401` may re-read health and fall back. */
  transport?: IFyHttpTransport;
  /** Present when a ferret's credential was set aside because this daemon did not offer it. */
  revisit?: { baseUrl: string; pid: number | undefined };
}> {
  const plan = credentialPlan(environment, { asOwner: options.asOwner === true });
  if (plan.kind === 'admin' && plan.why === 'as-owner') options.note?.(AS_OWNER_NOTE);
  const stateHome = resolveDaemonStateHome(homeDirectory, environment.FY_HOME, PRODUCT_NAME);
  const baseUrl = await daemonBaseUrl(environment, stateHome);
  const version = assertSemver(pkg.version);
  if (plan.kind === 'explicit') return { baseUrl, token: plan.token, version, credential: 'explicit' };
  if (!isLocalDaemonUrl(baseUrl)) {
    throw new Error(
      `FY_TOKEN is required when the daemon is not on this machine (${baseUrl}); local daemon credentials are never sent remotely. Set FY_TOKEN to that daemon's own token.`,
    );
  }
  const readAdminToken = options.readAdminToken ?? readDaemonToken;
  // The local token goes only to a listener this user owns: on a shared host a stopped daemon's port is
  // anybody's to bind, and the admin token is the whole machine (`lib/daemon/listener-owner.ts`).
  const adminToken = async (): Promise<string> => {
    await assertOwnLoopbackListener(baseUrl, 'the daemon admin token', listeners);
    return await readAdminToken(`${stateHome}/api-token`);
  };
  if (plan.kind === 'session') {
    // The same rule for the ferret's own credential: it is the ferret's whole authority.
    await assertOwnLoopbackListener(baseUrl, 'the session credential', listeners);
    const instances = options.instances ?? defaultInstances();
    const facts = await instances.facts(baseUrl);
    if (presentsSessionBearer(facts)) {
      const transport = new SessionBearerTransport(options.transport ?? new FetchHttpTransport(), plan.bearer, {
        reread: async () => await instances.refresh(baseUrl),
        adminToken,
        ...(options.note === undefined ? {} : { note: options.note }),
      });
      return { baseUrl, token: plan.bearer, version, credential: 'session', transport };
    }
    return { baseUrl, token: await adminToken(), version, credential: 'admin', revisit: { baseUrl, pid: facts.pid } };
  }
  return { baseUrl, token: await adminToken(), version, credential: 'admin' };
}

/** How {@link daemonConnection} chooses a credential; the defaults are the real host's. */
export interface DaemonCredentialOptions {
  /** `fy --as-owner`: skip the ferret's own credential and use the admin token, where it is readable. */
  readonly asOwner?: boolean;
  /** What each daemon said in this process. Shared by every connection one invocation opens. */
  readonly instances?: DaemonInstanceCache;
  /** Opens `<state>/api-token`; a test passes a spy to prove a ferret's `fy` never does. */
  readonly readAdminToken?: (path: string) => Promise<string>;
  /** The wire under a session bearer's transport; `fetch` unless a test says otherwise. */
  readonly transport?: IFyHttpTransport;
  /** Where the one-line fallback notice goes (stderr: stdout is a command's answer and MCP's protocol). */
  readonly note?: (line: string) => void;
}

/** A health cache for one invocation, reading without a credential and without waiting out a restart. */
export function defaultInstances(restartPatience?: DaemonRestartPatience): DaemonInstanceCache {
  return new DaemonInstanceCache(
    new HealthInstanceReader(baseUrl =>
      FyApiClient.connect({
        baseUrl,
        token: UNAUTHENTICATED_PROBE_TOKEN,
        version: assertSemver(pkg.version),
        ...(restartPatience === undefined ? {} : { restartPatience }),
      }),
    ),
  );
}

/**
 * The one connection to the daemon, opened on first use and shared by every command group.
 *
 * Deferring the connection is what keeps `--help`, `--version` and a mistyped command working on a
 * host with no daemon and no token: nothing reaches the network until a command actually asks.
 */
export function lazyDaemonConnection(
  environment: Record<string, string | undefined>,
  homeDirectory: string,
  restartPatience?: DaemonRestartPatience,
  credentials: () => DaemonCredentialOptions = () => ({}),
): () => Promise<IFyApiClient> {
  // A ferret's process left on the admin token asks again later (`RevisitedConnection`): `fy mcp serve` lives
  // as long as its pane, and must pick its own credential up once the daemon offers it.
  const connection = new RevisitedConnection<FyApiClient>(
    async () => {
      const { baseUrl, token, version, transport, revisit } = await daemonConnection(
        environment,
        homeDirectory,
        undefined,
        credentials(),
      );
      const client = await FyApiClient.connect({
        baseUrl,
        token,
        version,
        ...(transport === undefined ? {} : { transport }),
        ...(restartPatience === undefined ? {} : { restartPatience }),
      });
      return revisit === undefined ? { client } : { client, revisit };
    },
    async baseUrl => await (credentials().instances ?? defaultInstances()).refresh(baseUrl),
    () => Date.now(),
  );
  return async (): Promise<FyApiClient> => await connection.client();
}

/**
 * Waiting out a daemon restart (`daemon-restart.ts`, docs/updating.md § Ferrets keep running): one per
 * process, shared by every client this invocation opens, so the note is said once.
 *
 * WHO WAITS. A ferret always does — it only exists because a daemon ran it, so a daemon that refuses
 * it is restarting, or crashed and is being restarted by its service manager. A person waits only
 * while `fy daemon restart` (or an update) has left the restart marker, so `fy list` against a daemon
 * somebody stopped still fails at once instead of a minute later.
 */
export function restartPatience(world: ConnectionWorld, ownSessionId: string | undefined): DaemonRestartPatience {
  const stateHome = resolveDaemonStateHome(world.homeDirectory, world.environment.FY_HOME, PRODUCT_NAME);
  const marker = new FileDaemonRestartMarker(restartMarkerPath(stateHome));
  let said = false;
  return {
    expected: async () => ownSessionId !== undefined || (await marker.active(Date.now())),
    waiting: () => {
      if (said) return;
      said = true;
      // On stderr, never stdout: stdout is a command's answer, and the MCP server's protocol.
      world.io.diagnostic(
        `${BINARY_NAME}: daemon restarting, retrying for up to ${String(DAEMON_RESTART_PATIENCE_MS / 1_000)}s…`,
      );
    },
  };
}

/**
 * The slice of the daemon SDK the shared client exposes. Widening it is additive — a group that
 * needs one more call adds it here and no existing group changes — and every member stays deferred.
 */
export type SharedDaemonClient = Pick<
  IFyApiClient,
  | 'request'
  | 'analytics'
  | 'list'
  | 'get'
  | 'stop'
  | 'pinSession'
  | 'unpinSession'
  | 'migrate'
  | 'conversionPreview'
  | 'restart'
  | 'restartStatus'
  | 'cancelRestarts'
  | 'scratchPlan'
  | 'scratchSweep'
  | 'harnessUpdate'
  | 'startHarnessUpdate'
  | 'previewCatalogInstall'
  | 'applyCatalogInstall'
  | 'catalogInstalls'
  | 'removeCatalogInstall'
  | 'previewLocalSkillInstall'
  | 'applyLocalSkillInstall'
  | 'localSkillInstalls'
  | 'removeLocalSkillInstall'
  | 'snapshot'
  | 'logs'
  | 'events'
  | 'history'
  | 'attachTarget'
  | 'stream'
>;

/** The deferred connection as the client object every command group is wired with. */
export function lazyDaemonClient(client: () => Promise<IFyApiClient>): SharedDaemonClient {
  return {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      const ready = await client();
      return timeoutMs === undefined ? ready.request(path, schema, init) : ready.request(path, schema, init, timeoutMs);
    },
    analytics: async (query?: string): Promise<AnalyticsResponse> => (await client()).analytics(query),
    harnessUpdate: async () => (await client()).harnessUpdate(),
    startHarnessUpdate: async request => (await client()).startHarnessUpdate(request),
    previewCatalogInstall: async (scope, request) => (await client()).previewCatalogInstall(scope, request),
    applyCatalogInstall: async (scope, request) => (await client()).applyCatalogInstall(scope, request),
    catalogInstalls: async () => (await client()).catalogInstalls(),
    removeCatalogInstall: async (scope, installId) => (await client()).removeCatalogInstall(scope, installId),
    previewLocalSkillInstall: async (scope, request) => (await client()).previewLocalSkillInstall(scope, request),
    applyLocalSkillInstall: async (scope, request) => (await client()).applyLocalSkillInstall(scope, request),
    localSkillInstalls: async () => (await client()).localSkillInstalls(),
    removeLocalSkillInstall: async (scope, installId) => (await client()).removeLocalSkillInstall(scope, installId),
    list: async (): Promise<readonly SessionView[]> => (await client()).list(),
    get: async (id: string, signal?: AbortSignal): Promise<SessionView> => (await client()).get(id, signal),
    stop: async (id: string, reason?: string): Promise<SessionView> => (await client()).stop(id, reason),
    pinSession: async (id: string) => (await client()).pinSession(id),
    unpinSession: async (id: string) => (await client()).unpinSession(id),
    migrate: async (id, agent, model, allowContextDowngrade, requestId, forceInflight, conversation) =>
      (await client()).migrate(id, agent, model, allowContextDowngrade, requestId, forceInflight, conversation),
    conversionPreview: async (id, agent, model) => (await client()).conversionPreview(id, agent, model),
    restart: async (request, requestId) => (await client()).restart(request, requestId),
    restartStatus: async () => (await client()).restartStatus(),
    cancelRestarts: async () => (await client()).cancelRestarts(),
    scratchPlan: async (limit?: number) => (await client()).scratchPlan(limit),
    scratchSweep: async (force?: boolean) => (await client()).scratchSweep(force),
    snapshot: async (id: string) => (await client()).snapshot(id),
    logs: async (id: string, turn?: number) => (await client()).logs(id, turn),
    events: async (id: string, after?: number, limit?: number, signal?: AbortSignal) =>
      (await client()).events(id, after, limit, signal),
    history: async (id: string, after?: number, limit?: number) => (await client()).history(id, after, limit),
    attachTarget: async (id: string) => (await client()).attachTarget(id),
    stream: async (sessionId, after, onEvent, signal, onIdle) =>
      (await client()).stream(sessionId, after, onEvent, signal, onIdle),
  };
}

/**
 * `/v1/health` is a public route, but the typed client insists on a non-empty bearer token. The daemon
 * commands must be able to report whether the daemon is up BEFORE a token exists — that is exactly
 * the state a fresh `daemon install` leaves the host in — so an unauthenticated probe sends this
 * placeholder and the daemon ignores it.
 */
export const UNAUTHENTICATED_PROBE_TOKEN = 'unauthenticated';

/**
 * The agent tools' two ways to the daemon. A person's is the shared client. An agent's carries its
 * session credential ONLY — it never reads the host's admin token — and talks only to this machine.
 */
export function agentToolsGateways(
  world: ConnectionWorld,
  client: SharedDaemonClient,
  patience: DaemonRestartPatience,
): AgentToolsGateways {
  const environment = world.environment;
  return {
    person: client,
    agent: new SessionCredentialGateway(
      async () =>
        await daemonBaseUrl(
          environment,
          resolveDaemonStateHome(world.homeDirectory, environment.FY_HOME, PRODUCT_NAME),
        ),
      fetch,
      { patience, nowMs: () => Date.now(), sleep: milliseconds => Bun.sleep(milliseconds) },
    ),
  };
}

/** What every command group of one invocation shares: the lazy client and how it was chosen. */
export interface DaemonWiring {
  readonly client: SharedDaemonClient;
  readonly ownSessionId: string | undefined;
  /** How every client in this invocation waits out a daemon restart. */
  readonly restartPatience: DaemonRestartPatience;
  /** Which credential every client in this invocation presents (read after the arguments are parsed). */
  readonly credentials: () => DaemonCredentialOptions;
}

/**
 * The one way an invocation reaches its daemon, for the full program and every slice alike.
 *
 * Nothing here touches the network or a file: the client is lazy, so `--help` and a mistyped command
 * work on a host with no daemon and no token.
 */
export function wireDaemon(program: Command, world: ConnectionWorld): DaemonWiring {
  // The injected environment, never the ambient one: an in-process journey must not inherit FY_*.
  const environment = world.environment;
  // One reading of "which session am I", shared by every group: blank is absent, not an empty id.
  const ownSessionId = environmentSessionId(environment);
  const patience = restartPatience(world, ownSessionId);
  // One health read per daemon for the whole invocation, waiting out a restart as a ferret's `fy` does.
  const instances = defaultInstances(patience);
  // Each note once per invocation, however many connections it opens.
  const noted = new Set<string>();
  const credentials = (): DaemonCredentialOptions => ({
    asOwner: program.opts<{ asOwner?: boolean }>().asOwner === true,
    instances,
    note: line => {
      if (noted.has(line)) return;
      noted.add(line);
      world.io.diagnostic(`${BINARY_NAME}: ${line}`);
    },
  });
  return {
    client: lazyDaemonClient(lazyDaemonConnection(environment, world.homeDirectory, patience, credentials)),
    ownSessionId,
    restartPatience: patience,
    credentials,
  };
}

/** One slice's group on the program: what `bin/reads-group.ts` and `bin/mcp-group.ts` each provide. */
export type SliceRegistrar = (program: Command, world: ConnectionWorld, wiring: DaemonWiring) => void;

/**
 * Run one slice: the same skeleton, the same daemon wiring and the same last-resort guard as the full
 * program's `execute()` (bin/program.ts), with one command group on it instead of all of them.
 *
 * The world is the slice's own and deliberately small — no spinner, prompt or progress line, because no
 * sliced command shows one — so loading a slice never loads `ora` or `inquirer`.
 */
export async function executeSlice(argv: string[], register: SliceRegistrar): Promise<void> {
  const program = createProgram();
  const io = new ConsoleIo();
  try {
    const world: ConnectionWorld = {
      io,
      cwd: process.cwd(),
      homeDirectory: resolveUserHome(),
      environment: process.env,
    };
    register(program, world, wireDaemon(program, world));
    await program.parseAsync(argv);
  } catch (error) {
    io.error((error as Error).message);
    io.setExitCode(1);
  }
}
