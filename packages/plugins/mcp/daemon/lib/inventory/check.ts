/**
 * Check one MCP server: reach it the way its harness would, open a session, list its tools, and say
 * plainly what happened (docs/mcp-scopes.md › Check).
 *
 * BOUNDED: one deadline for the whole exchange ({@link MCP_CHECK_TIMEOUT_MS}), a capped tool list, and
 * a command's process killed when the check ends however it ends.
 *
 * WHAT A CHECK WILL NOT RUN. A project's command that this ferret's harness has not been allowed to run
 * (not approved, or disabled) is not run by Ferretry either: a check is not a way around the question
 * the harness asks before it runs a repository's code. A web address is reached whatever its approval
 * — reaching it runs nothing here — and the result says the approval too.
 *
 * NO SECRET LEAVES. The environment and headers are filled exactly as the harness fills them (the
 * runtime's launch environment, a held sign-in's access token), handed to the probe, and dropped. Every
 * sentence a check answers passes through the secret redactor first, because a server's own error text
 * is the one thing here nobody controls.
 */
import {
  MCP_CHECK_TIMEOUT_MS,
  MCP_CHECK_TOOL_NAMES,
  type McpCheckResult,
  type McpTransport,
} from '../../../contract/index.ts';
/** Scrubs a secret out of a check's own words (the kernel's redaction window, bound in the half). */
interface TextRedactor {
  redact(text: string): Promise<string>;
}
import type { ChildEnvironment } from '@ferretry/kernel/contract';
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import { expandVariables } from './json-rpc.ts';
import {
  FERRETRY_TOOLS_SERVER,
  McpInventoryRefusal,
  type McpInventoryService,
  type ResolvedMcpServer,
} from './service.ts';

