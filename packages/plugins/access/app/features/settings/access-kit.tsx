/**
 * THE PIECES EVERY ACCESS SETTINGS TAB SHARES (r10 S10).
 *
 *   AccessTab    the tab's one container: `container-type: inline-size`, so every layout below answers to the width of the
 *                SETTINGS PANEL (at a 768px window the real panel is about 212px), never to the window.
 *   Notice       a sentence the person must read (a limit, a failure, a refusal): tinted, with a 3px bar on its edge and NO
 *                box around it, so it never makes a box inside a box.
 *   LabelledSwitch   the real `SettingSwitch` with a short visible name beside it, inside a span that carries the test and
 *                style marks (`data-device-grant`, `data-security-switch`, …) the daemon-facing code reads.
 *   ActionRow    a row of auto-width buttons that wraps; never a full-width button.
 *
 * The group and row kit itself (`SettingGroup`, `SettingRow`, `Segmented`, `SettingSwitch`) is `@ferretry/app`'s.
 */

import { SettingSwitch } from '@ferretry/app';
import { type HTMLAttributes, type ReactNode, useId } from 'react';
import { cn } from '../../shell-pairing.ts';
import './access-kit.css';

export function AccessTab({ children, name }: { readonly children: ReactNode; readonly name: string }) {
  return (
    <div className="fy-acc" data-access-tab={name}>
      {children}
    </div>
  );
}

export type NoticeTone = 'warn' | 'err' | 'info' | 'ok';

export interface NoticeProps extends Omit<HTMLAttributes<HTMLElement>, 'className'> {
  readonly tone?: NoticeTone;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** `data-*` marks on the notice itself. */
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}

export function Notice({ tone = 'info', icon, children, className, marks, ...rest }: NoticeProps) {
  return (
    <p {...rest} {...marks} className={cn('fy-acc-notice', className)} data-tone={tone}>
      {icon === undefined ? null : (
        <span className="fy-acc-notice__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="fy-acc-notice__text">{children}</span>
    </p>
  );
}

export interface LabelledSwitchProps {
  /** The short word beside the switch ("Use", "Configure"). */
  readonly label: string;
  /** The whole name a screen reader hears ("Files — Use"), with the reason it cannot be pressed when there is one. */
  readonly accessibleName: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** `false` when the row beside the switch already names it. */
  readonly showLabel?: boolean;
  readonly onChange: (next: boolean) => void;
  /** `data-*` marks on the span that holds the switch. */
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}

export function LabelledSwitch({
  label,
  accessibleName,
  checked,
  disabled = false,
  showLabel = true,
  onChange,
  marks,
}: LabelledSwitchProps) {
  const id = useId();
  return (
    <span className="fy-acc-axis" {...marks} data-checked={checked ? 'yes' : 'no'}>
      {showLabel ? (
        <span className="fy-acc-axis__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <span id={id} className="sr-only">
        {accessibleName}
      </span>
      <SettingSwitch checked={checked} disabled={disabled} labelledBy={id} onChange={onChange} />
    </span>
  );
}

export function ActionRow({ children }: { readonly children: ReactNode }) {
  return <div className="fy-acc-actions">{children}</div>;
}

export interface StateBlockProps {
  readonly title: string;
  /** The region's accessible name. */
  readonly label: string;
  readonly role?: 'status' | 'alert';
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}

/** A tab that cannot show its list says why in a plain block (a heading and sentences), never in a box. */
export function StateBlock({ title, label, role = 'status', icon, children, marks }: StateBlockProps) {
  return (
    <AccessTab name="state">
      <section className="fy-acc-state" role={role} aria-label={label} {...marks}>
        <h3 className="fy-acc-state__title">
          {icon}
          {title}
        </h3>
        {children}
      </section>
    </AccessTab>
  );
}
