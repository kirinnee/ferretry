/**
 * The small pieces the Browser tab draws with: a section, a note, and a set of choices that looks like one. Plain
 * Studio tokens, so a theme restyles them with the rest of Settings.
 */

import { cn } from '@ferretry/app/ui';
import { Check } from 'lucide-react';
import { type ReactNode, useId } from 'react';

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

interface SetupChoice<T extends string> {
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
              'kt-panel relative flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 p-panel has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus',
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
