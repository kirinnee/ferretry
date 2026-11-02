/**
 * The small pieces every Warden list shares: a chip, an actor mark, a ferret link and the report icon.
 * Render-only; the words and colours come from the vocabulary and the models.
 */

import type { SessionView, WardenActor } from '@ferretry/protocol';
import { FileText, LoaderCircle } from 'lucide-react';

import { sessionDisplayName } from '../../components/session-top-bar.tsx';
import { displayCallsign, shortSessionId } from '../../lib/callsign.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { Badge } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { ACTOR_DOT, type WardenChip } from './warden-vocabulary.ts';

export function WardenChipBadge({
  chip,
  title,
  wrap = false,
}: {
  readonly chip: WardenChip;
  readonly title?: string;
  readonly wrap?: boolean;
}) {
  return (
    <Badge
      tone={chip.tone}
      className={cn(
        wrap ? 'min-w-0 max-w-full !whitespace-normal break-words' : 'shrink-0 whitespace-nowrap',
        '!normal-case !tracking-normal',
      )}
      {...(title === undefined ? {} : { title })}
    >
      {chip.busy === true && (
        <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      {chip.label}
    </Badge>
  );
}

/** One actor, in its one colour: a dot and a name. The dot is decoration, the name carries the meaning. */
export function ActorMark({
  actor,
  label,
  title,
  className,
}: {
  readonly actor: WardenActor;
  readonly label: string;
  readonly title?: string;
  readonly className?: string;
}) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-xs whitespace-nowrap text-meta text-fg-soft', className)}
      data-actor={actor}
      {...(title === undefined ? {} : { title })}
    >
      <span aria-hidden="true" className={cn('inline-block h-2 w-2 rounded-full', ACTOR_DOT[actor])} />
      {label}
    </span>
  );
}

/** The ferret's name as the page shows it everywhere: its session's name, else its callsign, else its id. */
export const ferretName = (
  session: SessionView | undefined,
  fallback: { readonly teammate?: string; readonly label?: string; readonly sessionId: string },
): string =>
  session === undefined
    ? displayCallsign(fallback.teammate) || fallback.label || shortSessionId(fallback.sessionId)
    : sessionDisplayName(session);

export function FerretLink({
  connection,
  sessionId,
  name,
  onNavigate,
  className,
}: {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly name: string;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly className?: string;
}) {
  return (
    <RouteLink
      to={daemonSessionPath(connection.daemonId, sessionId)}
      {...(onNavigate === undefined ? {} : { onNavigate })}
      className={cn(
        'flex min-w-0 items-center !min-h-0 !min-w-0 text-cell font-semibold leading-base text-fg no-underline hover:underline',
        className,
      )}
    >
      <span className="truncate">{name}</span>
    </RouteLink>
  );
}

/** A small icon button; the 44px touch target is a phone-only floor. */
export function ReportButton({ onClick, className }: { readonly onClick: () => void; readonly className?: string }) {
  return (
    <button
      type="button"
      aria-label="Open report"
      title="Open report"
      className={cn(
        'inline-flex !min-h-7 min-w-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg sm:!min-h-0 sm:min-w-0 sm:p-1',
        className,
      )}
      onClick={onClick}
    >
      <FileText size={14} aria-hidden="true" />
    </button>
  );
}

/** A section heading with its count, in the page's one small-caps-free heading style. */
export function SectionTitle({
  id,
  title,
  count,
}: {
  readonly id: string;
  readonly title: string;
  readonly count?: number;
}) {
  return (
    <h3 id={id} className="m-0 flex items-baseline gap-sm text-ui font-semibold text-fg">
      {title}
      {count !== undefined && <span className="text-meta font-normal text-faint">{count}</span>}
    </h3>
  );
}
