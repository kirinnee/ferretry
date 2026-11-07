import type { CardView } from '../../contract/index.ts';

/**
 * What the daemon said when a claim queued the card (docs/design/clash-queue.md): its own notes written after the
 * write that made the claim — the last `file-claimed` (or the `created` of a card born with claims). A claim that
 * clashed with nothing leaves no note, so nothing is printed.
 */
export function queuedLines(task: Pick<CardView, 'history'>): readonly string[] {
  const anchor = task.history.findLastIndex(event => event.type === 'file-claimed' || event.type === 'created');
  if (anchor === -1) return [];
  return task.history
    .slice(anchor + 1)
    .flatMap(event => (event.type === 'note' && event.actor.kind === 'daemon' ? [event.text] : []));
}
