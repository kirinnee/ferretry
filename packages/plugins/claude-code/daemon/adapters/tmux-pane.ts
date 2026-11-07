import type { SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { FerretPane } from '../lib/permission/service.ts';

const TMUX_TIMEOUT_MS = 5_000;

/**
 * Which pane a ferret's Claude is in, as the runner named it (Terminals: the tmux pane id, `%12`). Filled by the
 * harness every time it is handed a handle — a start, a resume, a stop, a delivery — and emptied when the ferret
 * is stopped.
 *
 * GAP, said out loud: the answer routes get only a ferret id, and `FerretSummary` carries no handle, so a ferret
 * this daemon has not yet seen a handle for (after a restart, until the next start, resume or delivery) has no
 * pane to read, and an answer is refused with a sentence rather than guessed.
 */
export class PaneDirectory {
  readonly #handles = new Map<string, string>();

  remember(ferret: string, handle: string): void {
    this.#handles.set(ferret, handle);
  }

  forget(ferret: string): void {
    this.#handles.delete(ferret);
  }

  /** The pane id, or throws the sentence an answer route turns into a refusal. */
  require(ferret: string): string {
    const handle = this.#handles.get(ferret);
    if (handle === undefined) throw new PaneUnknown(ferret);
    return handle;
  }
}

export class PaneUnknown extends Error {
  constructor(readonly ferret: string) {
    super(`this daemon does not know which pane ferret ${ferret} is in, so nothing was read or sent`);
    this.name = 'PaneUnknown';
  }
}

/**
 * A ferret's own pane through tmux, addressed by the exact pane id the runner handed out — never a session name
 * that could resolve to another pane between a read and a write.
 */
export class TmuxPane implements FerretPane {
  constructor(
    private readonly spawn: SpawnPort,
    private readonly panes: PaneDirectory,
  ) {}

  async capture(ferretId: string): Promise<string> {
    const pane = this.panes.require(ferretId);
    const result = await this.spawn.run('tmux', ['capture-pane', '-p', '-t', pane], {
      timeout: milliseconds(TMUX_TIMEOUT_MS),
    });
    if (result.exitCode !== 0)
      throw new Error(
        `ferret ${ferretId}'s pane could not be read: ${result.stderr.trim() || `tmux exited ${String(result.exitCode)}`}`,
      );
    return result.stdout;
  }

  async write(ferretId: string, bytes: Uint8Array): Promise<number> {
    const pane = this.panes.require(ferretId);
    const result = await this.spawn.run(
      'tmux',
      ['send-keys', '-t', pane, '-l', '--', new TextDecoder().decode(bytes)],
      {
        timeout: milliseconds(TMUX_TIMEOUT_MS),
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `ferret ${ferretId}'s pane could not be typed into: ${result.stderr.trim() || `tmux exited ${String(result.exitCode)}`}`,
      );
    return bytes.length;
  }
}
