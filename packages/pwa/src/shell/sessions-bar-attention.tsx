/**
 * THE ATTENTION ENTRY IN THE SIDEBAR: always reachable, never buried. The inbox is a destination of its
 * own (the swipe deck over every machine), so the bar carries a door to it at every presentation:
 *
 *   column / drawer  a row under the search — an inbox icon, "Attention", and the accent count badge; with
 *                    nothing waiting it stays, calm: "Nothing waiting", no badge, still a link;
 *   rail             an icon button with the same badge on its corner.
 *
 * The count is the open items across EVERY paired machine (the host sums the inbox), not this machine's:
 * the door is the same wherever the reader stands. It is shown only when the host gives it somewhere to
 * go (`href`). `aria-current` marks the inbox page itself.
 */

import { Inbox } from 'lucide-react';
import { RouteLink } from './route-link.tsx';
import { attentionWords } from './sessions-bar-model.ts';
import { UnreadBadge } from './unread-badge.tsx';

export function SessionsBarAttention({
  total,
  href,
  current,
  rail,
  onNavigate,
}: {
  /** Open items across every paired machine. */
  readonly total: number;
  readonly href: string;
  /** The reader is on the Attention page. */
  readonly current: boolean;
  /** The collapsed rail's icon button rather than the column's row. */
  readonly rail: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  if (rail)
    return (
      <RouteLink
        aria-current={current ? 'page' : undefined}
        aria-label={total > 0 ? `Attention — ${attentionWords(total)}` : 'Attention — nothing waiting'}
        className="fy-sbar__icon fy-sbar__attention-icon"
        data-sbar-attention=""
        data-sbar-attention-count={total}
        onNavigate={onNavigate}
        title={total > 0 ? `Attention — ${attentionWords(total)}` : 'Attention'}
        to={href}
      >
        <Inbox aria-hidden="true" size={16} />
        {total > 0 ? <UnreadBadge announce={false} className="fy-unread-badge--dot" count={total} /> : null}
      </RouteLink>
    );
  return (
    <RouteLink
      aria-current={current ? 'page' : undefined}
      className="fy-sbar__attention"
      data-sbar-attention=""
      data-sbar-attention-count={total}
      data-sbar-unread={total > 0 ? '' : undefined}
      onNavigate={onNavigate}
      to={href}
    >
      <Inbox aria-hidden="true" size={15} />
      <span className="fy-sbar__attention-name">Attention</span>
      {total > 0 ? <UnreadBadge count={total} /> : <span className="fy-sbar__attention-calm">Nothing waiting</span>}
    </RouteLink>
  );
}
