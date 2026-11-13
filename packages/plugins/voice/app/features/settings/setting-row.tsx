/**
 * The compact Settings row kit: one row per setting, grouped in titled cards.
 *
 *   SettingGroup   a small uppercase label over one `kt-groupcard` list (the Machine tab's look)
 *   SettingRow     name + one-line hint on the left, the control on the right, an optional (i) that opens
 *                  the long explanation, and an optional panel under the row (a legend, a list, a sub-view)
 *   SettingSwitch  the on/off control for a row
 *   Segmented      a `role="radiogroup"` pill control, built from the theme's Auto / Light / Dark one
 *
 * A row that is a setting carries `id="settings-<settingId>"`, `data-setting-id` and `tabIndex={-1}`, so a
 * palette deep link can scroll to and focus it. Long text is never deleted: it moves behind the (i), a real
 * `aria-expanded` disclosure like `fleet/machine/switch-row.tsx`.
 *
 * On a phone (`max-md`) a `wide` control (a segmented one) wraps under the name at full width; a switch or
 * small button stays on the name's line. Every target keeps the 44px touch floor.
 */

import { Info } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../../shell-voice.ts';
/** A deep-link target id; the shell's settings catalog owns the closed set. */
type SettingId = string;

export interface SettingRowProps {
  /** The setting this row is, which makes it a deep-link target. */
  readonly settingId?: SettingId;
  readonly name: string;
  /** One short, true line under the name. */
  readonly hint?: ReactNode;
  /** The long text behind the (i). */
  readonly explanation?: ReactNode;
  /** The control, on the right. */
  readonly control?: (labelId: string) => ReactNode;
  /** A wide control (segmented) wraps under the name on a phone. */
  readonly wide?: boolean;
  /** Content under the row that is always shown, for example a list the control reveals. */
  readonly children?: ReactNode;
  /** `data-*` attributes on the row itself, for a row whose state a test or a stylesheet reads. */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
}

export function SettingRow({
  settingId,
  name,
  hint,
  explanation,
  control,
  wide = false,
  children,
  dataAttributes,
}: SettingRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const labelId = `${id}-label`;
  const hasExplanation = explanation !== undefined && explanation !== null;
  const info = hasExplanation ? (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={`${id}-more`}
      aria-label={`More about ${name}`}
      data-setting-info=""
      onClick={() => setOpen(value => !value)}
      className={cn(
        'ml-auto inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border-0 bg-transparent p-0 hover:text-fg',
        open ? 'text-accent' : 'text-muted',
      )}
    >
      <Info size={16} aria-hidden="true" />
    </button>
  ) : null;
  return (
    <li
      {...(settingId === undefined
        ? {}
        : { id: `settings-${settingId}`, 'data-setting-id': settingId, tabIndex: -1 as const })}
      data-setting-row={name}
      {...dataAttributes}
      className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-panel pr-1">
        <span className={cn('flex min-w-0 flex-1 flex-col', wide ? 'basis-40 max-md:basis-full' : 'basis-40')}>
          <span id={labelId} className="text-ui font-semibold text-fg">
            {name}
          </span>
          {hint === undefined ? null : (
            <span className="text-meta leading-tight text-muted" data-setting-hint="">
              {hint}
            </span>
          )}
        </span>
        <span
          className={cn(
            'flex min-w-0 items-center gap-1',
            !wide && 'shrink-0',
            // `wide` fills the phone's width under the name; the (i) stays beside it.
            wide && 'max-md:basis-full',
          )}
          data-setting-controls=""
        >
          {control?.(labelId)}
          {/* The (i) is always the last thing on the row, in a slot of its own: a row with no explanation keeps the
              slot empty, so every (i) and every control end in the same two columns down a card. */}
          {info ??
            (control === undefined ? null : (
              <span aria-hidden="true" className="ml-auto min-h-[44px] w-[44px] shrink-0" />
            ))}
        </span>
      </div>
      {open && hasExplanation ? (
        <div id={`${id}-more`} className="px-panel pb-3 text-cell leading-base text-muted" data-setting-explanation="">
          {explanation}
        </div>
      ) : null}
      {children}
    </li>
  );
}

export interface SettingSwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly labelledBy: string;
  readonly disabled?: boolean;
}

export function SettingSwitch({ checked, onChange, labelledBy, disabled = false }: SettingSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative h-5 w-9 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}
