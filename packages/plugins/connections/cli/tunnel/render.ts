import type { TunnelStatusView } from '../../contract/index.ts';

/** What a switch reports: the daemon's own sentence, and that it took effect while the daemon ran. */
export function renderTunnelChange(view: TunnelStatusView): string {
  return [view.sentence, 'Applied without a restart.'].join('\n');
}

/**
 * The daemon is not answering, so nothing was switched. The file is NOT written behind its back: the
 * daemon owns its document, and a change it never saw would be one it could not report or undo.
 */
export function renderTunnelDaemonDown(clientName: string, verb: string): string {
  return (
    `The daemon is not running, so nothing was changed — start it with \`${clientName} daemon start\`, ` +
    `then run \`${clientName} daemon tunnel ${verb}\` again.`
  );
}
