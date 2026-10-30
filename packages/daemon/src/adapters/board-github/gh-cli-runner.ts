import type { GhOutcome, GhRunner } from '../../lib/board-github/index.ts';

/** How long one `gh` call may take before it is killed and reported as failed. */
export const GH_TIMEOUT_MS = 30_000;
/** How much of `gh`'s complaint a failure keeps: its first line, cut to this length. */
const DETAIL_LENGTH = 300;

/** `gh` exits 4 when the command needs a sign-in it does not have. */
const GH_AUTH_EXIT = 4;
const SIGNED_OUT = /gh auth login|not logged in|authentication required/iu;

const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, DETAIL_LENGTH);

/**
 * The host's own `gh` CLI, run as a child with the host's own sign-in. Nothing here reads, passes or keeps a
 * token: `gh` finds its credentials itself. It never prompts (`GH_PROMPT_DISABLED`), and a call that runs
 * past {@link GH_TIMEOUT_MS} is killed.
 */
export class GhCliRunner implements GhRunner {
  constructor(
    private readonly binary = 'gh',
    private readonly timeoutMs = GH_TIMEOUT_MS,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async run(args: readonly string[]): Promise<GhOutcome> {
    let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
    try {
      child = Bun.spawn([this.binary, ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...this.environment, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
      });
    } catch {
      return { kind: 'missing' };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (timedOut) return { kind: 'failed', detail: `gh took longer than ${String(this.timeoutMs)} ms`, stdout: '' };
      if (code === 0) return { kind: 'ok', stdout };
      if (code === GH_AUTH_EXIT || SIGNED_OUT.test(stderr))
        return { kind: 'unauthenticated', detail: firstLine(stderr) };
      return { kind: 'failed', detail: firstLine(stderr) || `gh exited ${String(code)}`, stdout };
    } finally {
      clearTimeout(timer);
    }
  }
}
