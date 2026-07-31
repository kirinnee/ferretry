/**
 * tmux argument vectors for picker cleanup, scoped to ONE pane.
 *
 * The rest of the daemon addresses tmux by session name, which is right for
 * launching and stopping but wrong here: cleanup must act on the exact pane it
 * inspected, and a session name re-resolves to whatever pane is active when each
 * command runs. So cleanup resolves a pane id once and every subsequent command
 * targets that id.
 *
 * These are argument builders, not commands: the executable and the private
 * socket are the adapter's business, and no vector here may begin with a server
 * option.
 */

/** `#{pane_id}` of the session's active pane, resolved once at cleanup start. */
export function activePaneIdArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', session, '#{pane_id}'];
}

/** The visible pane only. History would drag old picker screens into the capture
 *  that classification then has to rule out. */
export function capturePaneIdArguments(paneId: string): readonly string[] {
  return ['capture-pane', '-p', '-t', paneId];
}

/** Cursor position, which is what distinguishes an idle prompt from a rendered
 *  one the harness is not waiting at. */
export function paneIdCursorArguments(paneId: string): readonly string[] {
  return ['display-message', '-p', '-t', paneId, '#{cursor_x}|#{cursor_y}'];
}

/** Escape is a failure-only teardown key: selection is always digits, so an
 *  Escape can never choose anything. */
export function dismissPaneIdArguments(paneId: string): readonly string[] {
  return ['send-keys', '-t', paneId, 'Escape'];
}

/** Parse `#{cursor_x}|#{cursor_y}`, refusing anything that is not two finite
 *  numbers — a partial read must not be mistaken for column zero. */
export function parsePaneCursor(value: string): { readonly x: number; readonly y: number } | undefined {
  const [rawX, rawY] = value.trim().split('|');
  const x = Number(rawX);
  const y = Number(rawY);
  if (rawX === undefined || rawY === undefined) return undefined;
  if (rawX.trim().length === 0 || rawY.trim().length === 0) return undefined;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}
