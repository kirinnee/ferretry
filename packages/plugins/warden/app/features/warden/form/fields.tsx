/**
 * The Warden form's small controls (r10 S6): a switch, a checkbox with its box beside its words, a segmented
 * choice with no visible radio dot, a number field whose input sits on the right edge, and a section.
 * Layout lives in `warden-form.css`; nothing here knows the Warden's config.
 */

import { type ReactNode, useId } from 'react';
import type { PickerAccount } from '../../../lib/account-picker.ts';
import './warden-form.css';

/** A login in the picker, in the words the Runtimes tab shows for it ("Claude · your terminal sign-in"); the stored name only when the runtime is gone. */
export const loginLabel = (agent: string, runtimes: readonly PickerAccount[]): string => {
  const runtime = runtimes.find(candidate => candidate.wrapper === agent);
  if (runtime === undefined) return agent;
  return runtime.displayName;
};

/** A cleared number field is `NaN` until fixed; the model reports it rather than a silent zero. */
const numberFrom = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

/** A heading and its rows. No box: the page's spacing and the hairlines between rows do the grouping. */
export function Section({
  title,
  note,
  children,
}: {
  readonly title?: string;
  readonly note?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="fy-wf-section">
      {title !== undefined && <h3>{title}</h3>}
      {children}
      {note !== undefined && <p className="fy-wf-note">{note}</p>}
    </section>
  );
}

/** Rows split by hairlines. */
export function Rows({ children }: { readonly children: ReactNode }) {
  return <div className="fy-wf-rows">{children}</div>;
}

export function NumberField({
  label,
  value,
  error,
  min,
  max,
  step,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly error: string | undefined;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (next: number) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="fy-wf-num">
      {label}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        aria-invalid={error === undefined ? undefined : true}
        value={Number.isFinite(value) ? value : ''}
        onChange={event => onChange(numberFrom(event.target.value))}
      />
      {error !== undefined && <span className="fy-wf-num__error">{error}</span>}
    </label>
  );
}

/** Number fields stacked on one input edge. */
export function Fields({ children }: { readonly children: ReactNode }) {
  return <div className="fy-wf-fields">{children}</div>;
}

export function Check({
  checked,
  label,
  detail,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="fy-wf-check">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span className="fy-wf-check__words">
        <span className="fy-wf-check__label">{label}</span>
        {detail !== undefined && <span className="fy-wf-check__detail">{detail}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  format,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly format: (option: T) => string;
  readonly onChange: (next: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="fy-wf-seg">
      <legend className="fy-wf-legend">{label}</legend>
      <div className="fy-wf-seg__group">
        {options.map(option => (
          <label key={option} className="fy-wf-seg__opt" data-selected={option === value}>
            <input type="radio" name={name} checked={option === value} onChange={() => onChange(option)} />
            {format(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * An on/off box that is SAVED WITH THE FORM. It is a checkbox, not a switch: a switch takes effect the moment it moves, and nothing here
 * does until the Save bar is pressed (Material 3: a switch applies at once; Shopify: a checkbox is saved with its form). The visible
 * words ARE its name, so it never floats at the edge of a card unlabelled.
 */
export function Switch({
  on,
  label,
  shownLabel = label,
  onToggle,
}: {
  readonly on: boolean;
  /** Its accessible name. */
  readonly label: string;
  /** The words drawn beside the box, when the card around it already names the thing ("On" in a card titled "Jev"). */
  readonly shownLabel?: string;
  readonly onToggle: (next: boolean) => void;
}) {
  return (
    // `.x.x` doubles the selector for the page-wide `.fy-page label` rule, as the other labels of this form do.
    <label className="fy-wf-switch fy-wf-switch -mx-2 flex min-h-[44px] shrink-0 cursor-pointer items-center gap-sm rounded-control px-2 text-ui font-semibold text-fg">
      <input
        type="checkbox"
        aria-label={label}
        checked={on}
        onChange={event => onToggle(event.target.checked)}
        className="m-0 h-5 w-5 shrink-0 cursor-pointer"
      />
      {shownLabel}
    </label>
  );
}
