import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  type GhOutcome,
  type GhRunner,
  githubRepositoryOf,
  parseGitRemote,
  type WorkingCopies,
} from '../lib/github/index.ts';

/** How long one `gh` call may take before it is killed and reported as failed. */
export const GH_TIMEOUT_MS = 30_000;
const DETAIL_LENGTH = 300;
/** `gh` exits 4 when the command needs a sign-in it does not have. */
const GH_AUTH_EXIT = 4;
const SIGNED_OUT = /gh auth login|not logged in|authentication required/iu;

const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, DETAIL_LENGTH);

/*
 * GAP: the `gh` and `git` children get only the kernel's child environment (`PATH`, `HOME`) plus the few values set
 * here. So they lose `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` (a keyring-backed `gh`
 * sign-in can look signed out), `GH_CONFIG_DIR`, `SSH_AUTH_SOCK` and the proxy variables, until the kernel's
 * child-environment allow-list of non-secret names lands. Nothing here may widen it by hand, and no token
 * (`GH_TOKEN`, `GITHUB_TOKEN`, `hosts.yml`) is ever read or passed: `gh` finds its own sign-in.
 */
const GH_ENVIRONMENT = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } as const;

/**
 * The host's own `gh` CLI, run as a child with the host's own sign-in. Nothing here reads, passes or keeps a token:
 * `gh` finds its credentials itself. It never prompts, and a call that runs past {@link GH_TIMEOUT_MS} is killed.
 *
 * The deadline is this runner's own, on the kernel clock, and it kills the child through the spawn's abort signal: the
 * kernel's spawn reports a killed child as an ordinary exit (143 for SIGTERM, `signal: null`), so the exit code alone
 * cannot tell a timeout from `gh` failing. A timed-out call passes none of what `gh` printed on.
 */
export class GhSpawnRunner implements GhRunner {
  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly clock: Pick<Clock, 'after'>,
    private readonly timeoutMs = GH_TIMEOUT_MS,
  ) {}

  async run(args: readonly string[]): Promise<GhOutcome> {
    const deadline = new AbortController();
    const cancel = this.clock.after(milliseconds(this.timeoutMs), () => {
      deadline.abort();
    });
    let result: Awaited<ReturnType<SpawnPort['run']>>;
    try {
      result = await this.spawn.run('gh', args, { env: GH_ENVIRONMENT, signal: deadline.signal });
    } catch {
      // The kernel's spawn REJECTS when the program cannot start at all (no `gh` on the PATH).
      return deadline.signal.aborted ? this.timedOut() : { kind: 'missing' };
    } finally {
      cancel();
    }
    if (deadline.signal.aborted) return this.timedOut();
    if (result.exitCode === 0) return { kind: 'ok', stdout: result.stdout };
    if (result.exitCode === GH_AUTH_EXIT || SIGNED_OUT.test(result.stderr))
      return { kind: 'unauthenticated', detail: firstLine(result.stderr) };
    return {
      kind: 'failed',
      detail: firstLine(result.stderr) || `gh exited ${String(result.exitCode ?? result.signal)}`,
      stdout: result.stdout,
    };
  }

  private timedOut(): GhOutcome {
    return { kind: 'failed', detail: `gh took longer than ${String(this.timeoutMs)} ms`, stdout: '' };
  }
}

/**
 * How long an answer is kept: never past the tick that asked for it. The watch waits at least `WATCH_TICK_MS`
 * less its jitter (27 s) after a tick before the next one starts, so every tick asks git again, and only the
 * questions one tick repeats (several cards in one folder, the Unfiled refile at the end of it) share an answer.
 */
export const KEPT_FOR_MS = 10_000;
const KEPT_FOLDERS = 512;

interface Kept {
  readonly at: number;
  readonly answer: Promise<string | null>;
}

