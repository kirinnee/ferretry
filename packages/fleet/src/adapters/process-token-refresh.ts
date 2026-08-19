/**
 * The two non-inference paths that make a harness renew its own credential.
 *
 * Each harness renews an expired OAuth token as a side effect of being used, so the whole trick is to
 * use it for something that costs nothing:
 *
 * - **Claude** — `claude mcp list`. It loads the account's credential and takes Claude Code's own
 *   refresh-if-expired path, while invoking no model. Idempotent when the token is fresh.
 * - **Codex** — `codex app-server` over stdio JSON-RPC: `initialize`, then `getAuthStatus` with
 *   `refreshToken: true`, which performs the OAuth rotation. The server never exits on its own, so it
 *   is stopped once the credential has settled.
 *
 * Both are **undocumented surfaces of a third-party CLI**, not supported APIs, and this port is where
 * that dependency is admitted. A harness that renames either path stops renewing anything and says
 * so; nothing here can mistake that for a healthy account, because this port cannot report health at
 * all (see {@link FleetTokenRefreshAttempt}).
 *
 * ## Both paths were measured, not assumed
 *
 * Against a throwaway home holding a deliberately expired credential, `claude mcp list` (2.1.220)
 * rewrote that credential — which is how it is known to drive the rotation rather than merely read
 * configuration, and it does so with no MCP server configured at all. **A rejected rotation makes it
 * clear its own tokens**, so a home whose refresh token was already dead comes back `missing` rather
 * than `refreshable`; that is a real outcome with a name and a remedy rather than a surprise, and it
 * costs nothing, because a refresh token the provider refuses was worth nothing.
 *
 * `codex app-server` (codex-cli 0.145.0) accepts exactly the two requests below and answers the second
 * with `authToken: null` — the rotation without the token, which is the whole point of asking for
 * `includeToken: false`.
 *
 * ## Why the raw binary and not the account's wrapper
 *
 * A wrapper is for sessions. It prepends the account's configured flags, seeds first-run prompts, and
 * sources a secrets file — all correct for launching an agent and all wrong for a renewal, where
 * prepending a session flag to `mcp list` or `app-server` is how a refresh quietly becomes something
 * else. The only thing that decides *which* credential rotates is the harness home, and the home is
 * exported here from the manifest's own value rather than inherited or parsed out of a script.
 *
 * ## Nothing here can read a token
 *
 * `stdout` and `stderr` are discarded unread, so even output that volunteered a credential could not
 * be seen; the Codex request asks for `includeToken: false` as well, so it should not be offered one.
 * The environment handed to the child is sanitized first — every command in this product runs inside
 * somebody's agent session, and that session exports provider credentials of its own, which is how a
 * renewal for one account ends up authenticating as another. What the child gets is the caller's
 * environment with the provider and session variables stripped, plus one variable: its own home.
 */
import { failureMessage } from '../lib/identity.ts';
import { sanitizeHarnessEnv } from '../lib/harness-env.ts';
import type {
  FleetTokenRefreshAttempt,
  FleetTokenRefreshPort,
  FleetTokenRefreshSettled,
  FleetTokenRefreshTarget,
} from '../lib/token-refresh.ts';
import { HARNESS_BINARIES, HARNESS_HOME_ENV } from '../lib/wrappers.ts';
import type { FleetBinaryLookup } from './process-login.ts';

/** A started renewal. Deliberately offers no way to read what the child printed. */
export interface FleetTokenRefreshProcess {
  readonly exited: Promise<number>;
  write(text: string): Promise<void>;
  close(): Promise<void>;
  /** SIGKILL. Both paths are stopped rather than asked, so neither can wedge a fleet command. */
  kill(): void;
}

export type FleetTokenRefreshSpawn = (
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => FleetTokenRefreshProcess;

/** Hard ceiling on one renewal, including the OAuth round trip the harness makes. */
export const FLEET_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
/** How often the Codex path asks whether the credential has settled. */
export const FLEET_TOKEN_REFRESH_POLL_MS = 250;

/**
 * `app-server` requires a client identity before it will answer anything. The version is not a claim
 * about this build and nothing reads it back; `includeToken: false` is the load-bearing field — the
 * rotation is wanted, the token is not.
 */
const REFRESH_REQUESTS: readonly Readonly<Record<string, unknown>>[] = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'ferretry', title: 'Ferretry', version: '0.0.0' }, capabilities: {} },
  },
  { jsonrpc: '2.0', id: 2, method: 'getAuthStatus', params: { includeToken: false, refreshToken: true } },
];

