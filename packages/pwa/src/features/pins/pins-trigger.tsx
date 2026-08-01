import { Pin } from 'lucide-react';

/** The compact session-header entry point for the daemon-scoped pins ledger. */
export const pinsTriggerLabel = (count: number): string => (count > 0 ? `Pins (${count})` : 'Pins');

export interface PinsTriggerProps {
  readonly id: string;
  readonly count: number;
  /** Receives the trigger element so a sheet host can restore focus on close. */
  readonly onClick: (opener?: HTMLElement) => void;
  readonly expanded: boolean;
  readonly controls?: string;
}

/**
 * Ported from kteam's PinSheet trigger: a 44px header control adds no vertical
 * cost to the transcript and exposes the count without relying on colour.
 */
export function PinsTrigger({ id, count, onClick, expanded, controls }: PinsTriggerProps) {
  const label = pinsTriggerLabel(count);
  return (
    <button
      id={id}
      type="button"
      onClick={event => onClick(event.currentTarget)}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      title={label}
      className="relative inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border p-0 text-muted hover:border-accent-border hover:text-fg"
    >
      <Pin size={16} aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full border border-surface bg-accent px-1 text-[10px] font-semibold leading-[15px] text-accent-fg"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
