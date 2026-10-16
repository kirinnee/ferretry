/**
 * Info's rows: `label — value`, the value in mono for a path or an id, a copy button beside it, and a
 * small `?` on the label that opens a one-line explainer under the row. One component for every tab,
 * so six tabs read as one panel.
 */

import { type ReactNode, useId, useState } from 'react';
import { type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';

export function InfoRow({
  label,
  hint,
  mono = false,
  copy,
  write,
  children,
}: {
  readonly label: string;
  /** The explainer behind `?`. */
  readonly hint?: string;
  readonly mono?: boolean;
  /** The text the copy button writes. */
  readonly copy?: string;
  readonly write?: ClipboardWriter;
  readonly children: ReactNode;
}) {
  const hintId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="fy-info-row" data-info-row={label}>
      <dt className="fy-info-row__label">
        <span>{label}</span>
        {hint === undefined ? null : (
          <button
            aria-controls={hintId}
            aria-expanded={open}
            aria-label={`What is ${label}?`}
            className="fy-info-row__hint-toggle"
            data-info-hint-toggle=""
            onClick={() => setOpen(value => !value)}
            type="button"
          >
            ?
          </button>
        )}
      </dt>
      <dd className="fy-info-row__value" data-mono={mono ? '' : undefined}>
        <span className="fy-info-row__text">{children}</span>
        {copy === undefined || write === undefined ? null : <CopyButton label={`Copy ${label}`} text={copy} write={write} />}
      </dd>
      {hint === undefined || !open ? null : (
        <p className="fy-info-row__hint" id={hintId} role="note">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A labelled run of rows inside a tab: "Login quota · claude-default". */
export function InfoSection({ title, children }: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <section className="fy-info-section">
      {title === undefined ? null : <h3 className="fy-info-section__title">{title}</h3>}
      <dl className="fy-info-rows">{children}</dl>
    </section>
  );
}

/** A small chip: a scope, a state, a warning. */
export function InfoChip({
  tone = 'muted',
  children,
}: {
  readonly tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'err';
  readonly children: ReactNode;
}) {
  return (
    <span className="fy-info-chip" data-tone={tone}>
      {children}
    </span>
  );
}

/** A percentage as a bar, its value said as a meter. */
export function InfoMeter({ label, percent }: { readonly label: string; readonly percent: number }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span className="fy-info-meter-row">
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be drawn from the theme tokens on every engine */}
      <span
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        className="fy-info-meter"
        data-high={value >= 85 ? '' : undefined}
        role="meter"
      >
        <span style={{ width: `${value}%` }} />
      </span>
      <strong>{value}%</strong>
    </span>
  );
}

/** A note where a tab has nothing yet, or cannot know. */
export function InfoNote({ children }: { readonly children: ReactNode }) {
  return <p className="fy-info-note">{children}</p>;
}
