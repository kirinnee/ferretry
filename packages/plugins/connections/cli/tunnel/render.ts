import type { TunnelStatusView } from '../../contract/index.ts';

/** What a switch reports: the daemon's own sentence, and that it took effect while the daemon ran. */
export function renderTunnelChange(view: TunnelStatusView): string {
  return [view.sentence, 'Applied without a restart.'].join('\n');
}
