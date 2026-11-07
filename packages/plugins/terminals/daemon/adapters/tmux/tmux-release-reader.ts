import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import type { TmuxReleaseReading } from '../../lib/tmux/version.ts';

/** Long enough for a loaded host, short enough that a wedged tmux cannot hold a doctor report. */
const DEFAULT_TIMEOUT_MS = 2_000;

const TIMED_OUT = Symbol('timed out');

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the installed tmux for its release (`tmux -V`) and this daemon's own server for the release it
 * runs (`display-message -p '#{version}'`) — the two answers the doctor's `tmux release` row judges.
 *
 * NEITHER STARTS ANYTHING. `-V` prints and exits; `display-message` against a socket nobody serves
 * fails with "no server running" rather than starting one, which is read as "no server to judge".
 * Every failure is an absent answer, never a guess, and each question is bounded.
 */
export class TmuxReleaseReader {
  constructor(
    private readonly executable: string,
    private readonly server: TmuxCommandPort,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async read(): Promise<TmuxReleaseReading> {
    const [program, server] = await Promise.all([this.program(), this.serverRelease()]);
    return { ...(program === undefined ? {} : { program }), ...(server === undefined ? {} : { server }) };
  }

  private async program(): Promise<string | undefined> {
    try {
      const child = Bun.spawn([this.executable, '-V'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const answer = await within(Promise.all([new Response(child.stdout).text(), child.exited]), this.timeoutMs);
      if (answer === TIMED_OUT) {
        child.kill('SIGKILL');
        return undefined;
      }
      const [stdout, code] = answer;
      return code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private async serverRelease(): Promise<string | undefined> {
    try {
      const answer = await within(this.server.execute(['display-message', '-p', '#{version}']), this.timeoutMs);
      if (answer === TIMED_OUT || answer.code !== 0) return undefined;
      return answer.stdout.trim() === '' ? undefined : answer.stdout.trim();
    } catch {
      return undefined;
    }
  }
}
