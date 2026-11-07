import { cn } from '../../shell.ts';

/** A switch row: its label and what it does, pressed on or off (copied from today's notification settings). */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="min-w-0">
        <span className={cn('block text-ui font-semibold', checked ? 'text-accent' : 'text-fg')}>{label}</span>
        <span className="block text-meta leading-base text-muted">{description}</span>
      </span>
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
    </button>
  );
}
