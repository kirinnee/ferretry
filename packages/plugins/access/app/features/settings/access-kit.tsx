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
import { type HTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
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
  /** The id of the text that explains the switch (a refusal, a limit), so it is heard with the switch. */
  readonly describedBy?: string;
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
  describedBy,
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
      <SettingSwitch
        checked={checked}
        disabled={disabled}
        labelledBy={id}
        describedBy={describedBy}
        onChange={onChange}
      />
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

export interface ConfirmStripProps {
  /** The question, short: "Revoke Pixel 8?" */
  readonly question: string;
  /** What happens if the person goes ahead, said whole. */
  readonly consequence: string;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** `data-*` marks on the strip, its confirm button and its cancel button. */
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
  readonly confirmMarks?: Readonly<Record<`data-${string}`, string>>;
  readonly cancelMarks?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * THE SECOND STEP OF AN ACT THAT ENDS ACCESS: what will happen, a button that does it, and Cancel.
 *
 * A revoke is not undone by pressing it again, so the first press sends nothing: it opens this strip. Focus lands on Cancel, so
 * a keyboard press that was a slip is one more Enter away from harmless, not from done.
 */
export function ConfirmStrip({
  question,
  consequence,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  marks,
  confirmMarks,
  cancelMarks,
}: ConfirmStripProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <fieldset aria-label={question} className="fy-acc-confirm" {...marks}>
      <Notice tone="warn">
        <strong>{question}</strong> {consequence}
      </Notice>
      <ActionRow>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="kt-btn min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60"
          data-variant="danger"
          {...confirmMarks}
        >
          {confirmLabel}
        </button>
        <button type="button" ref={cancel} onClick={onCancel} className="kt-btn min-h-[44px]" {...cancelMarks}>
          Cancel
        </button>
      </ActionRow>
    </fieldset>
  );
}
