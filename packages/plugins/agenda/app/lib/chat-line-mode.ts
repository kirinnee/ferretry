/**
 * WHETHER A FERRET'S CHAT DRAWS THE AGENDA LINE, as the line panel knows it and the `ferrets.needs-you` value tells the app
 * shell. The line draws only while the ferret works in agenda mode, so the same asks must not also be counted on the side
 * toggle: the panel reports what it read (`report`), the hook publishes it per ferret (`lineShown`), and the shell draws its
 * count only when the line is NOT drawn. A ferret nothing has reported on is taken as "line shown" (no count), so a
 * count never flashes before the mode is read and is never drawn when no line panel is mounted to say otherwise.
 */

const keyOf = (daemon: string, ferret: string): string => `${daemon}\u0000${ferret}`;

export class ChatLineMode {
  private readonly off = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** The chat of `ferret` on `daemon` draws the agenda line (or has not said it does not). */
  shown(daemon: string, ferret: string): boolean {
    return !this.off.has(keyOf(daemon, ferret));
  }

  /** The line panel read the ferret's mode: `shown` is whether the chat draws the line. */
  report(daemon: string, ferret: string, shown: boolean): void {
    const key = keyOf(daemon, ferret);
    if (shown === !this.off.has(key)) return;
    if (shown) this.off.delete(key);
    else this.off.add(key);
    for (const listener of [...this.listeners]) listener();
  }

  /** The panel went away: nothing is known again. */
  forget(daemon: string, ferret: string): void {
    this.report(daemon, ferret, true);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** The one the line panel and the hook share on this device. */
export const chatLineMode = new ChatLineMode();
