/**
 * `ferret.toolbar` › `status` — how this ferret is doing, as a shape and a word. A parked ferret says what it waits
 * for. (Whose turn it is and what a stopped-for-input ferret is blocked on belong to Conversation's turn watcher; the
 * ferret record carries neither.)
 */

import type { FerretSummary } from '../../../contract/index.ts';
import { StatusMark, statusMark } from '../../lib/status-mark.tsx';

/** The word for a mark: its class and detail, the person's words rather than the daemon's. */
const statusWord = (ferret: FerretSummary): string => {
  const info = statusMark(ferret);
  const [, detail] = info.label.split(' — ');
  return detail ?? info.label;
};

export function FerretStatus({ ferret, compact }: { readonly ferret: FerretSummary; readonly compact: boolean }) {
  return (
    <span
      className="fy-ferret-status"
      data-ferret-state={ferret.state}
      data-ferret-status={statusMark(ferret).klass}
      title={statusMark(ferret).label}
    >
      <StatusMark ferret={ferret} />
      <span className={compact ? 'sr-only' : 'fy-ferret-status__word'}>{statusWord(ferret)}</span>
    </span>
  );
}
