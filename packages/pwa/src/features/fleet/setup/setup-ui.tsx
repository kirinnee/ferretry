/**
 * The small pieces the Settings tab, the first run and Clone draw with: a section, a row, a note, a
 * command, and a set of choices that looks like one. Plain Studio tokens, so a theme restyles them
 * with the rest of Settings.
 */

import { Check } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Badge } from '../../../shell/primitives.tsx';
import { AccountStatus } from '../shell/account-status.tsx';
import type { RowTone } from './first-run-model.ts';

export function SetupSection({
  title,
  children,
  name,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly name?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-setup-section={name}>
      <h4 className="m-0 text-meta font-semibold uppercase text-muted">{title}</h4>
      {children}
    </section>
  );
}

export function SetupNote({
  tone = 'pend',
  title,
  children,
  name,
  live = false,
}: {
  readonly tone?: 'ok' | 'warn' | 'err' | 'pend';
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly name?: string;
  /** Spoken when it appears: a result or a state change the person is waiting for. */
  readonly live?: boolean;
}) {
  return (
    <div
      role={live ? 'status' : undefined}
      data-setup-note={name}
      data-tone={tone}
      className={cn(
        'kt-panel flex min-w-0 flex-col gap-1 p-panel',
        tone === 'ok' && 'border-ok',
        tone === 'warn' && 'border-warn',
        tone === 'err' && 'border-err',
      )}
    >
      {title === undefined ? null : <p className="m-0 text-row font-semibold text-fg">{title}</p>}
      {children === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1 text-cell leading-base text-muted">{children}</div>
      )}
    </div>
  );
}

/** A command a person reads or runs by hand. Wraps instead of scrolling the page sideways. */
export function SetupCommand({ children }: { readonly children: string }) {
  return (
    <pre className="m-0 min-w-0 whitespace-pre-wrap break-all rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-meta text-fg">
      {children}
    </pre>
  );
}

export function SetupBadges({
  badges,
}: {
  readonly badges: readonly { readonly text: string; readonly tone: RowTone }[];
}) {
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map(badge => (
        <Badge
          key={badge.text}
          tone={badge.tone === 'err' ? 'err' : badge.tone}
          className="max-w-full !whitespace-normal [overflow-wrap:anywhere]"
        >
          {badge.text}
        </Badge>
      ))}
    </span>
  );
}

export interface SetupRowProps {
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** A small label on the left ("Account"). */
  readonly label?: string;
  readonly status?: 'ready' | 'refresh_due' | 'needs_sign_in' | 'checking';
  readonly statusLabel?: string;
  readonly children?: ReactNode;
  readonly name?: string;
}

export function SetupRow({ title, detail, label, status, statusLabel, children, name }: SetupRowProps) {
  return (
    <div className="kt-panel flex min-w-0 items-start gap-3 p-panel" data-setup-row={name}>
      {status === undefined ? null : (
        <AccountStatus
          word={status}
          {...(statusLabel === undefined ? {} : { label: statusLabel })}
          className="pt-0.5"
        />
      )}
      {label === undefined ? null : <span className="w-24 shrink-0 text-meta text-muted">{label}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{title}</span>
        {detail === undefined ? null : <span className="[overflow-wrap:anywhere] text-cell text-muted">{detail}</span>}
      </span>
      {children}
    </div>
  );
}

export interface SetupChoice<T extends string> {
  readonly id: T;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** Shown under the detail: why it cannot be picked (E27), a command (E1). */
  readonly extra?: ReactNode;
  readonly disabled?: boolean;
}

interface ChoiceListProps<T extends string> {
  readonly legend: string;
  /** Hidden visually when the step's own sentence already asks the question. */
  readonly legendHidden?: boolean;
  readonly options: readonly SetupChoice<T>[];
  readonly name: string;
}

/**
 * Radio or checkbox cards in a real `fieldset`. Each input is visually hidden inside its `<label>`,
 * and the fieldset is `relative` so the hidden input stays inside it rather than escaping to the
 * fixed app shell and scrolling it away when focused.
 */
function ChoiceList<T extends string>({
  legend,
  legendHidden = false,
  options,
  name,
  input,
  isChecked,
}: ChoiceListProps<T> & {
  readonly input: (option: SetupChoice<T>, id: string) => ReactNode;
  readonly isChecked: (option: SetupChoice<T>) => boolean;
}) {
  const uid = useId();
  return (
    <fieldset className="relative m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-setup-choices={name}>
      <legend className={legendHidden ? 'sr-only' : 'mb-1 block text-cell font-medium text-fg'}>{legend}</legend>
      {options.map(option => {
        const id = `${uid}-${option.id}`;
        return (
          <label
            key={option.id}
            htmlFor={id}
            data-setup-choice={option.id}
            className={cn(
              'kt-panel relative flex min-h-control min-w-0 cursor-pointer items-start gap-3 p-panel has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus',
              option.disabled === true ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
            )}
          >
            {input(option, id)}
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border-strong text-accent"
            >
              {isChecked(option) ? <Check size={12} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">{option.title}</span>
              {option.detail === undefined ? null : (
                <span className="[overflow-wrap:anywhere] text-cell text-muted">{option.detail}</span>
              )}
              {option.extra}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function RadioChoices<T extends string>({
  value,
  onChoose,
  ...props
}: ChoiceListProps<T> & { readonly value: T | null; readonly onChoose: (value: T) => void }) {
  const group = useId();
  return (
    <ChoiceList
      {...props}
      isChecked={option => option.id === value}
      input={(option, id) => (
        <input
          id={id}
          type="radio"
          name={group}
          className="sr-only"
          checked={option.id === value}
          disabled={option.disabled === true}
          onChange={() => onChoose(option.id)}
        />
      )}
    />
  );
}

export function CheckChoices<T extends string>({
  values,
  onToggle,
  ...props
}: ChoiceListProps<T> & { readonly values: readonly T[]; readonly onToggle: (value: T, on: boolean) => void }) {
  return (
    <ChoiceList
      {...props}
      isChecked={option => values.includes(option.id)}
      input={(option, id) => (
        <input
          id={id}
          type="checkbox"
          className="sr-only"
          checked={values.includes(option.id)}
          disabled={option.disabled === true}
          onChange={event => onToggle(option.id, event.target.checked)}
        />
      )}
    />
  );
}
