/**
 * THE FIELDS OF A FORM CARD, inside "What I need from you": a numbered question each, answered where it is asked —
 *
 *   pick one      radio buttons, each option with what it means
 *   pick many     checkboxes, the same
 *   yes / no      a two-part Yes | No
 *   free text     "Type it below." — the composer is its answer
 *
 * The asker's recommended value is already picked and says so. The picks live in `agendaForms`; the composer's one
 * Send combines them with its text (`agenda-form-send.ts`). Where no composer takes the send (the chat), the
 * fields are a numbered list to read, not controls.
 */

import { type AgendaFormField, FORM_NO, FORM_YES, formFieldRequired } from '@ferretry/protocol';
import { type ReactNode, useId } from 'react';
import { agendaForms, type FormPicks, toggled } from '../../lib/agenda-form-state.ts';

type Prose = (text: string) => ReactNode;

const optionsOf = (field: AgendaFormField): readonly { readonly label: string; readonly detail?: string }[] =>
  field.type === 'yesno'
    ? [{ label: FORM_YES }, { label: FORM_NO }]
    : (field.options ?? []).map(option => ({
        label: option.label.trim(),
        ...(option.description === undefined ? {} : { detail: option.description }),
      }));

const isRecommended = (field: AgendaFormField, label: string): boolean =>
  (field.recommended ?? []).some(value => value.trim() === label);

function Hint({ field }: { readonly field: AgendaFormField }) {
  if (field.type === 'many')
    return <span className="fy-form__hint">(pick any{formFieldRequired(field) ? '' : ', optional'})</span>;
  return formFieldRequired(field) || field.type === 'text' ? null : <span className="fy-form__hint">(optional)</span>;
}

function Choices({
  field,
  picks,
  onPick,
  disabled,
  group,
}: {
  readonly field: AgendaFormField;
  readonly picks: readonly string[];
  readonly onPick: (label: string) => void;
  readonly disabled: boolean;
  readonly group: string;
}) {
  const kind = field.type === 'many' ? 'checkbox' : 'radio';
  if (field.type === 'yesno')
    return (
      <fieldset aria-labelledby={group} className="fy-form__seg" data-agenda-form-yesno="">
        {optionsOf(field).map(option => (
          <button
            aria-pressed={picks.includes(option.label)}
            className="fy-form__seg-btn"
            data-on={picks.includes(option.label) || undefined}
            disabled={disabled}
            key={option.label}
            onClick={() => onPick(option.label)}
            type="button"
          >
            {option.label}
            {isRecommended(field, option.label) ? <span className="fy-form__rec">Recommended</span> : null}
          </button>
        ))}
      </fieldset>
    );
  return (
    <fieldset aria-labelledby={group} className="fy-form__options">
      {optionsOf(field).map(option => (
        <label className="fy-form__option" key={option.label}>
          <input
            checked={picks.includes(option.label)}
            disabled={disabled}
            name={`${group}-pick`}
            onChange={() => onPick(option.label)}
            type={kind}
            value={option.label}
          />
          <span className="fy-form__option-text">
            <span className="fy-form__option-name">
              {option.label}
              {isRecommended(field, option.label) ? <span className="fy-form__rec">Recommended</span> : null}
            </span>
            {option.detail === undefined ? null : <small className="fy-form__option-meaning">{option.detail}</small>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The form's fields, picks on the card. `formKey` names the open item's picks; `null` draws the fields to read only. */
export function AgendaFormFields({
  fields,
  formKey,
  picks,
  disabled,
  renderProse,
}: {
  readonly fields: readonly AgendaFormField[];
  readonly formKey: string | null;
  readonly picks: FormPicks;
  readonly disabled: boolean;
  readonly renderProse: Prose;
}) {
  const base = useId();
  return (
    <ol className="fy-form" data-agenda-form="">
      {fields.map((field, index) => {
        const group = `${base}-${field.id}`;
        const live = formKey !== null;
        return (
          <li className="fy-form__field" data-agenda-form-field={field.id} data-type={field.type} key={field.id}>
            <div className="fy-form__q" id={group}>
              <span aria-hidden="true" className="fy-card__wanted-n">
                {index + 1}.
              </span>
              <div className="fy-form__label">
                {renderProse(field.label)}
                <Hint field={field} />
              </div>
            </div>
            {field.type === 'text' ? (
              <p className="fy-card__wanted-choices" data-agenda-form-text="">
                {live ? 'Type it below.' : 'Answered in the reply box.'}
              </p>
            ) : live ? (
              <Choices
                disabled={disabled}
                field={field}
                group={group}
                onPick={label =>
                  agendaForms.set(
                    formKey,
                    fields,
                    field.id,
                    toggled(picks[field.id] ?? [], label, field.type === 'many'),
                  )
                }
                picks={picks[field.id] ?? []}
              />
            ) : (
              <p className="fy-card__wanted-choices" data-agenda-form-options="">
                {optionsOf(field)
                  .map(option => option.label)
                  .join(' / ')}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
