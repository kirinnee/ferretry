/**
 * THE MANUAL-RATE EDITOR: add a rate, or edit one into a manual override. One group of the page (its own heading, one
 * hairline-bordered body), the fields two to a line once the PANEL is 640px wide, the nine rate fields three to a line from 960px, and the
 * Save / Cancel buttons auto-width on one line. The wording about what a save records is kept whole.
 */
import { SettingGroup } from '@ferretry/app';
import { Button, SelectBox } from '@ferretry/app/ui';
import { type FormEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import {
  ANALYTICS_PRICING_PROVIDERS,
  ANALYTICS_PRICING_RATE_SLOTS,
  type AnalyticsPricingRate,
  analyticsPricingRateUnit,
} from '../../../contract/index.ts';
import {
  PROVIDER_LABELS,
  type PricingDraft,
  type PricingFieldErrors,
  RATE_LABELS,
  UNIT_LABELS,
} from './pricing-model.ts';

function Field({
  id,
  label,
  error,
  detail,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error?: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 content-start gap-1 text-meta font-semibold text-fg" htmlFor={id}>
      {label}
      {children}
      {detail ? (
        <span id={`${id}-detail`} className="font-normal leading-base text-faint">
          {detail}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="font-normal leading-base text-err" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

const NOTE = 'm-0 rounded-panel border border-warn-border bg-warn-bg px-panel py-2 text-meta leading-base text-warn';

export function PricingEditor({
  draft,
  editing,
  errors,
  busy,
  failure,
  onChange,
  onCancel,
  onSubmit,
}: {
  readonly draft: PricingDraft;
  readonly editing: AnalyticsPricingRate | null;
  readonly errors: PricingFieldErrors;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onChange: (draft: PricingDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}) {
  const formId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit();
  };
  const inputClass = 'kt-input !min-h-[44px] min-w-0';

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="min-w-0 outline-none"
      aria-label={editing === null ? 'Add a manual rate' : `Edit ${editing.modelId}`}
      data-pricing-editor={editing === null ? 'add' : editing.pricingKey}
    >
      <SettingGroup label={editing === null ? 'Add a manual rate' : `Edit ${editing.modelId}`}>
        <li className="flex min-w-0 flex-col gap-2 px-panel py-3">
          <p className="m-0 text-meta leading-base text-muted">
            This save records manual provenance. Provider-sync provenance can only come from an applied feed preview.
          </p>
          {editing?.source.kind === 'provider_sync' ? (
            <p className={NOTE}>
              This provider-synced row will become a manual override. Its source feed and last-sync claim will not be
              carried into the PATCH.
            </p>
          ) : null}
          {editing !== null ? (
            <p className={NOTE}>
              Editing an effective historical rate can reprice rows during later insights reingestion. Create a new
              effective window instead when prior history must keep its original price.
            </p>
          ) : null}
        </li>
        <li className="min-w-0 px-panel py-3">
          <form className="fy-usage-form gap-x-4 gap-y-3" onSubmit={submit} noValidate data-pricing-form="">
            <Field
              id={`${formId}-pricing-key`}
              label="Pricing key"
              error={errors.pricingKey}
              detail="Stable key stored with priced usage."
            >
              <input
                id={`${formId}-pricing-key`}
                className={inputClass}
                value={draft.pricingKey}
                disabled={busy || editing !== null}
                aria-invalid={errors.pricingKey !== undefined}
                aria-describedby={errors.pricingKey ? `${formId}-pricing-key-error` : `${formId}-pricing-key-detail`}
                data-pricing-field="pricingKey"
                onChange={event => onChange({ ...draft, pricingKey: event.currentTarget.value })}
              />
            </Field>
            <Field id={`${formId}-model-id`} label="Canonical model" error={errors.modelId}>
              <input
                id={`${formId}-model-id`}
                className={inputClass}
                value={draft.modelId}
                disabled={busy}
                aria-invalid={errors.modelId !== undefined}
                aria-describedby={errors.modelId ? `${formId}-model-id-error` : undefined}
                data-pricing-field="modelId"
                onChange={event => onChange({ ...draft, modelId: event.currentTarget.value })}
              />
            </Field>
            <Field
              id={`${formId}-aliases`}
              label="Aliases"
              error={errors.aliases}
              detail="Comma-separated transcript spellings."
            >
              <input
                id={`${formId}-aliases`}
                className={inputClass}
                value={draft.aliases}
                disabled={busy}
                aria-invalid={errors.aliases !== undefined}
                aria-describedby={errors.aliases ? `${formId}-aliases-error` : `${formId}-aliases-detail`}
                data-pricing-field="aliases"
                onChange={event => onChange({ ...draft, aliases: event.currentTarget.value })}
              />
            </Field>
            <Field id={`${formId}-provider`} label="Provider" error={errors.provider}>
              <SelectBox
                id={`${formId}-provider`}
                className={inputClass}
                label="Provider"
                value={draft.provider}
                disabled={busy}
                aria-describedby={errors.provider ? `${formId}-provider-error` : undefined}
                data-pricing-field="provider"
                onChange={next => onChange({ ...draft, provider: next as PricingDraft['provider'] })}
                options={ANALYTICS_PRICING_PROVIDERS.map(provider => ({
                  value: provider,
                  label: PROVIDER_LABELS[provider],
                }))}
              />
            </Field>
            <Field
              id={`${formId}-valid-from`}
              label="Effective from"
              error={errors.validFrom}
              detail="ISO 8601 instant, including timezone."
            >
              <input
                id={`${formId}-valid-from`}
                className={inputClass}
                value={draft.validFrom}
                disabled={busy}
                placeholder="2026-08-06T00:00:00.000Z"
                aria-invalid={errors.validFrom !== undefined}
                aria-describedby={errors.validFrom ? `${formId}-valid-from-error` : `${formId}-valid-from-detail`}
                data-pricing-field="validFrom"
                onChange={event => onChange({ ...draft, validFrom: event.currentTarget.value })}
              />
            </Field>
            <Field
              id={`${formId}-valid-through`}
              label="Effective through"
              error={errors.validThrough}
              detail="Optional; blank keeps this window open."
            >
              <input
                id={`${formId}-valid-through`}
                className={inputClass}
                value={draft.validThrough}
                disabled={busy}
                placeholder="Open-ended"
                aria-invalid={errors.validThrough !== undefined}
                aria-describedby={
                  errors.validThrough ? `${formId}-valid-through-error` : `${formId}-valid-through-detail`
                }
                data-pricing-field="validThrough"
                onChange={event => onChange({ ...draft, validThrough: event.currentTarget.value })}
              />
            </Field>
            <Field
              id={`${formId}-verified-at`}
              label="Verified at"
              error={errors.verifiedAt}
              detail="When an operator checked these amounts."
            >
              <input
                id={`${formId}-verified-at`}
                className={inputClass}
                value={draft.verifiedAt}
                disabled={busy}
                placeholder="2026-08-06T00:00:00.000Z"
                aria-invalid={errors.verifiedAt !== undefined}
                aria-describedby={errors.verifiedAt ? `${formId}-verified-at-error` : `${formId}-verified-at-detail`}
                data-pricing-field="verifiedAt"
                onChange={event => onChange({ ...draft, verifiedAt: event.currentTarget.value })}
              />
            </Field>
            <fieldset className="fy-usage-form-rates col-span-full m-0 gap-x-4 gap-y-3 border-0 border-t border-border-soft p-0 pt-3">
              <legend className="px-0 pr-2 text-ui font-semibold text-fg">Rates</legend>
              <p className="m-0 text-meta leading-base text-muted col-span-full">
                Currency is fixed to USD. Amounts use the protocol-owned unit shown beside each field.
              </p>
              {ANALYTICS_PRICING_RATE_SLOTS.map(slot => {
                const field = `rates.${slot}`;
                const fieldId = `${formId}-rate-${slot}`;
                return (
                  <Field
                    key={slot}
                    id={fieldId}
                    label={`${RATE_LABELS[slot]} · USD / ${UNIT_LABELS[analyticsPricingRateUnit(slot)]}`}
                    error={errors[field]}
                    detail="Blank means not priced where the shared schema permits null."
                  >
                    <input
                      id={fieldId}
                      inputMode="decimal"
                      className={inputClass}
                      value={draft.rates[slot]}
                      disabled={busy}
                      aria-invalid={errors[field] !== undefined}
                      aria-describedby={errors[field] ? `${fieldId}-error` : `${fieldId}-detail`}
                      data-pricing-rate-field={slot}
                      onChange={event =>
                        onChange({ ...draft, rates: { ...draft.rates, [slot]: event.currentTarget.value } })
                      }
                    />
                  </Field>
                );
              })}
            </fieldset>
            {failure ? (
              <p className="m-0 text-meta leading-base text-err col-span-full" role="alert">
                {failure}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 col-span-full">
              <Button type="submit" variant="primary" className="min-h-[44px]" disabled={busy} data-pricing-save="">
                {busy ? 'Saving…' : editing === null ? 'Add rate' : 'Save manual override'}
              </Button>
              <Button type="button" className="min-h-[44px]" disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </li>
      </SettingGroup>
    </section>
  );
}
