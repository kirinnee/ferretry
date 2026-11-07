/**
 * THE MODEL FIELD for a runtime whose login reads a model catalog: exactly its models, with the default marked, and
 * "Custom id…" for a provider that takes ids beyond its catalog. A native `<select>`, so a phone gets its own wheel and a
 * screen reader its own list. Today's `components/model-select.tsx`.
 *
 * Narrowed to what the offered slot hands over (`ChosenFerretAccount.models`: id, label, availability). The tier,
 * context-window and installed-locally facts of today's catalog are Runtimes' and are not part of that contract, so
 * the list is one group and the "installed here" note is not drawn.
 */

import type { ChosenFerretAccount } from '@ferretry/core-ferrets/contract';
import { useId, useState } from 'react';

/** The option that reveals the custom id box. Not a model id: the grammar has no leading space. */
const CUSTOM = ' custom';

/**
 * A model id a person may type ("Custom id…"): one word a CLI takes after `--model`, the catalog's own grammar, with an
 * optional context suffix such as `[1m]`.
 */
export const CUSTOM_MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}(?:\[[a-z0-9]{1,8}\])?$/u;

type Model = ChosenFerretAccount['models'][number];

export interface ModelSelectProps {
  readonly id: string;
  readonly models: readonly Model[];
  /** The model chosen; `""` means the login's default. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** What a blank choice launches with, named in the first option. */
  readonly defaultModel: string | null;
  /** The first option's words, before the default's name. */
  readonly defaultLabel?: string;
  /** Whether the provider takes ids beyond the list. */
  readonly customIds: boolean;
  readonly disabled?: boolean;
  readonly 'aria-describedby'?: string;
}

const nameOf = (models: readonly Model[], id: string | null): string | undefined =>
  id === null ? undefined : (models.find(model => model.id === id)?.label ?? id);

/** One option's words: its name, then what a reader weighs it by. */
export const modelOptionText = (model: Model, defaultModel: string | null): string =>
  [
    model.label ?? model.id,
    model.id === defaultModel ? 'default' : undefined,
    model.available ? undefined : 'not on this login',
  ]
    .filter(part => part !== undefined)
    .join(' · ');

export function ModelSelect({
  customIds,
  defaultLabel = 'Login default',
  defaultModel,
  disabled = false,
  id,
  models,
  onChange,
  value,
  'aria-describedby': describedBy,
}: ModelSelectProps) {
  const listed = value === '' || models.some(model => model.id === value);
  const [custom, setCustom] = useState(!listed);
  const customId = useId();
  const typed = value.trim();
  const problem = custom && typed.length > 0 && !CUSTOM_MODEL_ID.test(typed);
  const defaultName = nameOf(models, defaultModel);
  return (
    <>
      <select
        aria-describedby={describedBy}
        className="kt-input w-full"
        disabled={disabled}
        id={id}
        onChange={event => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setCustom(true);
            onChange('');
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        value={custom ? CUSTOM : value}
      >
        <option value="">{defaultName === undefined ? defaultLabel : `${defaultLabel} (${defaultName})`}</option>
        {models.map(model => (
          <option disabled={!model.available} key={model.id} value={model.id}>
            {modelOptionText(model, defaultModel)}
          </option>
        ))}
        {customIds ? <option value={CUSTOM}>Custom id…</option> : null}
      </select>
      {custom ? (
        <>
          <input
            aria-describedby={problem ? `${customId}-problem` : undefined}
            aria-label="Custom model id"
            className="kt-input mono mt-2 w-full"
            disabled={disabled}
            id={customId}
            onChange={event => onChange(event.target.value)}
            placeholder="provider/model-id"
            spellCheck={false}
            value={value}
          />
          {problem ? (
            <p className="mt-1 mb-0 text-err text-meta" id={`${customId}-problem`}>
              One word: letters, digits and . _ : ~ / @ + - (a context suffix such as [1m] is fine).
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
