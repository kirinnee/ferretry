/**
 * THE MODEL FIELD every form shares (docs/model-catalog.md): the new-session form, Settings › Warden's
 * investigation model and a lessons scan's model. It lists exactly the chosen login's catalog, grouped
 * by tier with the default marked, and offers "Custom id…" for a provider that takes ids beyond its
 * catalog. A native `<select>`, so a phone gets its own wheel and a screen reader its own list.
 *
 * The live session pickers (the composer's chip and Info › Runtime) are menus instead, because choosing
 * there is an action sent to a running harness; they group by the same tiers (`../lib/model-tiers.ts`).
 */
import { useId, useState } from 'react';
import type { PickerModel } from '../lib/account-picker-catalog.ts';
import { CUSTOM_MODEL_ID, contextWords, groupByTier } from '../lib/model-tiers.ts';

/** The option that reveals the custom id box. Not a model id: the grammar has no leading space. */
const CUSTOM = ' custom';

export interface ModelSelectProps {
  readonly id: string;
  readonly models: readonly PickerModel[];
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

const nameOf = (models: readonly PickerModel[], id: string | null): string | undefined =>
  id === null ? undefined : (models.find(model => model.id === id)?.label ?? id);

/** One option's words: its name, then what a reader weighs it by. */
const optionText = (model: PickerModel, defaultModel: string | null): string =>
  [
    model.label ?? model.id,
    model.id === defaultModel ? 'default' : undefined,
    contextWords(model.context),
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
        {groupByTier(models).map(group =>
          group.heading === undefined ? (
            group.items.map(model => (
              <option disabled={!model.available} key={model.id} value={model.id}>
                {optionText(model, defaultModel)}
              </option>
            ))
          ) : (
            <optgroup key={group.heading} label={group.heading}>
              {group.items.map(model => (
                <option disabled={!model.available} key={model.id} value={model.id}>
                  {optionText(model, defaultModel)}
                </option>
              ))}
            </optgroup>
          ),
        )}
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
