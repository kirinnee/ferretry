import type { ReactNode } from 'react';
import { cn } from '../../shell.ts';

/** The small on/off glyph every switch here draws: a track and a knob, never wider than it is tall twice over. */
export function SwitchGlyph({ checked }: { readonly checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
        checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </span>
  );
}

/**
 * A compact toggle TILE: an icon, the name, one line, and the switch. It is one surface (no box inside it), so a grid of
 * them reads as a grid, not as stacked full-width rows. The whole tile is the switch.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  icon,
  title,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  /** The one line under the name. */
  readonly description: string;
  readonly icon?: ReactNode;
  /** The full wording, kept for a hover and for assistive tech when the line above is shortened. */
  readonly title?: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[56px] w-full items-center gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {icon === undefined ? null : (
        <span aria-hidden="true" className={cn('flex shrink-0', checked ? 'text-accent' : 'text-muted')}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-semibold text-fg">{label}</span>
        <span className="block truncate text-meta leading-base text-muted">{description}</span>
      </span>
      <SwitchGlyph checked={checked} />
    </button>
  );
}
