/**
 * The small pieces the Profiles and Components pages are drawn with: a section, a note, a row that
 * opens something, and a component's badges (the prototype's `sec`, `note`, `row`
 * and `compBadges`). One set, so the two tabs read as one surface.
 */

import { ChevronRight, Lock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Badge } from '../../../shell/primitives.tsx';
import type { ComponentBadge } from './component-model.ts';

export function Section({ title, children, spot }: { title: string; children: ReactNode; spot?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-catalog-section={spot ?? title}>
      <h4 className="kt-label m-0">{title}</h4>
      {children}
    </section>
  );
}

const NOTE_TONE = {
  info: 'border-accent-border bg-accent-soft',
  warn: 'border-warn-border bg-warn-bg',
  danger: 'border-err-border bg-err-bg',
} as const;

export function CatalogNote({
  tone,
  title,
  children,
  actions,
  spot,
  role,
}: {
  tone: keyof typeof NOTE_TONE;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  spot?: string;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1 rounded-control border p-panel', NOTE_TONE[tone])}
      data-catalog-note={spot ?? tone}
      role={role}
    >
      <p className="m-0 break-words text-row font-semibold text-fg">{title}</p>
      {children === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1 break-words text-cell leading-base text-fg">{children}</div>
      )}
      {actions === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="m-0 text-cell leading-base text-muted">{children}</p>;
}

export function Prose({ children }: { children: ReactNode }) {
  return <p className="m-0 text-cell leading-base text-fg">{children}</p>;
}

/** A list of rows inside one panel. */
export function RowList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="kt-panel m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">
      {children}
    </ul>
  );
}

const ROW = 'flex min-h-control w-full min-w-0 items-center gap-3 px-panel py-2 text-left';

/** A row that opens a page. */
export function OpenRow({
  title,
  sub,
  aside,
  badges,
  mono = false,
  onOpen,
  data,
  footer,
}: {
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  badges?: ReactNode;
  mono?: boolean;
  onOpen: () => void;
  data?: Record<`data-${string}`, string>;
  /** Controls of the row's own, under the part that opens the page — never inside it. */
  footer?: ReactNode;
}) {
  return (
    <li className="min-w-0">
      <button type="button" className={cn(ROW, 'transition-colors hover:bg-surface-2')} onClick={onOpen} {...data}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('break-words text-row font-semibold text-fg', mono && 'font-mono')}>{title}</span>
          {badges}
          {sub === undefined ? null : <span className="break-words text-cell text-muted">{sub}</span>}
        </span>
        {aside}
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
      </button>
      {footer === undefined ? null : <div className="min-w-0 px-panel pb-2">{footer}</div>}
    </li>
  );
}

/** A row that only shows something. */
export function PlainRow({ title, sub, mono = false }: { title: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <li className={ROW}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('break-words text-row text-fg', mono && 'font-mono')}>{title}</span>
        {sub === undefined ? null : <span className="break-words text-cell text-muted">{sub}</span>}
      </span>
    </li>
  );
}

export function ComponentBadges({ badges }: { badges: readonly ComponentBadge[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-component-badges="">
      {badges.map(badge => (
        <Badge
          key={badge.text}
          tone={badge.tone}
          className="inline-flex h-auto max-w-full items-center gap-1 !whitespace-normal"
        >
          {badge.warn ? <TriangleAlert size={12} aria-hidden="true" className="shrink-0" /> : null}
          {badge.lock ? <Lock size={12} aria-hidden="true" className="shrink-0" /> : null}
          <span className="min-w-0 break-words">{badge.text}</span>
        </Badge>
      ))}
    </span>
  );
}

/** A page inside a tab: ‹ Back, its title and what it is. */
export function PageHead({
  title,
  sub,
  mono = false,
  onBack,
}: {
  title: string;
  sub?: string;
  mono?: boolean;
  onBack?: () => void;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-1">
      {onBack === undefined ? null : (
        <button
          type="button"
          data-catalog-back=""
          onClick={onBack}
          className="kt-btn kt-btn--sm kt-btn--flush-start self-start"
          data-variant="ghost"
        >
          ‹ Back
        </button>
      )}
      <h3
        className={cn(
          'm-0 break-words font-display text-title font-semibold tracking-display text-fg',
          mono && 'font-mono',
        )}
      >
        {title}
      </h3>
      {sub === undefined ? null : <p className="m-0 text-cell text-muted">{sub}</p>}
    </header>
  );
}

/** The one sentence a page shows instead of breaking when its read failed. */
export function ReadFailed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <CatalogNote
      tone="warn"
      title={reason}
      role="status"
      spot="read-failed"
      actions={
        <button type="button" className="kt-btn kt-btn--sm" onClick={onRetry} data-catalog-retry="">
          Try again
        </button>
      }
    />
  );
}

/** A row that opens a page on another tab, by its address. */
export function LinkRow({
  title,
  sub,
  href,
  mono = false,
}: {
  title: ReactNode;
  sub?: ReactNode;
  href: string;
  mono?: boolean;
}) {
  return (
    <li className="min-w-0">
      <a href={href} className={cn(ROW, 'no-underline transition-colors hover:bg-surface-2')} data-catalog-link={href}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('break-words text-row font-semibold text-fg', mono && 'font-mono')}>{title}</span>
          {sub === undefined ? null : <span className="break-words text-cell text-muted">{sub}</span>}
        </span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
      </a>
    </li>
  );
}
