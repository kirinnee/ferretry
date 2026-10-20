import {
  type PackProbeOutcome,
  type PackProbePort,
  type PackProbeRequest,
  PROBE_PROMPT,
  probeAnswered,
} from '../../lib/pack/probe.ts';
import { launchEnvironment } from '../../lib/fleet/launch-environment.ts';
import { effortLaunchArguments } from '../../lib/session/launch/argv.ts';

/** The launch environment a runtime's wrapper needs: its login's secrets, as a pane is given them. */
export interface ProbeEnvironment {
  /** Keyed by the ABSOLUTE launcher, as a session record carries it. */
  forWrapper(wrapper: string): Promise<Readonly<Record<string, string>>>;
}

/**
 * Where a runtime's launcher is, decided exactly as a start decides it: the published account's absolute
 * wrapper (`$FY_HOME/fleet/bin/<runtime>`), checked runnable on this host. NEVER a name looked up on
 * `PATH` — a daemon under a service manager has no fleet bin directory on its `PATH`, so a probe that ran
 * the bare name failed every candidate while the start it guarded would have worked.
 */
export interface ProbeLauncher {
  /** The absolute launcher; throws, saying why a start would be refused, when there is none. */
  resolve(wrapper: string): Promise<string>;
}

/** Starts one process and hands back its output, or `timeout`; kills it when the time is up. */
export type ProbeSpawn = (input: {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}) => Promise<
  { readonly kind: 'exited'; readonly code: number; readonly stdout: string } | { readonly kind: 'timeout' }
>;

/**
 * The argv of one probe: the runtime's own launcher, at the absolute path a start runs — so the probe runs
 * exactly the login, profile and fixed layer a start would — in its CLI's one-shot mode, on the model
 * asked for, at the lowest effort the CLI lets a flag set. Claude Code takes its effort from settings
 * only, so a Claude probe runs at the runtime's own; Codex is told `low` through the start's own effort
 * argument.
 */
export function probeCommand(request: PackProbeRequest, launcher: string): readonly string[] {
  const model = request.model === undefined ? [] : ['--model', request.model];
  if (request.harness === 'claude') return [launcher, '-p', PROBE_PROMPT, ...model];
  return [launcher, 'exec', '--skip-git-repo-check', ...effortLaunchArguments('codex', 'low'), ...model, PROBE_PROMPT];
}

const reasonOf = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

/** The probe behind {@link PackProbePort}: one real, bounded run of the runtime's CLI. */
export class CliPackProbe implements PackProbePort {
  constructor(
    private readonly launcher: ProbeLauncher,
    private readonly environment: ProbeEnvironment,
    private readonly spawn: ProbeSpawn,
    private readonly base: Readonly<Record<string, string>>,
    private readonly monotonicMs: () => number,
  ) {}

  async probe(request: PackProbeRequest): Promise<PackProbeOutcome> {
    const started = this.monotonicMs();
    const elapsed = (): number => Math.max(0, Math.round(this.monotonicMs() - started));
    let launcher: string;
    try {
      launcher = await this.launcher.resolve(request.wrapper);
    } catch (error) {
      return {
        ok: false,
        ms: elapsed(),
        reason: `it cannot be launched: ${reasonOf(error, 'its launcher is unknown')}`,
      };
    }
    // The pane's precedence: the login's profile over the daemon's sanitized environment, never its HOME.
    let env: Readonly<Record<string, string>>;
    try {
      env = { ...this.base, ...launchEnvironment(await this.environment.forWrapper(launcher), {}) };
    } catch (error) {
      return { ok: false, ms: elapsed(), reason: reasonOf(error, 'its login could not be read') };
    }
    const outcome = await this.spawn({
      cmd: probeCommand(request, launcher),
      cwd: request.cwd,
      env,
      timeoutMs: request.timeoutMs,
    }).catch((error: unknown) => ({
      kind: 'failed' as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (outcome.kind === 'failed')
      return { ok: false, ms: elapsed(), reason: `it could not be started (${outcome.reason})` };
    if (outcome.kind === 'timeout')
      return { ok: false, ms: elapsed(), reason: `no answer within ${String(Math.round(request.timeoutMs / 1_000))}s` };
    if (outcome.code !== 0) return { ok: false, ms: elapsed(), reason: `it exited ${String(outcome.code)}` };
    if (!probeAnswered(outcome.stdout)) return { ok: false, ms: elapsed(), reason: 'it answered, but not OK' };
    return { ok: true, ms: elapsed() };
  }
}

/** The real spawn: Bun's, with the read raced against the deadline, because a killed child can keep its pipe open. */
export const bunProbeSpawn: ProbeSpawn = async input => {
  const child = Bun.spawn({
    cmd: [...input.cmd],
    cwd: input.cwd,
    env: { ...input.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), input.timeoutMs);
  });
  const finished = (async () => {
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    return { kind: 'exited' as const, code, stdout };
  })();
  const outcome = await Promise.race([finished, deadline]);
  clearTimeout(timer);
  if (outcome.kind === 'timeout') child.kill('SIGKILL');
  return outcome;
};
