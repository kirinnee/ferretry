/**
 * ONE ROW of the Layout page: the name and its one-line hint, the control right beside them (not at the far edge of the
 * page), and the little preview next to the control. The preview is decoration (`aria-hidden`); what a choice does is
 * said in the visible `caption` under the control, so a screen reader hears it too. A row of chips takes the full width.
 */
import type { ReactNode } from 'react';
import './layout-rows.css';

export interface LayoutRowProps {
  readonly name: string;
  readonly hint?: string;
  /** The control; it receives the id of the name, to label itself by. */
  readonly control: (labelId: string) => ReactNode;
  /** The visible sentence under the control: what the chosen word does. */
  readonly caption?: string;
  readonly preview?: ReactNode;
  /** Takes the full width of the page (a list of chips) instead of one half of it. */
  readonly full?: boolean;
  /** Under the row: a refusal. */
  readonly children?: ReactNode;
  readonly id: string;
}

export function LayoutRow({ id, name, hint, control, caption, preview, full = false, children }: LayoutRowProps) {
  const labelId = `${id}-label`;
  return (
    <li className="fy-lr-row" data-setting-row={name} data-span={full ? 'full' : undefined}>
      <div className="fy-lr-body">
        <span className="fy-lr-label">
          <span id={labelId} className="fy-lr-name">
            {name}
          </span>
          {hint === undefined ? null : (
            <span className="fy-lr-hint" data-setting-hint="">
              {hint}
            </span>
          )}
        </span>
        <div className="fy-lr-control">
          {control(labelId)}
          {caption === undefined ? null : (
            <p className="fy-lr-caption" data-layout-caption="">
              {caption}
            </p>
          )}
        </div>
        {preview === undefined || preview === null ? null : (
          <span className="fy-lr-preview" aria-hidden="true" data-setting-preview-slot="">
            {preview}
          </span>
        )}
      </div>
      {children}
    </li>
  );
}

/** A headed group of rows; the page puts 32 px between groups and a hairline between rows, and no box in a box. */
export function LayoutGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="fy-lr-group" data-setting-group={label}>
      <h3 className="fy-lr-heading">{label}</h3>
      <ul className="fy-lr-rows">{children}</ul>
    </section>
  );
}
