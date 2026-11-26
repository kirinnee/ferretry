import type { TmuxCommandPort } from '../../tmux/contracts.ts';

/** How long after a person's last key a pane is theirs: the daemon's own writes wait it out. */
export const TYPING_HOLD_MS = 5_000;

/**
 * What `list-clients` is asked of each client: when it last had input, when it attached, whether it is a control-mode
 * client (the daemon's own), and which pane it is looking at (in this format `pane_id` is the client's ACTIVE pane).
 */
const CLIENT_FORMAT = '#{client_activity}|#{client_created}|#{client_control_mode}|#{pane_id}';

/**
 * WHETHER A PERSON IS TYPING INTO A PANE, read without a single tmux hook (the owner's rule).
 *
 * Two doors lead a person's keys into a ferret's pane, and each is seen where it already is:
 *
 *   * the app's Console: `SessionConsoleService.write` calls {@link pressed} BEFORE it sends the bytes, so a key is
 *     never delayed by the hold and the hold already stands when the pane could be read;
 *   * `tmux attach`: tmux stamps each attached client with the second of its last input (`client_activity`). It cannot
 *     say WHICH pane a key reached, so the nearest honest reading is taken: a stamp counts for the pane the client is
 *     looking at (its active pane), never for a sibling, and only when it is LATER than the second the client attached
 *     (attaching is not typing). A key in the same second as the attach is not seen; the stamp is whole seconds.
 *     Control-mode clients are the daemon's own and never count.
 *
 * Both doors end on the daemon's own clock: a stamp from the future is no hold (tmux's clock is not ours to trust), and
 * a stamp holds for {@link TYPING_HOLD_MS} from when this daemon FIRST SAW it, so no stamp, whatever it says, holds a
 * pane for longer than that after it was last observed. The hold is per PANE and only ever makes the daemon's writes
 * wait: nothing here sits on the path of a person's key.
 */
export class TypingHold {
  readonly #pressedAt = new Map<string, number>();
  /** The attach door, per pane: the stamp last read and when this daemon first read it. */
  readonly #seen = new Map<string, { readonly stamp: number; readonly at: number }>();

  constructor(private readonly nowMs: () => number) {}

  /** A person's keys are about to reach this pane. */
  pressed(paneId: string): void {
    this.#pressedAt.set(paneId, this.nowMs());
  }

  /** Whether a person has typed into this pane (by either door) within {@link TYPING_HOLD_MS}. */
  async held(tmux: Pick<TmuxCommandPort, 'execute'>, paneId: string, session: string): Promise<boolean> {
    if (this.#pressedWithin(paneId)) return true;
    const listed = await tmux.execute(['list-clients', '-t', session, '-F', CLIENT_FORMAT]).catch(() => undefined);
    // A key the Console took while tmux was being asked is the person's too.
    if (this.#pressedWithin(paneId)) return true;
    const stamp = listed === undefined || listed.code !== 0 ? undefined : this.#latestKey(listed.stdout, paneId);
    if (stamp === undefined) {
      this.#seen.delete(paneId);
      return false;
    }
    const now = this.nowMs();
    const first = this.#seen.get(paneId);
    const seen = first?.stamp === stamp ? first : { stamp, at: now };
    this.#seen.set(paneId, seen);
    return now >= seen.at && now - seen.at < TYPING_HOLD_MS;
  }

  #pressedWithin(paneId: string): boolean {
    const at = this.#pressedAt.get(paneId);
    if (at === undefined) return false;
    const age = this.nowMs() - at;
    if (age >= 0 && age < TYPING_HOLD_MS) return true;
    this.#pressedAt.delete(paneId);
    return false;
  }

  /** The newest input second of a person's client looking at `paneId`, that is after it attached and not in the future. */
  #latestKey(listing: string, paneId: string): number | undefined {
    const now = this.nowMs();
    let latest: number | undefined;
    for (const line of listing.split('\n')) {
      const [activity, created, control, pane] = line.split('|');
      const at = Number(activity);
      if (control !== '0' || pane !== paneId || !Number.isFinite(at) || !(at > Number(created))) continue;
      const age = now - at * 1_000;
      if (age >= 0 && age < TYPING_HOLD_MS && (latest === undefined || at > latest)) latest = at;
    }
    return latest;
  }
}
