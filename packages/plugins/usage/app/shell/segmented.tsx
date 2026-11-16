/**
 * A row of pressed/unpressed buttons: one choice of a few. Copied from today's conversation picker, where it was
 * first written; Usage's pages are its other readers, and a plugin half imports no other plugin's views.
 */
import { cn } from '@ferretry/app/ui';

/** A row of pressed/unpressed buttons: one choice of a few, like the session Mode. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChoose,
  name,
  fit = false,
}: {
  readonly label: string;
  readonly options: readonly {
    readonly id: T;
    readonly label: string;
    readonly title?: string;
    /** Shown but not choosable. */
    readonly disabled?: boolean;
  }[];
  readonly value: T;
  readonly onChoose: (value: T) => void;
  readonly name: string;
  /** Segments take the width their words need instead of sharing the row equally. */
  readonly fit?: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-segmented={name}
      className="flex min-w-0 gap-1 rounded-control border border-border bg-surface-2 p-0.5"
    >
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          title={option.title}
          disabled={option.disabled}
          data-segment={option.id}
          onClick={() => onChoose(option.id)}
          className={cn(
            'h-control-sm min-w-0 whitespace-nowrap rounded-control px-2 text-ui font-medium transition-colors',
            fit ? 'flex-auto' : 'flex-1',
            option.id === value ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
            option.disabled === true && 'cursor-not-allowed opacity-60 hover:text-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