export interface ProcessFleetTokenRefreshDeps {
  readonly spawn: FleetTokenRefreshSpawn;
  /** The caller's environment, sanitized before any of it reaches a child. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly which: FleetBinaryLookup;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

export class ProcessFleetTokenRefreshPort implements FleetTokenRefreshPort {
  constructor(private readonly deps: ProcessFleetTokenRefreshDeps) {}

  /**
   * Run the renewal path for one home.
   *
   * A host without the harness installed is `unavailable` rather than a failure: nothing is wrong with
   * the credential, and the remedy is on a different machine. Every other way this can go wrong is
   * `error` with the failure's own sentence — a renewal must never be able to take down the login it
   * was trying to make unnecessary.
   */
  async refresh(target: FleetTokenRefreshTarget, settled: FleetTokenRefreshSettled): Promise<FleetTokenRefreshAttempt> {
    const binary = HARNESS_BINARIES[target.kind];
    const executable = this.deps.which(binary);
    if (executable === undefined) {
      return {
        outcome: 'unavailable',
        reason: `the "${binary}" CLI is not on this host, so its credential cannot be renewed here — install it, or renew this account on a host that has it and copy the credential across with "fy fleet login --sync-only"`,
      };
    }
    const environment = {
      ...sanitizeHarnessEnv(this.deps.environment),
      [HARNESS_HOME_ENV[target.kind]]: target.home,
    };
    try {
      return target.kind === 'claude'
        ? await this.#claude(executable, environment)
        : await this.#codex(executable, environment, settled);
    } catch (error) {
      return { outcome: 'error', reason: failureMessage(error, 'the renewal could not be run') };
    }
  }

  /**
   * Claude: one connectors call, then wait for it to finish.
   *
   * The exit code is read by nobody on purpose. `mcp list` exits non-zero when a configured MCP server
   * is unreachable, which says nothing about the credential, and exits zero whether or not anything
   * needed renewing — so both answers would be noise. stdin is closed immediately: this path is not
   * asked anything.
   */
  async #claude(
    executable: string,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<FleetTokenRefreshAttempt> {
    const child = this.deps.spawn([executable, 'mcp', 'list'], environment);
    const killer = setTimeout(() => child.kill(), this.#timeoutMs());
    try {
      await child.close();
      await child.exited;
    } finally {
      clearTimeout(killer);
    }
    return { outcome: 'ran' };
  }

  /**
   * Codex: drive the app server, then stop it.
   *
   * `app-server` is a long-lived server — it does not exit when a request is answered, so waiting for
   * it would wait forever. It is asked whether the credential has settled instead, which stops the
   * moment the work is done rather than after a guessed interval, and the timer is the hard backstop
   * for a rotation that never lands.
   */
  async #codex(
    executable: string,
    environment: Readonly<Record<string, string | undefined>>,
    settled: FleetTokenRefreshSettled,
  ): Promise<FleetTokenRefreshAttempt> {
    const child = this.deps.spawn([executable, 'app-server'], environment);
    const killer = setTimeout(() => child.kill(), this.#timeoutMs());
    try {
      await child.write(`${REFRESH_REQUESTS.map(request => JSON.stringify(request)).join('\n')}\n`);
      const pollMs = this.deps.pollMs ?? FLEET_TOKEN_REFRESH_POLL_MS;
      const polls = Math.max(1, Math.ceil(this.#timeoutMs() / pollMs));
      for (let poll = 0; poll < polls; poll += 1) {
        if (await settled()) break;
        await (this.deps.sleep ?? delay)(pollMs);
      }
      await child.close();
      child.kill();
      await child.exited;
    } finally {
      clearTimeout(killer);
    }
    return { outcome: 'ran' };
  }

  #timeoutMs(): number {
    return this.deps.timeoutMs ?? FLEET_TOKEN_REFRESH_TIMEOUT_MS;
  }
}

/**
 * The production process boundary: piped stdin so the Codex path can speak, and **discarded** stdout
 * and stderr so nothing this product runs can read what a harness printed about a credential.
 */
export const spawnFleetTokenRefreshProcess: FleetTokenRefreshSpawn = (command, environment) => {
  const child = Bun.spawn({
    cmd: [...command],
    env: environment,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    exited: child.exited,
    async write(text) {
      child.stdin.write(text);
      await child.stdin.flush();
    },
    async close() {
      try {
        await child.stdin.end();
      } catch {
        /* already closed — a renewal is never failed over its own cleanup */
      }
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
};
