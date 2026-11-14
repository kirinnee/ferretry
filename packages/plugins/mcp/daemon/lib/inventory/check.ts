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
 * NO SECRET LEAVES. The environment and headers are filled as the harness fills them from the runtime's launch
 * environment, handed to the probe, and dropped. A held sign-in's access token is NEVER held here: the probe is told the
 * NAME of the secret this plugin minted and the Vault places it on the request. EVERY string a server supplies (its name,
 * its tool names, its error text, a command's last stderr line) is scrubbed against the secrets this check used BEFORE it
 * is clipped, because a server's words are the one thing here nobody controls and a clipped half-token is still a token's
 * start. A scrub that cannot run reports nothing from the answer (fail closed).
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
import { expandVariables } from './json-rpc.ts';
import {
  FERRETRY_TOOLS_SERVER,
  McpInventoryRefusal,
  type McpInventoryService,
  type ResolvedMcpServer,
} from './service.ts';

/** A scrub that could not run: nothing from the answer may be shown. */
class McpScrubFailed extends Error {}

/** How a probe reaches a server: the exact process or request the harness would make. */
export type McpProbeSpec =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** A secret this plugin minted, by NAME, and where the Vault places it on every request. Never a value. */
      readonly credential?: { readonly secret: string; readonly header: string; readonly scheme?: string };
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
  /**
   * The NAMES of the runtime's variables whose value is a stored secret: a check never holds those values, so a `${NAME}`
   * that needs one is reported as such instead of as unset. Absent: none.
   */
  opaqueVariables?(runtime: string | undefined): Promise<readonly string[]>;
  /** The small inherited environment a command starts with (`PATH`, `HOME`, …) — never the daemon's tokens. */
  baseEnvironment(): Readonly<Record<string, string>>;
  /**
   * The held sign-in for a subject at an address, renewed first when it is about to expire: the NAME of the access-token
   * secret this plugin minted (never its value) and the variable a harness reads it from. `undefined` when none is held.
   */
  credential(subject: string, url: string): Promise<{ readonly secret: string; readonly variable: string } | undefined>;
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
    const used = new Set<string>();
    const opaque = new Set(await this.deps.opaqueVariables?.(server.runtimes[0]?.runtime));
    const spec = await this.#spec(server, missing, used);
    const deadline = AbortSignal.timeout(MCP_CHECK_TIMEOUT_MS);
    // Scrubbed against the kernel's secrets AND every value this check filled in from the launch environment.
    const scrub = async (text: string): Promise<string> => {
      let scrubbed: string;
      try {
        scrubbed = await this.deps.redactor.redact(text);
      } catch {
        throw new McpScrubFailed();
      }
      for (const value of used) scrubbed = scrubbed.split(value).join('[redacted]');
      return scrubbed;
    };
    try {
      const probed = await this.deps.probe.probe(spec, deadline);
      let answer: McpProbeAnswer;
      try {
        answer = {
          ...(probed.serverName === undefined ? {} : { serverName: clip(await scrub(probed.serverName), 256) }),
          // Every name is a stranger's string: the ones shown are scrubbed first, the count is the server's own count.
          tools: [
            ...(await Promise.all(
              probed.tools.slice(0, MCP_CHECK_TOOL_NAMES).map(async tool => clip(await scrub(tool), 256)),
            )),
            ...probed.tools.slice(MCP_CHECK_TOOL_NAMES).map(() => ''),
          ],
        };
      } catch (error) {
        if (!(error instanceof McpScrubFailed)) throw error;
        return finish({
          outcome: 'error',
          message: 'It answered, but Ferretry could not scrub what it said, so none of it is shown.',
        });
      }
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
      const stored = [...missing].filter(name => opaque.has(name)).sort();
      const unsetNames = [...missing].filter(name => !opaque.has(name)).sort();
      const unset =
        (unsetNames.length === 0 ? '' : ` Not set for this check: ${unsetNames.join(', ')}.`) +
        (stored.length === 0 ? '' : ` Held in a stored secret, which a check does not present: ${stored.join(', ')}.`);
      let detail = '';
      try {
        detail = error.message === '' ? '' : ` ${await scrub(error.message)}`;
      } catch (failure) {
        if (!(failure instanceof McpScrubFailed)) throw failure;
        detail = ' Ferretry could not scrub what it said, so none of it is shown.';
      }
      return finish({
        outcome: error.kind === 'unauthorized' ? 'needs-sign-in' : 'error',
        message: clip(`${lead}${detail}${unset}`),
      });
    }
  }

  async #spec(server: ResolvedMcpServer, missing: Set<string>, used: Set<string>): Promise<McpProbeSpec> {
    const declaration = server.declaration;
    if (declaration === null) throw new Error('unreachable: the tools server is refused before this');
    const runtime = server.runtimes[0]?.runtime;
    const launch = await this.deps.launchEnvironment(runtime);
    const base = this.deps.baseEnvironment();
    const environment = { ...base, ...launch };
    // Values the launch environment supplied: anything a server reflects of them is masked from the answer.
    for (const value of Object.values(launch)) if (value.length >= 8) used.add(value);
    if (declaration.transport === 'stdio') {
      const env = Object.fromEntries(
        Object.entries(declaration.env).map(([name, value]) => [name, expandVariables(value, environment, missing)]),
      );
      return {
        transport: 'stdio',
        command: expandVariables(declaration.command, environment, missing),
        args: declaration.args.map(argument => expandVariables(argument, environment, missing)),
        env: { ...base, ...launch, ...env },
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      };
    }
    const url = expandVariables(declaration.url, environment, missing);
    const held =
      server.signIn === undefined ? undefined : await this.deps.credential(server.signIn.subject, declaration.url);
    // The held sign-in's token is never filled in here: a header the harness fills with it (`${VARIABLE}`, or
    // `<scheme> ${VARIABLE}`) is the Vault's to place instead.
    let credential: { secret: string; header: string; scheme?: string } | undefined;
    const filled: [string, string][] = [];
    for (const [name, value] of Object.entries(declaration.headers)) {
      const placed = held === undefined ? undefined : placementOf(value, held.variable);
      if (held !== undefined && placed !== undefined && credential === undefined)
        credential = {
          secret: held.secret,
          header: name,
          ...(placed.scheme === undefined ? {} : { scheme: placed.scheme }),
        };
      else filled.push([name, expandVariables(value, environment, missing)]);
    }
    const headers: Record<string, string> = Object.fromEntries(filled);
    if (declaration.bearerVariable !== undefined) {
      if (held !== undefined && declaration.bearerVariable === held.variable)
        credential ??= { secret: held.secret, header: 'Authorization', scheme: 'Bearer' };
      else {
        const token = environment[declaration.bearerVariable];
        if (token === undefined) missing.add(declaration.bearerVariable);
        else {
          headers.Authorization = `Bearer ${token}`;
          if (token.length >= 8) used.add(token);
        }
      }
    }
    const hasAuthorization = Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
    if (credential === undefined && !hasAuthorization && held !== undefined)
      credential = { secret: held.secret, header: 'Authorization', scheme: 'Bearer' };
    // The Vault refuses a request that already carries the credential's header, so it is never set twice.
    const clash =
      credential !== undefined &&
      Object.keys(headers).some(name => name.toLowerCase() === credential?.header.toLowerCase());
    return {
      transport: declaration.transport,
      url,
      headers,
      ...(credential === undefined || clash ? {} : { credential }),
    };
  }
}

/** `${VARIABLE}` or `<scheme> ${VARIABLE}` as a header's whole value: where a held sign-in's token goes. */
function placementOf(value: string, variable: string): { readonly scheme?: string } | undefined {
  const found = /^(?:(\S+) )?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value.trim());
  if (found === null || found[2] !== variable) return undefined;
  return found[1] === undefined ? {} : { scheme: found[1] };
}

/** For a project server: the approval that keeps the checking runtime from running it, if any. */
function blockedBy(server: ResolvedMcpServer): 'pending' | 'disabled' | undefined {
  if (server.scope !== 'project') return undefined;
  const approvals = server.runtimes.map(use => use.approval);
  if (approvals.includes('approved')) return undefined;
  if (approvals.includes('pending')) return 'pending';
  return approvals.length === 0 ? 'pending' : 'disabled';
}

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
