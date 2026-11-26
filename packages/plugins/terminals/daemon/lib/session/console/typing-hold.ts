import type { TmuxCommandPort } from '../../tmux/contracts.ts';

/** How long after a person's last key a pane is theirs: the daemon's own writes wait it out. */
export const TYPING_HOLD_MS = 5_000;

/** What `list-clients` is asked: when each client last had input, and whether it is a control-mode client (the daemon's own). */
const CLIENT_FORMAT = '#{client_activity}|#{client_control_mode}';

/**
 * WHETHER A PERSON IS TYPING INTO A PANE, read without a single tmux hook (the owner's rule).
 *
 * Two doors lead a person's keys into a ferret's pane, and each is seen where it already is:
 *
 *   * the app's Console: `SessionConsoleService.write` calls {@link pressed} BEFORE it sends the bytes, so a key is
 *     never delayed by the hold and the hold already stands when the pane could be read;
 *   * `tmux attach`: tmux itself stamps each attached client with the second of its last input (`client_activity`),
 *     read with one `list-clients` at the moment the pane is observed. Control-mode clients are the daemon's own and
 *     never count, and tmux's stamp is whole seconds, so that door holds between 4 and 5 s.
 *
 * The hold is per PANE (a map by pane id, and `list-clients` of that pane's own session), never global, and it only
 * ever makes the daemon's writes wait: nothing here sits on the path of a person's key.
 */
export class TypingHold {
  readonly #pressedAt = new Map<string, number>();

  constructor(private readonly nowMs: () => number) {}

  /** A person's keys are about to reach this pane. */
  pressed(paneId: string): void {
    this.#pressedAt.set(paneId, this.nowMs());
  }

  /** Whether a person has typed into this pane (by either door) within {@link TYPING_HOLD_MS}. */
  async held(tmux: Pick<TmuxCommandPort, 'execute'>, paneId: string, session: string): Promise<boolean> {
    const now = this.nowMs();
    const at = this.#pressedAt.get(paneId);
    if (at !== undefined) {
      if (now - at < TYPING_HOLD_MS) return true;
      this.#pressedAt.delete(paneId);
    }
    const listed = await tmux.execute(['list-clients', '-t', session, '-F', CLIENT_FORMAT]).catch(() => undefined);
    if (listed === undefined || listed.code !== 0) return false;
    return listed.stdout.split('\n').some(line => {
      const [seconds, control] = line.split('|');
      const at = Number(seconds);
      return control === '0' && Number.isFinite(at) && at > 0 && now - at * 1_000 < TYPING_HOLD_MS;
    });
  }
}
