/**
 * THE ONE REQUEST LINE between the command bar's "What's new" entry and the panel that owns the sheet.
 *
 * The sheet lives in Settings › This device, so the entry cannot reach it directly: it records that somebody asked, goes
 * to that page, and the panel — mounted already or on arrival — sees the request, opens the sheet and takes the request
 * off the line. One sheet, one "last viewed" record, whichever door was used.
 */
export class WhatsNewRequests {
  private asked = false;
  private readonly listeners = new Set<() => void>();

  /** An arrow so it can be handed to `useSyncExternalStore` as it is. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Whether somebody is waiting for the sheet to open. */
  readonly snapshot = (): boolean => this.asked;

  request(): void {
    this.asked = true;
    for (const listener of [...this.listeners]) listener();
  }

  /** The panel has opened the sheet for the request. */
  take(): void {
    this.asked = false;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The line this build's command bar entry and panel share. */
export const whatsNewRequests = new WhatsNewRequests();
