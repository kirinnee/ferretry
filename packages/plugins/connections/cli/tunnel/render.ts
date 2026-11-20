import {
  TUNNEL_APPROVE_WORDS,
  TUNNEL_HELD_WORDS,
  type TunnelHeldAnswer,
  type TunnelStatusView,
} from '../../contract/index.ts';

/** What a switch reports: the daemon's own sentence, and that it took effect while the daemon ran. */
export function renderTunnelChange(view: TunnelStatusView): string {
  return [view.sentence, 'Applied without a restart.'].join('\n');
}

/** A switch that waits for the owner: nothing changed yet, and the way to approve it. */
export function renderTunnelHeld(answer: TunnelHeldAnswer): string {
  return [TUNNEL_HELD_WORDS, TUNNEL_APPROVE_WORDS, answer.view.sentence].join('\n');
}