/** How a probe reaches a server: the exact process or request the harness would make. */
export type McpProbeSpec =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      /** Plain values, or a Vault handle when a `${secret:NAME}` is in it: the kernel opens that at exec time, so no value is here. */
      readonly env: Readonly<Record<string, string>> | ChildEnvironment;
      readonly cwd?: string;
    }
  | {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface McpProbeAnswer {
  readonly serverName?: string;
  readonly tools: readonly string[];
}

export type McpProbeFailureKind = 'unauthorized' | 'timeout' | 'unreachable' | 'protocol';

/** Why a probe got no session. The message is the adapter's own sentence; it never holds a header. */
export class McpProbeFailure extends Error {
  constructor(
    readonly kind: McpProbeFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'McpProbeFailure';
  }
}

/** The transports. The adapter owns the bytes; the deadline is the caller's. */
export interface McpProbe {
  probe(spec: McpProbeSpec, signal: AbortSignal): Promise<McpProbeAnswer>;
}

export interface McpCheckDeps {
  readonly inventory: Pick<McpInventoryService, 'resolve'>;
  readonly probe: McpProbe;
  /**
   * What a runtime's harness is launched with, resolved — its profile's secrets included — so a
   * component's `${VAR}` fills as it does in the agent. Never answered to anybody.
   */
  launchEnvironment(runtime: string | undefined): Promise<Readonly<Record<string, string>>>;
  /** The small inherited environment a command starts with (`PATH`, `HOME`, …) — never the daemon's tokens. */
  baseEnvironment(): Readonly<Record<string, string>>;
  /** A held access token for a sign-in subject at an address, renewed first when it is about to expire. */
  bearer(subject: string, url: string): Promise<string | undefined>;
  /**
   * The environment of a command whose values name secrets, as one handle for one child (the Vault resolves each
   * `${secret:NAME}`, the kernel opens it at exec time; use, never read). Absent: a secret reference cannot be
   * resolved here and the check says so rather than start the command with the literal text.
   */
  /**
   * A stdio command is about to be started by this check: its program is allowed (and only it) until the returned call
   * is made. The kernel refuses every program a manifest does not declare, so a check could not start anything
   * otherwise. Absent: nothing is allowed.
   */
  allowCommand?(command: string): () => void;
  sealEnvironment?(
    env: Readonly<Record<string, string>>,
  ): Promise<
    { readonly ok: true; readonly env: ChildEnvironment } | { readonly ok: false; readonly unknown: readonly string[] }
  >;
  readonly redactor: Pick<TextRedactor, 'redact'>;
  now(): number;
}

const NOT_RUN: Readonly<Record<'pending' | 'disabled', string>> = {
  pending:
    'Not approved in this project yet, so the ferret never starts it and neither does Ferretry. Approve it when the ferret asks (“New MCP server found”), then check again.',
  disabled:
    'Disabled in this project for this ferret, so it never starts. Remove it from disabledMcpjsonServers (or set enabled = true) to use it.',
};

/** The words for each failure. A server's own detail follows, redacted. */
const FAILURE_LEAD: Readonly<Record<McpProbeFailureKind, string>> = {
  unauthorized: 'It asks for a sign-in.',
  timeout: `No answer within ${MCP_CHECK_TIMEOUT_MS / 1000} seconds.`,
  unreachable: 'Could not reach it.',
  protocol: 'It answered, but not as an MCP server.',
};

/** A secret a check's command names that cannot be opened: the sentence names it, never a value. */
class SecretsNotAvailable extends Error {}

export class McpCheckService {
  constructor(private readonly deps: McpCheckDeps) {}

  async check(id: string, sessionId?: string): Promise<McpCheckResult> {
    const server = await this.deps.inventory.resolve(id, sessionId);
    const declaration = server.declaration;
    if (declaration === null)
      throw new McpInventoryRefusal(
        409,
        'mcp_check_builtin',
        `“${FERRETRY_TOOLS_SERVER}” is Ferretry’s own tools server: every ferret starts its own, so there is nothing to check from here.`,
      );
    const started = this.deps.now();
    const base = { id: server.id, name: declaration.name, transport: declaration.transport as McpTransport };
    const finish = (rest: Omit<McpCheckResult, 'id' | 'name' | 'transport' | 'elapsedMs' | 'checkedAt'>) => ({
      ...base,
      ...rest,
      elapsedMs: Math.max(0, Math.round(this.deps.now() - started)),
      checkedAt: new Date(this.deps.now()).toISOString(),
    });

    const blocked = blockedBy(server);
    if (declaration.transport === 'stdio' && blocked !== undefined)
      return finish({ outcome: 'not-approved', message: NOT_RUN[blocked] });

    const missing = new Set<string>();
    let spec: McpProbeSpec;
    try {
      spec = await this.#spec(server, missing);
    } catch (error) {
      if (!(error instanceof SecretsNotAvailable)) throw error;
      return finish({ outcome: 'error', message: clip(error.message) });
    }
    const deadline = AbortSignal.timeout(MCP_CHECK_TIMEOUT_MS);
    const release = spec.transport === 'stdio' ? this.deps.allowCommand?.(spec.command) : undefined;
    try {
      const answer = await this.deps.probe.probe(spec, deadline);
      const note =
        blocked === undefined
          ? undefined
          : `It answers, but ${blocked === 'pending' ? 'it is not approved in this project yet' : 'it is disabled in this project'}, so this ferret does not use it.`;
      return finish({
        outcome: 'connected',
        ...(answer.serverName === undefined ? {} : { serverName: answer.serverName }),
        toolCount: answer.tools.length,
        tools: answer.tools.slice(0, MCP_CHECK_TOOL_NAMES),
        ...(note === undefined ? {} : { message: note }),
      });
    } catch (error) {
      if (!(error instanceof McpProbeFailure)) throw error;
      const lead = FAILURE_LEAD[error.kind];
      const unset = missing.size === 0 ? '' : ` Not set for this check: ${[...missing].sort().join(', ')}.`;
      const detail = error.message === '' ? '' : ` ${await this.deps.redactor.redact(error.message)}`;
      return finish({
        outcome: error.kind === 'unauthorized' ? 'needs-sign-in' : 'error',
        message: clip(`${lead}${detail}${unset}`),
      });
    } finally {
      release?.();
    }
  }

  /**
   * The command's environment, with every `${secret:NAME}` resolved for that one child by the Vault and never seen here
   * (use, never read). Plain values go as they are. A secret the Vault does not hold refuses the check, by NAME.
   */
  async #sealed(env: Readonly<Record<string, string>>): Promise<Readonly<Record<string, string>> | ChildEnvironment> {
    const named = Object.values(env).flatMap(value => secretReferencesIn(value));
    if (named.length === 0) return env;
    if (this.deps.sealEnvironment === undefined)
      throw new SecretsNotAvailable(
        `This server's environment names a secret (${[...new Set(named)].sort().join(', ')}), and a check cannot open secrets on this machine.`,
      );
    const sealed = await this.deps.sealEnvironment(env);
    if (!sealed.ok)
      throw new SecretsNotAvailable(
        `Not stored on this machine (or not one this server may use), so the command was not started: ${[...sealed.unknown].sort().join(', ')}. Store each with fy secret set NAME.`,
      );
    return sealed.env;
  }

  async #spec(server: ResolvedMcpServer, missing: Set<string>): Promise<McpProbeSpec> {
    const declaration = server.declaration;
    if (declaration === null) throw new Error('unreachable: the tools server is refused before this');
    const runtime = server.runtimes[0]?.runtime;
    const launch = await this.deps.launchEnvironment(runtime);
    const base = this.deps.baseEnvironment();
    // A variable bound to a secret is a REFERENCE here: it fills no `${VAR}` (that would put the reference text in an
    // argument); it only reaches the child, sealed, as its environment.
    const environment = { ...base, ...plainOnly(launch) };
    if (declaration.transport === 'stdio') {
      const env = Object.fromEntries(
        Object.entries(declaration.env).map(([name, value]) => [name, expandVariables(value, environment, missing)]),
      );
      const full = { ...base, ...launch, ...env };
      return {
        transport: 'stdio',
        command: expandVariables(declaration.command, environment, missing),
        args: declaration.args.map(argument => expandVariables(argument, environment, missing)),
        env: await this.#sealed(full),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      };
    }
    const url = expandVariables(declaration.url, environment, missing);
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(declaration.headers).map(([name, value]) => [name, expandVariables(value, environment, missing)]),
    );
    if (declaration.bearerVariable !== undefined) {
      const token = environment[declaration.bearerVariable];
      if (token === undefined) missing.add(declaration.bearerVariable);
      else headers.Authorization = `Bearer ${token}`;
    }
    const hasAuthorization = Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
    if (!hasAuthorization && server.signIn !== undefined) {
      const token = await this.deps.bearer(server.signIn.subject, declaration.url);
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    }
    return { transport: declaration.transport, url, headers };
  }
}

/** For a project server: the approval that keeps the checking runtime from running it, if any. */
function blockedBy(server: ResolvedMcpServer): 'pending' | 'disabled' | undefined {
  if (server.scope !== 'project') return undefined;
  const approvals = server.runtimes.map(use => use.approval);
  if (approvals.includes('approved')) return undefined;
  if (approvals.includes('pending')) return 'pending';
  return approvals.length === 0 ? 'pending' : 'disabled';
}

/** The variables of `env` whose value names no secret. */
const plainOnly = (env: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => secretReferencesIn(value).length === 0));

const clip = (text: string, max = 1000): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The inherited variables a checked command may see: enough to find a program and a home, and no token. */
const BASE_VARIABLES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'] as const;

export const mcpCheckBaseEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    BASE_VARIABLES.flatMap(name => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
