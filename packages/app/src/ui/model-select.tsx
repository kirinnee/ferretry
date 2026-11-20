/**
 * THE MODEL FIELD every form shares (docs/model-catalog.md): the new-session form, Settings › Warden's
 * investigation model and a lessons scan's model. It lists exactly the chosen login's catalog, grouped
 * by tier with the default marked, and offers "Custom id…" for a provider that takes ids beyond its
 * catalog. A `SelectBox` (the app's own select: a popover under a mouse, a centred dialog on a phone, a search box once the
 * list is long), so every theme draws it and a screen reader reads a listbox.
 *
 * The live session pickers (the composer's chip and Info › Runtime) are menus instead, because choosing
 * there is an action sent to a running harness; they group by the same tiers (`./model-tiers.ts`).
 */
import type { LocalModelsSnapshot } from './local-models-note.tsx';
import { useId, useMemo, useState } from 'react';
import type { ClipboardWriter } from './copy-button.tsx';
import { CUSTOM_MODEL_ID, contextWords, groupByTier, type ModelTier } from './model-tiers.ts';
import { LocalModelsNote, localNote } from './local-models-note.tsx';
import { SelectBox, type SelectOption } from './select-box.tsx';

/** The option that reveals the custom id box. Not a model id: the grammar has no leading space. */
const CUSTOM = ' custom';

/** One model a login offers, as a model field lists it (a login's catalog entry: tier, window, efforts, fast mode). */
export interface ModelChoice {
  readonly id: string;
  readonly available: boolean;
  readonly label?: string;
  readonly tier?: ModelTier;
  readonly context?: number;
  /** The reasoning efforts it takes; empty when it takes none. Absent when no catalog says. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  /** Whether the CLI offers fast mode on it; absent when the daemon did not say. */
  readonly fast?: boolean;
  /** Installed on this machine, as the local server (Ollama) reported it, rather than listed by the catalog. */
  readonly local?: true;
}

export interface ModelSelectProps {
  readonly id: string;
  /** The field's name, for a screen reader and the phone dialog's title; the caller's visible `<label htmlFor>` carries the same words. */
  readonly label?: string;
  readonly models: readonly ModelChoice[];
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
  /** What the daemon last read from a local server (Ollama), for a login whose catalog detects one. */
  readonly local?: LocalModelsSnapshot | null;
  /** The clipboard the note's copy button writes to; the browser's by default. */
  readonly write?: ClipboardWriter;
}

const nameOf = (models: readonly ModelChoice[], id: string | null): string | undefined =>
  id === null ? undefined : (models.find(model => model.id === id)?.label ?? id);

/** What a reader weighs an option by, after its name. */
const optionHint = (model: ModelChoice, defaultModel: string | null): string | undefined =>
  [
    model.id === defaultModel ? 'default' : undefined,
    model.local === true ? 'installed here' : undefined,
    contextWords(model.context),
    model.available ? undefined : 'not on this login',
  ]
    .filter(part => part !== undefined)
    .join(' · ') || undefined;

/** The catalog as a select's options: the login's default first, each tier a heading, "Custom id…" last when the provider takes any id. */
function optionsFor(
  models: readonly ModelChoice[],
  defaultModel: string | null,
  defaultLabel: string,
  customIds: boolean,
): readonly SelectOption[] {
  const defaultName = nameOf(models, defaultModel);
  const hintOf = (model: ModelChoice): { readonly hint?: string } => {
    const hint = optionHint(model, defaultModel);
    return hint === undefined ? {} : { hint };
  };
  return [
    { value: '', label: defaultName === undefined ? defaultLabel : `${defaultLabel} (${defaultName})` },
    ...groupByTier(models).flatMap(group =>
      group.items.map(
        (model): SelectOption => ({
          value: model.id,
          label: model.label ?? model.id,
          ...hintOf(model),
          ...(group.heading === undefined ? {} : { group: group.heading }),
          ...(model.available ? {} : { disabled: true }),
        }),
      ),
    ),
    ...(customIds ? [{ value: CUSTOM, label: 'Custom id…' }] : []),
  ];
}

export function ModelSelect({
  customIds,
  defaultLabel = 'Login default',
  defaultModel,
  disabled = false,
  id,
  label = 'Model',
  models,
  local,
  onChange,
  value,
  write,
  'aria-describedby': describedBy,
}: ModelSelectProps) {
  const listed = value === '' || models.some(model => model.id === value);
  const [custom, setCustom] = useState(!listed);
  const customId = useId();
  const noteId = useId();
  const described = [describedBy, localNote(local) === null ? undefined : noteId]
    .filter(part => part !== undefined)
    .join(' ');
  const typed = value.trim();
  const problem = custom && typed.length > 0 && !CUSTOM_MODEL_ID.test(typed);
  const options = useMemo(
    () => optionsFor(models, defaultModel, defaultLabel, customIds),
    [models, defaultModel, defaultLabel, customIds],
  );
  return (
    <>
      <SelectBox
        aria-describedby={described === '' ? undefined : described}
        disabled={disabled}
        id={id}
        label={label}
        onChange={next => {
          if (next === CUSTOM) {
            setCustom(true);
            onChange('');
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        options={options}
        value={custom ? CUSTOM : value}
      />
      <LocalModelsNote id={noteId} local={local} {...(write === undefined ? {} : { write })} />
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
