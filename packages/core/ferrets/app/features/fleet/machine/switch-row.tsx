/**
 * The Agents tab's on/off settings as compact rows: the title and a switch on one line, an optional short
 * hint under the title, and the longer explanation behind an (i) button. The explanation is the old
 * description — including every safety sentence — so it moves out of the way, never out of reach: the
 * button is a real `aria-expanded` disclosure, reachable by keyboard and read out by a screen reader.
 */

import { Info } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '@ferretry/app';

interface SwitchRowProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  /** One short line under the title; leave it out when the title says enough. */
  readonly hint?: string;
  /** What the switch covers, in full: shown when the (i) is open. */
  readonly explanation: string;
  readonly disabled?: boolean;
}

export function SwitchRow({ checked, onChange, label, hint, explanation, disabled = false }: SwitchRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li data-switch-row={label} className="min-w-0">
      <div className="flex min-h-11 min-w-0 items-center gap-1 pl-panel pr-1">
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-label`} className="truncate text-ui font-semibold text-fg">
            {label}
          </span>
          {hint === undefined ? null : (
            <span className="truncate text-meta leading-tight text-muted" data-switch-hint="">
              {hint}
            </span>
          )}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-more`}
          aria-label={`More about ${label}`}
          data-switch-info=""
          onClick={() => setOpen(value => !value)}
          className={cn(
            'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border-0 bg-transparent p-0 hover:text-fg',
            open ? 'text-accent' : 'text-muted',
          )}
        >
          <Info size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={`${id}-label`}
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
      </div>
      {open ? (
        <p id={`${id}-more`} className="m-0 px-panel pb-3 text-cell leading-base text-muted" data-switch-explanation="">
          {explanation}
        </p>
      ) : null}
    </li>
  );
}

/** A titled run of switch rows in one card, as the Machine tab's other lists are. */
export function SwitchList({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <ul className="kt-groupcard m-0 list-none p-0" aria-label={label} data-switch-list="">
      {children}
    </ul>
  );
}