/**
 * Asks git (through the spawn port) about a folder: the GitHub repository its `origin` names, and the branch it has
 * checked out. An SSH `origin` may name a host alias; `ssh -G` says where it goes (and connects to nothing).
 *
 * WHY AN ANSWER LIVES ONLY FOR ONE TICK. An answer may be kept only while what git read for it is unchanged, and
 * this half cannot look at a working copy's files (no file system port reaches an arbitrary project folder), so it
 * cannot tell a checkout or a `remote set-url` from nothing happening. Asking git whether `HEAD` moved costs the
 * same process as asking the question. So no answer outlives {@link KEPT_FOR_MS}, which is shorter than the gap
 * between two ticks: a branch switched since the last tick is always seen. A question already being asked is
 * joined, never asked twice at once. The children's environment is the kernel's (`PATH`, `HOME`), so no `GIT_*`
 * variable can send git to a repository or config other than the folder's own.
 *
 * ONE instance serves the watcher and the Unfiled refile, so a refile inside a tick reuses that tick's answers.
 */
export class GitSpawnCopies implements WorkingCopies {
  private readonly hosts = new Map<string, Promise<string | null>>();
  private readonly kept = new Map<string, Kept>();

  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly clock: Pick<Clock, 'nowMs'>,
  ) {}

  async repositoryOf(path: string): Promise<string | null> {
    return await this.answer(`repository\n${path}`, async () => {
      const url = await this.run('git', ['-C', path, 'remote', 'get-url', 'origin']);
      const remote = url === null ? null : parseGitRemote(url);
      if (remote === null) return null;
      const direct = githubRepositoryOf(remote, null);
      if (direct !== null || !remote.ssh) return direct;
      return githubRepositoryOf(remote, (await this.hostOf(remote.host)) ?? remote.host);
    });
  }

  /**
   * The branch `HEAD` names, from the FULL ref (a tag of the same name makes `--short` print `heads/<name>`), and
   * `--no-recurse` so a symbolic branch ref is not followed.
   */
  async branchOf(path: string): Promise<string | null> {
    return await this.answer(`branch\n${path}`, async () => {
      const ref = await this.run('git', ['-C', path, 'symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
      return ref?.startsWith('refs/heads/') === true ? ref.slice('refs/heads/'.length) : null;
    });
  }

  private async answer(key: string, ask: () => Promise<string | null>): Promise<string | null> {
    const now = this.clock.nowMs();
    const known = this.kept.get(key);
    if (known !== undefined && now - known.at < KEPT_FOR_MS) return await known.answer;
    this.kept.delete(key);
    if (this.kept.size >= KEPT_FOLDERS) {
      const oldest = this.kept.keys().next().value;
      if (oldest !== undefined) this.kept.delete(oldest);
    }
    const kept: Kept = { at: now, answer: ask() };
    this.kept.set(key, kept);
    let answered: string | null = null;
    try {
      answered = await kept.answer;
      return answered;
    } finally {
      // Only a real answer is kept: `null` is also what a git that could not START says.
      if (answered === null && this.kept.get(key) === kept) this.kept.delete(key);
    }
  }

  private async hostOf(alias: string): Promise<string | null> {
    const known = this.hosts.get(alias);
    if (known !== undefined) return await known;
    const asked = this.run('ssh', ['-G', alias]).then(output => {
      const line = output?.split('\n').find(entry => entry.toLowerCase().startsWith('hostname '));
      return line === undefined ? null : line.slice('hostname '.length).trim();
    });
    this.hosts.set(alias, asked);
    return await asked;
  }

  /** The program's output, trimmed, or `null` when it failed, printed nothing, or could not run. See GAP above. */
  private async run(program: 'git' | 'ssh', args: readonly string[]): Promise<string | null> {
    try {
      const result = await this.spawn.run(program, args, { timeout: milliseconds(10_000) });
      const output = result.stdout.trim();
      return result.exitCode === 0 && output !== '' ? output : null;
    } catch {
      return null;
    }
  }
}
