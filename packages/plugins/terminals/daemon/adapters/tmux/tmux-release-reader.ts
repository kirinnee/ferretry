import type { SpawnPort } from '@ferretry/kernel/contract';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import type { ControlTimer } from './control-tmux-process.ts';
import { TIMED_OUT, within } from './bounded.ts';
import type { TmuxReleaseReading } from '../../lib/tmux/version.ts';

/** Long enough for a loaded host, short enough that a wedged tmux cannot hold a doctor report. */
export const DEFAULT_RELEASE_TIMEOUT_MS = 2_000;

/**
 * Asks the installed tmux for its release (`tmux -V`) and this daemon's own server for the release it
 * runs (`display-message -p '#{version}'`) — the two answers the doctor's `tmux release` row judges.
 *
 * NEITHER STARTS ANYTHING. `-V` prints and exits; `display-message` against a socket nobody serves
 * fails with "no server running" rather than starting one, which is read as "no server to judge".
 * Every failure is an absent answer, never a guess, and each question is bounded: the `-V` child is killed
 * when its bound passes, and `releaseReader` hands both children the same bound as the spawn port's own timeout,
 * so a wedged server's `display-message` client is killed too rather than left running.
 */
export class TmuxReleaseReader {
  constructor(
    private readonly spawn: SpawnPort,
    private readonly executable: string,
    private readonly server: TmuxCommandPort,
    private readonly after: ControlTimer,
    private readonly timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
  ) {}

  async read(): Promise<TmuxReleaseReading> {
    const [program, server] = await Promise.all([this.program(), this.serverRelease()]);
    return { ...(program === undefined ? {} : { program }), ...(server === undefined ? {} : { server }) };
  }

  private async program(): Promise<string | undefined> {
    try {
      const child = this.spawn.start(this.executable, ['-V']);
      void new Response(child.stderr).text().catch(() => undefined);
      const answer = await within(
        Promise.all([new Response(child.stdout).text(), child.exited]),
        this.timeoutMs,
        this.after,
      );
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
      const answer = await within(
        this.server.execute(['display-message', '-p', '#{version}']),
        this.timeoutMs,
        this.after,
      );
      if (answer === TIMED_OUT || answer.code !== 0) return undefined;
      return answer.stdout.trim() === '' ? undefined : answer.stdout.trim();
    } catch {
      return undefined;
    }
  }
}
