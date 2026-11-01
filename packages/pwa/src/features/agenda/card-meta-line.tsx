import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { RouteLink } from '../../shell/route-link.tsx';

type Hooks = Readonly<Record<`data-${string}`, string>>;

/**
 * The facts a card is about and the way to its chat, on ONE line. The facts are cut with "…" before "Open chat"
 * gives up a letter; the whole line is a place a swipe can start.
 */
export function CardMetaLine({
  children,
  chat,
  hooks,
  className,
}: {
  readonly children: ReactNode;
  readonly chat?: { readonly to: string; readonly onNavigate: (to: string) => void; readonly hooks: Hooks } | undefined;
  readonly hooks: Hooks;
  readonly className?: string | undefined;
}) {
  return (
    <div className={className === undefined ? 'fy-meta-line' : `fy-meta-line ${className}`} {...hooks}>
      <span className="fy-meta-line__facts">{children}</span>
      {chat === undefined ? null : (
        <RouteLink className="fy-meta-line__chat" onNavigate={chat.onNavigate} to={chat.to} {...chat.hooks}>
          Open chat
          <ChevronRight aria-hidden="true" size={13} />
        </RouteLink>
      )}
    </div>
  );
}

export function MetaDot() {
  return (
    <span aria-hidden="true" className="fy-meta-line__dot">
      ·
    </span>
  );
}
