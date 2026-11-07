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

/**
 * The host's own `gh` CLI, run as a child with the host's own sign-in. Nothing here reads, passes or keeps a token:
 * `gh` finds its credentials itself. It never prompts, and a call that runs past {@link GH_TIMEOUT_MS} is killed.
 */
export class GhSpawnRunner implements GhRunner {
  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly timeoutMs = GH_TIMEOUT_MS,
  ) {}

  async run(args: readonly string[]): Promise<GhOutcome> {
    let result: Awaited<ReturnType<SpawnPort['run']>>;
    try {
      result = await this.spawn.run('gh', args, {
        env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
        timeout: milliseconds(this.timeoutMs),
      });
    } catch {
      return { kind: 'missing' };
    }
    if (result.exitCode === 0) return { kind: 'ok', stdout: result.stdout };
    if (result.exitCode === null)
      return { kind: 'failed', detail: `gh took longer than ${String(this.timeoutMs)} ms`, stdout: '' };
    if (result.exitCode === GH_AUTH_EXIT || SIGNED_OUT.test(result.stderr))
      return { kind: 'unauthenticated', detail: firstLine(result.stderr) };
    return {
      kind: 'failed',
      detail: firstLine(result.stderr) || `gh exited ${String(result.exitCode)}`,
      stdout: result.stdout,
    };
  }
}

/** How long a working copy's answer is kept: its remote and branch change rarely, and each question is a process. */
const KEPT_FOR_MS = 60_000;
const KEPT_FOLDERS = 512;

interface Kept {
  readonly at: number;
  readonly answer: string | null;
}

/**
 * Asks git (through the spawn port) about a folder: the GitHub repository its `origin` names, and the branch it has
 * checked out. An SSH `origin` may name a host alias; `ssh -G` says where it goes (and connects to nothing).
 * Answers are kept for a minute, so a tick over eighteen linked cards forks a handful of processes, not seventy-two.
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

  async branchOf(path: string): Promise<string | null> {
    return await this.answer(`branch\n${path}`, async () => {
      const ref = await this.run('git', ['-C', path, 'symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
      return ref?.startsWith('refs/heads/') === true ? ref.slice('refs/heads/'.length) : null;
    });
  }

  private async answer(key: string, ask: () => Promise<string | null>): Promise<string | null> {
    const now = this.clock.nowMs() as number;
    const known = this.kept.get(key);
    if (known !== undefined && now - known.at < KEPT_FOR_MS) return known.answer;
    const answer = await ask();
    // Only a real answer is kept: `null` is also what a git that could not START says.
    if (answer !== null) {
      this.kept.delete(key);
      if (this.kept.size >= KEPT_FOLDERS) {
        const oldest = this.kept.keys().next().value;
        if (oldest !== undefined) this.kept.delete(oldest);
      }
      this.kept.set(key, { at: now, answer });
    }
    return answer;
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
