/**
 * THE FIELDS OF A FORM CARD, inside "What I need from you": a numbered question each, answered where it is asked —
 *
 *   pick one      radio buttons, each option with what it means
 *   pick many     checkboxes, the same
 *   yes / no      a two-part Yes | No
 *   free text     "Type it below." — the composer is its answer
 *
 * The asker's recommended value is already picked and says so with a "Recommended" tag; what is PICKED is the filled
 * row (or the pressed half with its check), so the two never read alike. EVERY FIELD IS OPTIONAL (&F922): nothing
 * says a field needs an answer, and Send goes with any subset; a pick is taken back by tapping the pressed Yes/No half
 * again, or Clear on a pick-one (a radio cannot be unticked). A foot pinned to the bottom of the scroller counts what
 * is answered and says how to send — so it is never hidden under the composer. The picks live in `agendaForms`; the composer's one
 * Send combines them with its text (`agenda-form-send.ts`), the Inbox's and the chat's alike. Where no composer can
 * answer it (a settled item, a chat with no agenda client), the fields are a numbered list to read, not controls.
 */

import { type AgendaFormField, plainLabel, YES_NO_ORDER } from '@ferretry/core-asks/contract';
import { Check } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { formProgress } from '../../lib/agenda-form-send.ts';
import { agendaForms, type FormPicks, toggled } from '../../lib/agenda-form-state.ts';

type Prose = (text: string) => ReactNode;

const optionsOf = (field: AgendaFormField): readonly { readonly label: string; readonly detail?: string }[] =>
  field.type === 'yesno'
    ? YES_NO_ORDER.map(label => ({ label }))
    : (field.options ?? []).map(option => ({
        label: option.label.trim(),
        ...(option.description === undefined ? {} : { detail: option.description }),
      }));

const isRecommended = (field: AgendaFormField, label: string): boolean =>
  (field.recommended ?? []).some(value => value.trim() === label);

/** "2 of 3 answered", or that all are: the fields answered on the card. */
const progressWords = ({ answered, total }: { readonly answered: number; readonly total: number }): string =>
  answered === total
    ? total === 1
      ? 'Answered'
      : `All ${String(total)} answered`
    : `${String(answered)} of ${String(total)} answered`;

/** A pick-many says it takes several. Nothing says optional: every field is (&F922). */
function Hint({ field }: { readonly field: AgendaFormField }) {
  return field.type === 'many' ? <span className="fy-form__hint">(pick any)</span> : null;
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
            {picks.includes(option.label) ? (
              <Check aria-hidden="true" className="fy-form__seg-check" size={16} />
            ) : null}
            {plainLabel(option.label)}
            {isRecommended(field, option.label) ? <span className="fy-form__rec">Recommended</span> : null}
          </button>
        ))}
      </fieldset>
    );
  return (
    <fieldset aria-labelledby={group} className="fy-form__options">
      {optionsOf(field).map(option => (
        <label className="fy-form__option" data-on={picks.includes(option.label) || undefined} key={option.label}>
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

/**
 * The form's fields, picks on the card. `formKey` names the open item's picks; `null` draws the fields to read only.
 * `instruction` is the foot's "how to send" line, drawn (with the count) only while the form can be answered here.
 */
export function AgendaFormFields({
  fields,
  formKey,
  picks,
  disabled,
  renderProse,
  instruction = null,
}: {
  readonly fields: readonly AgendaFormField[];
  readonly formKey: string | null;
  readonly picks: FormPicks;
  readonly disabled: boolean;
  readonly renderProse: Prose;
  readonly instruction?: string | null;
}) {
  const base = useId();
  const progress = formProgress(fields, picks);
  const foot = formKey !== null && instruction !== null;
  return (
    <>
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
                {live && field.type === 'one' && (picks[field.id] ?? []).length > 0 ? (
                  <button
                    aria-label={`Clear answer ${String(index + 1)}`}
                    className="fy-form__clear"
                    data-agenda-form-clear=""
                    disabled={disabled}
                    onClick={() => agendaForms.set(formKey, fields, field.id, [])}
                    type="button"
                  >
                    Clear
                  </button>
                ) : null}
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
      {foot ? (
        <div
          className="fy-form__foot"
          data-agenda-form-foot=""
          data-done={progress.answered === progress.total || undefined}
        >
          {progress.total === 0 ? null : (
            <p aria-live="polite" className="fy-form__progress" data-agenda-form-progress="" role="status">
              {progressWords(progress)}
            </p>
          )}
          <p className="fy-form__instruction" data-agenda-need-lead="">
            {instruction}
          </p>
        </div>
      ) : null}
    </>
  );
}
