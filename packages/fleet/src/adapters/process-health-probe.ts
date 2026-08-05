import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FleetHealthFailureKind, FleetHealthProbe, FleetHealthProbeResult } from '../lib/health.ts';
import type { FleetManifestAccount } from '../lib/manifest.ts';

export const FLEET_HEALTH_SENTINEL = 'FERRETRY_HEALTH_OK';
export const FLEET_HEALTH_SUCCESS_TTL_MS = 15 * 60 * 1_000;

export interface FleetHealthProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
export interface FleetHealthProcess {
  run(command: readonly string[], timeoutMs: number): Promise<FleetHealthProcessResult>;
}

/** Production process boundary. Tests inject `FleetHealthProcess` and never spawn a harness. */
export const runFleetHealthProcess: FleetHealthProcess = {
  async run(command, timeoutMs) {
    const child = Bun.spawn({ cmd: [...command], stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(9);
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  },
};
export interface ProcessFleetHealthProbeOptions {
  readonly process: FleetHealthProcess;
  /** Scoped to one FY_HOME/daemon. Never use a user-global cache for health. */
  readonly cachePath: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

type Cache = { readonly version: 1; readonly successes: Record<string, number> };
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the ANSI control sequence a harness may emit.
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const diagnostic = (value: string) => value.replace(ANSI_ESCAPE, '').trim().slice(-300) || 'no diagnostic output';
const classify = (output: string): FleetHealthFailureKind => {
  if (/(?:\b429\b|rate[ -]?limit|quota|insufficient[_ ]quota)/i.test(output)) return 'rate_limited';
  if (/(?:\b401\b|\b403\b|not logged in|auth(?:entication)?|unauthori[sz]ed|invalid.*(?:key|token))/i.test(output))
    return 'authentication';
  return 'process_error';
};

/**
 * Runs a deliberately tiny sentinel turn. Exit zero alone is NEVER success: a wrapper that swallows
 * a provider failure exits cleanly, so only an exact stdout sentinel proves the account usable.
 */
export class ProcessFleetHealthProbe implements FleetHealthProbe {
  constructor(private readonly options: ProcessFleetHealthProbeOptions) {}

  async probe(account: FleetManifestAccount): Promise<FleetHealthProbeResult> {
    const now = this.#now();
    const cache = await this.#cache();
    const cachedAt = cache.successes[account.wrapper];
    if (typeof cachedAt === 'number' && cachedAt <= now && now - cachedAt < FLEET_HEALTH_SUCCESS_TTL_MS)
      return { state: 'healthy', cached: true, checkedAt: cachedAt, ms: 0 };
    const started = Date.now();
    try {
      const result = await this.options.process.run(this.#command(account), this.options.timeoutMs ?? 30_000);
      const checkedAt = this.#now();
      const ms = Math.max(0, Date.now() - started);
      if (result.exitCode === 0 && result.stdout.trim() === FLEET_HEALTH_SENTINEL) {
        await this.#record(account.wrapper, checkedAt, cache);
        return { state: 'healthy', cached: false, checkedAt, ms };
      }
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0)
        return {
          state: 'down',
          cached: false,
          checkedAt,
          ms,
          failureKind: 'unexpected_reply',
          error: `expected exact sentinel ${FLEET_HEALTH_SENTINEL}, got ${JSON.stringify(result.stdout.trim() || '<empty>')}`,
        };
      return {
        state: 'down',
        cached: false,
        checkedAt,
        ms,
        failureKind: classify(output),
        error: `probe exited ${result.exitCode}: ${diagnostic(output)}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /timeout|timed out/i.test(message);
      return {
        state: timeout ? 'down' : 'unknown',
        cached: false,
        checkedAt: this.#now(),
        ms: Math.max(0, Date.now() - started),
        failureKind: timeout ? 'timeout' : 'launch',
        error: timeout ? `timed out: ${message}` : `could not launch probe: ${message}`,
      };
    }
  }

  #command(account: FleetManifestAccount): readonly string[] {
    const prompt = `Reply with exactly: ${FLEET_HEALTH_SENTINEL} and nothing else.`;
    return account.kind === 'claude'
      ? [
          account.wrapper,
          '--print',
          '--dangerously-skip-permissions',
          '--no-session-persistence',
          '--no-chrome',
          '--tools',
          '',
          prompt,
        ]
      : [
          account.wrapper,
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--ignore-rules',
          '--color',
          'never',
          '--sandbox',
          'read-only',
          '-c',
          'model_reasoning_effort="low"',
          prompt,
        ];
  }

  async #cache(): Promise<Cache> {
    try {
      const parsed = JSON.parse(await readFile(this.options.cachePath, 'utf8')) as Partial<Cache>;
      return parsed.version === 1 && parsed.successes && typeof parsed.successes === 'object'
        ? { version: 1, successes: parsed.successes }
        : { version: 1, successes: {} };
    } catch {
      return { version: 1, successes: {} };
    }
  }

  async #record(wrapper: string, checkedAt: number, cache: Cache): Promise<void> {
    const next: Cache = { version: 1, successes: { ...cache.successes, [wrapper]: checkedAt } };
    const temporary = `${this.options.cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.options.cachePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temporary, this.options.cachePath);
    } catch {
      /* caching never changes an observed success into a failure */
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  #now(): number {
    return Math.trunc(this.options.now?.() ?? Date.now());
  }
}
