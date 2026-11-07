/**
 * Compact memory at… — where this ferret's harness squeezes its own conversation, in the Actions popover or sheet
 * (docs/compact-at.md). Auto, a few common sizes, or a custom size; one line says what the trade is.
 *
 * Nothing is sent to a running harness: the value is read when the ferret next launches, and the form says so.
 */

import { COMPACT_AT_PRESETS, COMPACT_AT_TRADE_OFF, type CompactAt, describeCompactAt, formatTokens, parseCompactAt } from '@ferretry/protocol';
import { type FormEvent, useId, useRef, useState } from 'react';
import { FormFailure, FormField, FormFoot } from './form-parts.tsx';
import type { SessionActionFormHost } from './registry.ts';

export type CompactAtChoice = 'auto' | 'custom' | `${number}`;

/** Which radio a stored value lands on: a preset when it is one, `custom` when it is any other size. */
export const choiceFor = (value: CompactAt | undefined): CompactAtChoice => {
  if (value === undefined || value === 'auto') return 'auto';
  return (COMPACT_AT_PRESETS as readonly number[]).includes(value) ? (`${value}` as CompactAtChoice) : 'custom';
};

export interface CompactAtSaved {
  readonly note: string;
}

export function CompactAtForm({
  current,
  following,
  window,
  host,
  save,
}: {
  /** This ferret's own value; absent when it follows its login's default. */
  readonly current: CompactAt | undefined;
  /** What it uses now when it has none of its own — the login's default, or Auto. */
  readonly following: CompactAt;
  /** The model's window, when known, for the custom box's hint. */
  readonly window: number | undefined;
  readonly host: SessionActionFormHost;
  readonly save: (wanted: CompactAt) => Promise<CompactAtSaved>;
}) {
  const id = useId();
  const shown = current ?? following;
  const [choice, setChoice] = useState<CompactAtChoice>(choiceFor(shown));
  const [custom, setCustom] = useState(
    typeof shown === 'number' && choiceFor(shown) === 'custom' ? formatTokens(shown) : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  const wanted = ():
    | { readonly ok: true; readonly value: CompactAt }
    | { readonly ok: false; readonly reason: string } => {
    if (choice === 'auto') return { ok: true, value: 'auto' };
    if (choice === 'custom') return parseCompactAt(custom);
    return { ok: true, value: Number(choice) };
  };
  const parsed = wanted();
  const unchanged = parsed.ok && parsed.value === shown;

  const run = async (target: CompactAt): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const saved = await save(target);
      host.close();
      host.notify(saved.note);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    if (!unchanged) await run(parsed.value);
  };

  const options: ReadonlyArray<{ readonly value: CompactAtChoice; readonly label: string }> = [
    { value: 'auto', label: 'Auto' },
    ...COMPACT_AT_PRESETS.map(tokens => ({ value: `${tokens}` as CompactAtChoice, label: formatTokens(tokens) })),
    { value: 'custom', label: 'Custom' },
  ];

  return (
    <form className="fy-action-form__body" data-compact-at="" noValidate onSubmit={event => void submit(event)}>
      <fieldset className="fy-action-form__fieldset">
        <legend className="fy-action-form__label">Compact memory at</legend>
        <div className="fy-segmented">
          {options.map(option => (
            <label className="fy-segmented__option" key={option.value}>
              <input
                checked={choice === option.value}
                disabled={submitting}
                name={`${id}-at`}
                onChange={() => {
                  setChoice(option.value);
                  setError(null);
                }}
                type="radio"
                value={option.value}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <span className="fy-action-form__help">{COMPACT_AT_TRADE_OFF}</span>
      </fieldset>
      {choice === 'custom' ? (
        <FormField
          error={error}
          help={
            window === undefined
              ? 'Tokens, at least 100k — for example 300k.'
              : `Tokens, 100k up to ${formatTokens(window)}.`
          }
          id={`${id}-custom`}
          label="Custom size"
        >
          <input
            autoCapitalize="none"
            autoComplete="off"
            className="kt-input w-full"
            disabled={submitting}
            id={`${id}-custom`}
            inputMode="text"
            onChange={event => {
              setCustom(event.target.value);
              setError(null);
            }}
            placeholder="300k"
            spellCheck={false}
            value={custom}
          />
        </FormField>
      ) : null}
      <p className="fy-action-form__note">
        {current === undefined && following !== 'auto'
          ? `Following this login’s default (${describeCompactAt(following)}). `
          : ''}
        Takes effect when the ferret restarts.
      </p>
      <FormFailure message={failure} />
      <FormFoot disabled={unchanged} onCancel={host.close} submitLabel="Save" submitting={submitting} />
    </form>
  );
}
