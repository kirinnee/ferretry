import { ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { RouteLink } from '../../shell.ts';

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

function MetaDot() {
  return (
    <span aria-hidden="true" className="fy-meta-line__dot">
      ·
    </span>
  );
}

/** A part that draws something: not null, undefined, a boolean, or a blank string. */
const present = (part: ReactNode): boolean =>
  part !== null && part !== undefined && typeof part !== 'boolean' && !(typeof part === 'string' && part.trim() === '');

/** The parts of a meta line with a dot between each pair that DRAWS something: never a leading, trailing or doubled dot. */
export function joinMeta(...parts: ReactNode[]): ReactNode {
  return parts.filter(present).map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed, ordered list of slots
    <Fragment key={index}>
      {index === 0 ? null : <MetaDot />}
      {part}
    </Fragment>
  ));
}

/** Whether a name or label says anything: a meta part is only drawn (and only gets a dot) when it does. */
export const hasWords = (text: string | null | undefined): text is string =>
  text !== null && text !== undefined && text.trim() !== '';
