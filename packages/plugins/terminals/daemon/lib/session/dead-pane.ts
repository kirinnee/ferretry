/**
 * What a ferret's DEAD pane last showed, for a plugin that must explain why a start failed (Terminals' `deadPaneText`:
 * Runtimes' offline-failure sentence for a Codex ferret).
 *
 * WHICH PANE. The one Terminals registered for the ferret, by its exact id. No attach proof is asked: a dead pane has
 * no process to match, which is the point. The read itself (`screen`) is the runner's own `lastScreen`, which answers
 * only for a ferret's own session and reads nothing but the visible screen.
 *
 * Total and read only: a ferret with no pane, a pane that cannot be read and a read a hold refused all answer `''`,
 * which says nothing and is not an error. The text it returns is already masked by `screen`.
 */
export interface DeadPanePorts {
  /** The pane Terminals registered for this ferret, or `undefined` when it has none. */
  paneOf(ferret: string): Promise<{ readonly paneId: string } | undefined>;
  /** The masked visible screen of that pane, read as an act on it; `undefined` when it could not be read or a hold refused. */
  screen(paneId: string): Promise<string | undefined>;
}

/** The dead pane's last screen (masked), or `''` when it cannot be said. Never throws. */
export async function deadPaneText(ports: DeadPanePorts, ferret: string): Promise<string> {
  try {
    const pane = await ports.paneOf(ferret);
    if (pane === undefined) return '';
    return (await ports.screen(pane.paneId)) ?? '';
  } catch {
    return '';
  }
}
