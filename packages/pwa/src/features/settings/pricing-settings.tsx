import {
  ANALYTICS_PRICING_RATE_SLOTS,
  type AnalyticsPricingRate,
  type AnalyticsPricingRateSlot,
  type AnalyticsPricingRates,
  type AnalyticsPricingRateUnit,
  type AnalyticsPricingSyncChange,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingView,
  analyticsPricingRateUnit,
  type ConfiguredAnalyticsPricingSource,
  ManualAnalyticsPricingRateSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { daemonApiClient } from '../../lib/api-client.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  type AnalyticsPricingClient,
  applyAnalyticsPricingSync,
  patchAnalyticsPricing,
  previewAnalyticsPricingSync,
  readAnalyticsPricing,
} from './pricing-api.ts';

export type AnalyticsPricingClientFactory = (connection: DaemonConnection) => Promise<AnalyticsPricingClient>;

type PricingLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: AnalyticsPricingView }
  | { readonly status: 'failed'; readonly message: string };

interface PricingDraft {
  readonly pricingKey: string;
  readonly modelId: string;
  readonly aliases: string;
  readonly provider: 'openai' | 'anthropic';
  readonly validFrom: string;
  readonly validThrough: string;
  readonly verifiedAt: string;
  readonly rates: Readonly<Record<AnalyticsPricingRateSlot, string>>;
}

type PricingFieldErrors = Readonly<Record<string, string>>;

const RATE_LABELS = {
  input: 'Input',
  output: 'Output',
  cachedInput: 'Cached input',
  cacheWrite: 'Cache write',
  cacheWrite5m: 'Cache write · 5m',
  cacheWrite1h: 'Cache write · 1h',
  reasoning: 'Reasoning',
  image: 'Image',
  tool: 'Tool',
} as const satisfies { readonly [Slot in AnalyticsPricingRateSlot]: string };

const UNIT_LABELS = {
  million_tokens: 'million tokens',
  image: 'image',
  tool_call: 'tool call',
} as const satisfies Readonly<Record<AnalyticsPricingRateUnit, string>>;

const EMPTY_RATES = Object.fromEntries(ANALYTICS_PRICING_RATE_SLOTS.map(slot => [slot, ''])) as Readonly<
  Record<AnalyticsPricingRateSlot, string>
>;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : 'The daemon did not answer this request.';

const isHttpCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof FyHttpError && error.code !== undefined && codes.includes(error.code);

const isCatalogConflict = (error: unknown): boolean =>
  isHttpCode(error, 'analytics_pricing_stale_catalog', 'analytics_pricing_stale_sources');

const isPreviewConflict = (error: unknown): boolean =>
  isHttpCode(
    error,
    'analytics_pricing_stale_catalog',
    'analytics_pricing_stale_sources',
    'analytics_pricing_unknown_preview',
    'analytics_pricing_expired_preview',
    'analytics_pricing_preview_mismatch',
  );

const formatInstant = (instant: string): string => instant.replace('T', ' ').replace('.000Z', 'Z');

const formatUsdMicros = (micros: number): string => {
  const whole = Math.floor(micros / 1_000_000);
  const remainder = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '');
  return remainder === '' ? `$${whole}` : `$${whole}.${remainder}`;
};

const draftAmount = (micros: number | null): string => {
  if (micros === null) return '';
  const whole = Math.floor(micros / 1_000_000);
  const remainder = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '');
  return remainder === '' ? String(whole) : `${whole}.${remainder}`;
};

const blankDraft = (): PricingDraft => ({
  pricingKey: '',
  modelId: '',
  aliases: '',
  provider: 'openai',
  validFrom: '',
  validThrough: '',
  verifiedAt: '',
  rates: EMPTY_RATES,
});

const rateDraft = (rate: AnalyticsPricingRate): PricingDraft => ({
  pricingKey: rate.pricingKey,
  modelId: rate.modelId,
  aliases: rate.aliases.join(', '),
  provider: rate.provider,
  validFrom: rate.validFrom,
  validThrough: rate.validThrough ?? '',
  verifiedAt: rate.verifiedAt,
  rates: Object.fromEntries(
    ANALYTICS_PRICING_RATE_SLOTS.map(slot => [slot, draftAmount(rate.rates[slot])]),
  ) as Readonly<Record<AnalyticsPricingRateSlot, string>>,
});

const parseUsdMicros = (value: string): number | null | undefined => {
  const normalized = value.trim();
  if (normalized === '') return null;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(normalized);
  if (match === null) return undefined;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  const micros = whole * 1_000_000n + fraction;
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(micros);
};

const fieldForIssue = (path: readonly PropertyKey[]): string => {
  if (path[0] === 'rates' && typeof path[1] === 'string') return `rates.${path[1]}`;
  if (path[0] === 'aliases') return 'aliases';
  return typeof path[0] === 'string' ? path[0] : 'form';
};

const draftRate = (
  draft: PricingDraft,
): { readonly rate?: AnalyticsPricingRate; readonly errors: PricingFieldErrors } => {
  const errors: Record<string, string> = {};
  const rates = Object.fromEntries(
    ANALYTICS_PRICING_RATE_SLOTS.map(slot => {
      const parsed = parseUsdMicros(draft.rates[slot]);
      if (parsed === undefined) {
        errors[`rates.${slot}`] = 'Enter a non-negative USD amount with no more than six decimal places.';
        return [slot, null];
      }
      return [slot, parsed];
    }),
  );
  const parsed = ManualAnalyticsPricingRateSchema.safeParse({
    pricingKey: draft.pricingKey,
    modelId: draft.modelId,
    aliases: draft.aliases
      .split(',')
      .map(alias => alias.trim())
      .filter(alias => alias !== ''),
    provider: draft.provider,
    currency: 'USD',
    rates,
    source: { kind: 'manual' },
    validFrom: draft.validFrom,
    validThrough: draft.validThrough.trim() === '' ? null : draft.validThrough,
    verifiedAt: draft.verifiedAt,
    lastSyncedAt: null,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap(issue =>
      issue.code === 'invalid_union' ? (issue.errors[0] ?? []) : [issue],
    );
    for (const issue of issues) {
      const field = fieldForIssue(issue.path);
      if (errors[field] === undefined) errors[field] = issue.message;
    }
    return { errors };
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { rate: parsed.data, errors };
};

function DateValue({ value, fallback = 'Open-ended' }: { readonly value: string | null; readonly fallback?: string }) {
  return value === null ? (
    <span className="text-faint">{fallback}</span>
  ) : (
    <time dateTime={value}>{formatInstant(value)}</time>
  );
}

function RateAmounts({ rates }: { readonly rates: AnalyticsPricingRates }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
      {ANALYTICS_PRICING_RATE_SLOTS.map(slot => {
        const amount = rates[slot];
        return (
          <div
            key={slot}
            className="flex min-w-0 justify-between gap-2 text-meta leading-base"
            data-pricing-rate={slot}
          >
            <dt className="text-muted">{RATE_LABELS[slot]}</dt>
            <dd className={cn('m-0 text-right font-mono', amount === null ? 'text-faint' : 'text-fg')}>
              {amount === null
                ? 'Not set'
                : `${formatUsdMicros(amount)} USD / ${UNIT_LABELS[analyticsPricingRateUnit(slot)]}`}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Provenance({ rate }: { readonly rate: AnalyticsPricingRate }) {
  if (rate.source.kind === 'manual')
    return (
      <div>
        <span className="inline-flex rounded-control border border-border-soft bg-surface-2 px-2 py-0.5 text-meta font-semibold text-fg">
          Manual
        </span>
        <p className="mb-0 mt-1 text-meta leading-base text-muted">Entered or overridden by an operator.</p>
      </div>
    );
  return (
    <div>
      <span className="inline-flex rounded-control border border-ok-border bg-ok-bg px-2 py-0.5 text-meta font-semibold text-ok">
        Provider sync · {rate.source.provider}
      </span>
      <p className="mb-0 mt-1 break-all text-meta leading-base text-muted">{rate.source.sourceUrl}</p>
      <p className="mb-0 mt-1 text-meta text-faint">
        Last sync: <DateValue value={rate.lastSyncedAt} fallback="Not recorded" />
      </p>
    </div>
  );
}

function Identity({ rate }: { readonly rate: AnalyticsPricingRate }) {
  return (
    <div className="min-w-0">
      <p className="m-0 break-words font-mono text-ui font-semibold text-fg">{rate.modelId}</p>
      <p className="mb-0 mt-1 text-meta text-muted">{rate.provider}</p>
      <p className="mb-0 mt-1 break-words text-meta leading-base text-faint">
        Aliases: {rate.aliases.length === 0 ? 'None' : rate.aliases.join(', ')}
      </p>
      <p className="mb-0 mt-1 break-all text-meta text-faint">Key: {rate.pricingKey}</p>
    </div>
  );
}

function EffectiveDates({ rate }: { readonly rate: AnalyticsPricingRate }) {
  return (
    <dl className="m-0 grid gap-1 text-meta leading-base">
      <div>
        <dt className="inline text-muted">Effective: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.validFrom} />
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Through: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.validThrough} />
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Verified: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.verifiedAt} />
        </dd>
      </div>
    </dl>
  );
}

function RateActions({
  rate,
  busy,
  confirming,
  onEdit,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: {
  readonly rate: AnalyticsPricingRate;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onEdit: () => void;
  readonly onRequestRemove: () => void;
  readonly onCancelRemove: () => void;
  readonly onRemove: () => void;
}) {
  return confirming ? (
    <fieldset
      className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
      aria-label={`Confirm removal of ${rate.modelId}`}
    >
      <button
        type="button"
        className="kt-btn min-h-[44px] border-err-border text-err"
        disabled={busy}
        onClick={onRemove}
      >
        Confirm removal
      </button>
      <button type="button" className="kt-btn min-h-[44px]" disabled={busy} onClick={onCancelRemove}>
        Keep rate
      </button>
    </fieldset>
  ) : (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className="kt-btn min-h-[44px]"
        disabled={busy}
        data-pricing-edit={rate.pricingKey}
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="kt-btn min-h-[44px] text-err"
        disabled={busy}
        data-pricing-remove={rate.pricingKey}
        onClick={onRequestRemove}
      >
        Remove
      </button>
    </div>
  );
}

function CatalogLedger({
  rates,
  busy,
  confirmingKey,
  onEdit,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: {
  readonly rates: readonly AnalyticsPricingRate[];
  readonly busy: boolean;
  readonly confirmingKey: string | null;
  readonly onEdit: (rate: AnalyticsPricingRate) => void;
  readonly onRequestRemove: (pricingKey: string) => void;
  readonly onCancelRemove: () => void;
  readonly onRemove: (pricingKey: string) => void;
}) {
  if (rates.length === 0)
    return (
      <section className="kt-panel p-panel" data-pricing-empty="">
        <h4 className="m-0 text-ui font-semibold text-fg">No model rates configured</h4>
        <p className="mb-0 mt-1 text-meta leading-base text-muted">
          Usage stays explicitly unpriced until an operator adds a rate or applies selected provider changes.
        </p>
      </section>
    );

  return (
    <>
      <div className="hidden overflow-x-auto rounded-panel border border-border bg-surface shadow-panel xl:block">
        <table className="w-full min-w-[600px] table-fixed border-collapse text-left" data-pricing-ledger="desktop">
          <caption className="sr-only">Configured model pricing rates</caption>
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[60%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead className="bg-surface-2 text-meta uppercase tracking-label text-faint">
            <tr>
              <th scope="col" className="border-b border-border px-3 py-2 font-semibold">
                Model
              </th>
              <th scope="col" className="border-b border-border px-3 py-2 font-semibold">
                Pricing record
              </th>
              <th scope="col" className="border-b border-border px-3 py-2 font-semibold">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rates.map(rate => (
              <tr key={rate.pricingKey} className="align-top" data-pricing-row={rate.pricingKey}>
                <th scope="row" className="border-b border-border-soft px-3 py-3 font-normal">
                  <Identity rate={rate} />
                </th>
                <td className="border-b border-border-soft px-3 py-3">
                  <RateAmounts rates={rate.rates} />
                  <div className="my-3 border-t border-border-soft" />
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <Provenance rate={rate} />
                    <EffectiveDates rate={rate} />
                  </div>
                </td>
                <td className="border-b border-border-soft px-3 py-3">
                  <RateActions
                    rate={rate}
                    busy={busy}
                    confirming={confirmingKey === rate.pricingKey}
                    onEdit={() => onEdit(rate)}
                    onRequestRemove={() => onRequestRemove(rate.pricingKey)}
                    onCancelRemove={onCancelRemove}
                    onRemove={() => onRemove(rate.pricingKey)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 xl:hidden" data-pricing-ledger="mobile">
        {rates.map(rate => (
          <article key={rate.pricingKey} className="kt-panel min-w-0 p-panel" data-pricing-card={rate.pricingKey}>
            <Identity rate={rate} />
            <div className="my-3 border-t border-border-soft" />
            <RateAmounts rates={rate.rates} />
            <div className="my-3 border-t border-border-soft" />
            <Provenance rate={rate} />
            <div className="my-3 border-t border-border-soft" />
            <EffectiveDates rate={rate} />
            <div className="mt-3">
              <RateActions
                rate={rate}
                busy={busy}
                confirming={confirmingKey === rate.pricingKey}
                onEdit={() => onEdit(rate)}
                onRequestRemove={() => onRequestRemove(rate.pricingKey)}
                onCancelRemove={onCancelRemove}
                onRemove={() => onRemove(rate.pricingKey)}
              />
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

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
  const describedBy = [detail ? `${id}-detail` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <label className="grid min-w-0 gap-1 text-meta font-semibold text-fg" htmlFor={id}>
      {label}
      {detail ? (
        <span id={`${id}-detail`} className="font-normal leading-base text-faint">
          {detail}
        </span>
      ) : null}
      {typeof children === 'object' && children !== null ? (
        children
      ) : (
        <span aria-describedby={describedBy}>{children}</span>
      )}
      {error ? (
        <span id={`${id}-error`} className="font-normal leading-base text-err" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function PricingEditor({
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
  const inputClass =
    'h-control min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg focus-visible:outline-focus focus-visible:outline-offset-focus disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="kt-panel min-w-0 p-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby={`${formId}-heading`}
      data-pricing-editor={editing === null ? 'add' : editing.pricingKey}
    >
      <h4 id={`${formId}-heading`} className="m-0 text-title font-semibold text-fg">
        {editing === null ? 'Add a manual rate' : `Edit ${editing.modelId}`}
      </h4>
      <p className="mb-0 mt-1 text-meta leading-base text-muted">
        This save records manual provenance. Provider-sync provenance can only come from an applied feed preview.
      </p>
      {editing?.source.kind === 'provider_sync' ? (
        <p className="mb-0 mt-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn">
          This provider-synced row will become a manual override. Its source feed and last-sync claim will not be
          carried into the PATCH.
        </p>
      ) : null}
      {editing !== null ? (
        <p className="mb-0 mt-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta leading-base text-warn">
          Editing an effective historical rate can reprice rows during later analytics reingestion. Create a new
          effective window instead when prior history must keep its original price.
        </p>
      ) : null}
      <form
        className="mt-3 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2"
        onSubmit={submit}
        noValidate
        data-pricing-form=""
      >
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
          <select
            id={`${formId}-provider`}
            className={inputClass}
            value={draft.provider}
            disabled={busy}
            aria-invalid={errors.provider !== undefined}
            data-pricing-field="provider"
            onChange={event => onChange({ ...draft, provider: event.currentTarget.value as PricingDraft['provider'] })}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
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
            aria-describedby={errors.validThrough ? `${formId}-valid-through-error` : `${formId}-valid-through-detail`}
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
        <div className="rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-meta leading-base text-muted">
          Currency is fixed to USD. Amounts use the protocol-owned unit shown beside each field.
        </div>
        <fieldset className="grid min-w-0 grid-cols-1 gap-3 rounded-panel border border-border-soft p-3 lg:col-span-2 sm:grid-cols-2">
          <legend className="px-1 text-ui font-semibold text-fg">Rates</legend>
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
        {errors.form ? (
          <p className="m-0 text-meta text-err lg:col-span-2" role="alert">
            {errors.form}
          </p>
        ) : null}
        {failure ? (
          <p className="m-0 text-meta leading-base text-err lg:col-span-2" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 lg:col-span-2">
          <button type="submit" className="kt-btn kt-btn-primary min-h-[44px]" disabled={busy} data-pricing-save="">
            {busy ? 'Saving…' : editing === null ? 'Add rate' : 'Save manual override'}
          </button>
          <button type="button" className="kt-btn min-h-[44px]" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function ApplicabilityDisclosure({ view }: { readonly view: AnalyticsPricingView }) {
  const imageStored = view.rateApplicability.image === 'stored_not_applied';
  const toolStored = view.rateApplicability.tool === 'stored_not_applied';
  const reasoningApplied = view.rateApplicability.reasoning === 'applied_when_evidenced';
  return (
    <section className="kt-panel p-panel" aria-labelledby="pricing-coverage-heading" data-pricing-applicability="">
      <h4 id="pricing-coverage-heading" className="m-0 text-ui font-semibold text-fg">
        What analytics applies
      </h4>
      <p
        className="mb-0 mt-1 text-meta leading-base text-muted"
        data-rate-applicability={`image:${view.rateApplicability.image},tool:${view.rateApplicability.tool}`}
      >
        {imageStored && toolStored
          ? 'Image and tool rates can be recorded, but are not currently applied to analytics because reliable billable evidence is unavailable.'
          : 'Image and tool applicability follows the daemon record shown for this catalog.'}
      </p>
      <p
        className="mb-0 mt-1 text-meta leading-base text-muted"
        data-reasoning-applicability={view.rateApplicability.reasoning}
      >
        {reasoningApplied
          ? 'Reasoning rates are applied when transcript evidence exists.'
          : 'Reasoning rates are recorded but this daemon does not currently apply them.'}
      </p>
    </section>
  );
}

function Sources({
  sources,
  selectedSourceId,
  busy,
  onSelect,
  onPreview,
}: {
  readonly sources: readonly ConfiguredAnalyticsPricingSource[];
  readonly selectedSourceId: string;
  readonly busy: boolean;
  readonly onSelect: (sourceId: string) => void;
  readonly onPreview: () => void;
}) {
  const selectId = useId();
  const selected = sources.find(source => source.id === selectedSourceId);
  return (
    <section className="kt-panel min-w-0 p-panel" aria-labelledby="pricing-sources-heading">
      <h4 id="pricing-sources-heading" className="m-0 text-title font-semibold text-fg">
        Configured pricing feeds
      </h4>
      <p className="mb-0 mt-1 text-meta leading-base text-muted">
        Anthropic and OpenAI do not provide a machine-readable first-party pricing API. Ferretry checks only the JSON
        feeds already configured by this daemon’s operator; this screen never submits an arbitrary URL.
      </p>
      {sources.length === 0 ? (
        <p
          className="mb-0 mt-3 rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-meta text-muted"
          data-pricing-sources-empty=""
        >
          No pricing feed is configured. Add one in the daemon configuration before checking for updates.
        </p>
      ) : (
        <>
          <div className="mt-3 grid min-w-0 gap-2">
            {sources.map(source => (
              <article
                key={source.id}
                className="rounded-control border border-border-soft bg-surface-2 px-3 py-2"
                data-pricing-source={source.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="m-0 font-mono text-ui font-semibold text-fg">{source.id}</p>
                  <span
                    className={cn(
                      'rounded-control border px-2 py-0.5 text-meta font-semibold',
                      source.enabled ? 'border-ok-border bg-ok-bg text-ok' : 'border-border-soft bg-surface text-faint',
                    )}
                  >
                    {source.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="text-meta text-muted">{source.provider}</span>
                </div>
                <p className="mb-0 mt-1 break-all text-meta leading-base text-muted">{source.url}</p>
                <p className="mb-0 mt-1 text-meta text-faint">
                  Last applied: <DateValue value={source.lastSyncedAt} fallback="Never" />
                </p>
              </article>
            ))}
          </div>
          <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label htmlFor={selectId} className="grid min-w-0 gap-1 text-meta font-semibold text-fg">
              Feed to check
              <select
                id={selectId}
                className="h-control min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg"
                value={selectedSourceId}
                disabled={busy}
                data-pricing-source-select=""
                onChange={event => onSelect(event.currentTarget.value)}
              >
                <option value="">Choose a configured feed</option>
                {sources.map(source => (
                  <option key={source.id} value={source.id} disabled={!source.enabled}>
                    {source.id} · {source.provider}
                    {source.enabled ? '' : ' · disabled'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="kt-btn kt-btn-primary min-h-[44px]"
              disabled={busy || selected === undefined || !selected.enabled}
              data-pricing-preview=""
              onClick={onPreview}
            >
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function PreviewRate({ label, rate }: { readonly label: string; readonly rate: AnalyticsPricingRate }) {
  return (
    <div className="min-w-0 rounded-control border border-border-soft bg-surface-2 p-3">
      <p className="m-0 text-meta font-semibold uppercase tracking-label text-faint">{label}</p>
      <div className="mt-2">
        <Identity rate={rate} />
      </div>
      <div className="my-2 border-t border-border-soft" />
      <RateAmounts rates={rate.rates} />
      <div className="my-2 border-t border-border-soft" />
      <Provenance rate={rate} />
      <div className="mt-2">
        <EffectiveDates rate={rate} />
      </div>
    </div>
  );
}

function PreviewChange({
  change,
  selected,
  disabled,
  onSelect,
}: {
  readonly change: AnalyticsPricingSyncChange;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (selected: boolean) => void;
}) {
  const selectable = change.kind !== 'unchanged';
  return (
    <li
      className="min-w-0 rounded-panel border border-border bg-surface p-panel shadow-panel"
      data-pricing-change={change.kind}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span
            className={cn(
              'inline-flex rounded-control border px-2 py-0.5 text-meta font-semibold',
              change.kind === 'added'
                ? 'border-ok-border bg-ok-bg text-ok'
                : change.kind === 'updated'
                  ? 'border-warn-border bg-warn-bg text-warn'
                  : 'border-border-soft bg-surface-2 text-muted',
            )}
          >
            {change.kind === 'added' ? 'Added' : change.kind === 'updated' ? 'Changed' : 'Unchanged'}
          </span>
          <p className="mb-0 mt-1 break-all font-mono text-ui font-semibold text-fg">{change.pricingKey}</p>
        </div>
        {selectable ? (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-control border border-border px-3 text-ui font-semibold text-fg has-[:focus-visible]:outline-focus">
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              data-pricing-select={change.pricingKey}
              onChange={event => onSelect(event.currentTarget.checked)}
            />
            Apply this entry
          </label>
        ) : (
          <span className="text-meta text-faint">No action available</span>
        )}
      </div>
      <div className={cn('mt-3 grid min-w-0 gap-3', change.kind === 'updated' && 'lg:grid-cols-2')}>
        {change.kind === 'added' ? <PreviewRate label="Proposed" rate={change.after} /> : null}
        {change.kind === 'updated' ? (
          <>
            <PreviewRate label="Current" rate={change.before} />
            <PreviewRate label="Proposed" rate={change.after} />
          </>
        ) : null}
        {change.kind === 'unchanged' ? <PreviewRate label="Current · no change" rate={change.before} /> : null}
      </div>
    </li>
  );
}

function SyncPreview({
  preview,
  selected,
  busy,
  invalidMessage,
  error,
  onSelect,
  onApply,
  onFreshPreview,
}: {
  readonly preview: AnalyticsPricingSyncPreview;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly invalidMessage: string | null;
  readonly error: string | null;
  readonly onSelect: (pricingKey: string, selected: boolean) => void;
  readonly onApply: () => void;
  readonly onFreshPreview: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby="pricing-preview-heading"
      data-pricing-preview-id={preview.previewId}
    >
      <header className="kt-panel p-panel">
        <p className="m-0 text-meta font-semibold uppercase tracking-label text-accent">Review ledger</p>
        <h4 id="pricing-preview-heading" className="mb-0 mt-1 text-title font-semibold text-fg">
          Provider changes
        </h4>
        <p className="mb-0 mt-1 text-meta leading-base text-muted">
          Fetched from configured source <span className="font-mono text-fg">{preview.sourceId}</span> at{' '}
          <DateValue value={preview.fetchedAt} />. Nothing is selected by default.
        </p>
        <p className="mb-0 mt-1 break-all text-meta leading-base text-faint">{preview.sourceUrl}</p>
      </header>
      {invalidMessage ? (
        <div
          className="mt-3 rounded-panel border border-warn-border bg-warn-bg p-panel text-warn"
          role="alert"
          data-pricing-preview-stale=""
        >
          <p className="m-0 text-ui font-semibold">This preview can no longer be applied</p>
          <p className="mb-0 mt-1 text-meta leading-base">{invalidMessage}</p>
          <button type="button" className="kt-btn mt-3 min-h-[44px]" disabled={busy} onClick={onFreshPreview}>
            Run a fresh preview
          </button>
        </div>
      ) : null}
      {error ? (
        <p
          className="mt-3 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta leading-base text-err"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {preview.changes.length === 0 ? (
        <p
          className="mt-3 rounded-panel border border-border bg-surface p-panel text-ui text-muted"
          data-pricing-preview-empty=""
        >
          This configured feed proposed no catalog entries.
        </p>
      ) : (
        <ul className="m-0 mt-3 grid min-w-0 list-none gap-3 p-0">
          {preview.changes.map(change => (
            <PreviewChange
              key={change.pricingKey}
              change={change}
              selected={selected.has(change.pricingKey)}
              disabled={busy || invalidMessage !== null}
              onSelect={checked => onSelect(change.pricingKey, checked)}
            />
          ))}
        </ul>
      )}
      <div className="sticky bottom-2 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-panel border border-border bg-surface p-3 shadow-panel">
        <p className="m-0 text-meta font-semibold text-muted" aria-live="polite">
          {selected.size} selected · {preview.changes.filter(change => change.kind !== 'unchanged').length} applicable
        </p>
        <button
          type="button"
          className="kt-btn kt-btn-primary min-h-[44px]"
          disabled={busy || selected.size === 0 || invalidMessage !== null}
          data-pricing-apply=""
          onClick={onApply}
        >
          {busy ? 'Applying…' : 'Apply selected'}
        </button>
      </div>
    </section>
  );
}

export function PricingSettings({
  connection,
  createClient = daemonApiClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: AnalyticsPricingClientFactory;
}) {
  const [state, setState] = useState<PricingLoadState>({ status: 'loading' });
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [editing, setEditing] = useState<AnalyticsPricingRate | null>(null);
  const [fieldErrors, setFieldErrors] = useState<PricingFieldErrors>({});
  const [mutationFailure, setMutationFailure] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<AnalyticsPricingSyncPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewInvalidMessage, setPreviewInvalidMessage] = useState<string | null>(null);
  const [selectedPricingKeys, setSelectedPricingKeys] = useState<ReadonlySet<string>>(new Set());
  const readGeneration = useRef(0);
  const scopeGeneration = useRef(0);

  const publishView = useCallback((view: AnalyticsPricingView, nextNotice?: string): void => {
    setState({ status: 'ready', view });
    setStaleMessage(null);
    setSourceId(current => (view.sources.some(source => source.id === current && source.enabled) ? current : ''));
    if (nextNotice !== undefined) setNotice(nextNotice);
  }, []);

  const refresh = useCallback(
    async (preserveCurrent: boolean): Promise<void> => {
      const generation = ++readGeneration.current;
      setNotice(null);
      if (preserveCurrent) setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const view = await readAnalyticsPricing(await createClient(connection));
        if (generation !== readGeneration.current) return;
        publishView(view, preserveCurrent ? 'Catalog refreshed.' : undefined);
      } catch (error) {
        if (generation !== readGeneration.current) return;
        const message = errorMessage(error);
        if (preserveCurrent) setStaleMessage(`The last refresh failed: ${message}`);
        else setState({ status: 'failed', message });
      } finally {
        if (generation === readGeneration.current) setRefreshing(false);
      }
    },
    [connection, createClient, publishView],
  );

  useLayoutEffect(() => {
    const generation = ++scopeGeneration.current;
    setRefreshing(false);
    setMutationBusy(false);
    setPreviewBusy(false);
    setDraft(null);
    setEditing(null);
    setFieldErrors({});
    setMutationFailure(null);
    setConfirmingKey(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewInvalidMessage(null);
    setSelectedPricingKeys(new Set());
    setSourceId('');
    setStaleMessage(null);
    void refresh(false);
    return () => {
      if (generation === scopeGeneration.current) scopeGeneration.current += 1;
      readGeneration.current += 1;
    };
  }, [refresh]);

  const openAdd = (): void => {
    setEditing(null);
    setDraft(blankDraft());
    setFieldErrors({});
    setMutationFailure(null);
    setConfirmingKey(null);
  };

  const openEdit = (rate: AnalyticsPricingRate): void => {
    setEditing(rate);
    setDraft(rateDraft(rate));
    setFieldErrors({});
    setMutationFailure(null);
    setConfirmingKey(null);
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === null || state.status !== 'ready') return;
    const parsed = draftRate(draft);
    setFieldErrors(parsed.errors);
    setMutationFailure(null);
    if (parsed.rate === undefined) return;
    const generation = scopeGeneration.current;
    setMutationBusy(true);
    try {
      const view = await patchAnalyticsPricing(await createClient(connection), {
        expectedCatalogFingerprint: state.view.catalogFingerprint,
        operations: [{ op: 'upsert', rate: parsed.rate }],
      });
      if (generation !== scopeGeneration.current) return;
      publishView(view, editing === null ? 'Manual rate added.' : 'Manual override saved.');
      setDraft(null);
      setEditing(null);
      setPreview(null);
      setSelectedPricingKeys(new Set());
    } catch (error) {
      if (generation !== scopeGeneration.current) return;
      if (isCatalogConflict(error)) {
        const message =
          'The pricing catalog changed after this form opened. Refresh the catalog, review the current row, and retry your save.';
        setMutationFailure(message);
        setStaleMessage(message);
      } else setMutationFailure(errorMessage(error));
    } finally {
      if (generation === scopeGeneration.current) setMutationBusy(false);
    }
  };

  const removeRate = async (pricingKey: string): Promise<void> => {
    if (state.status !== 'ready') return;
    const generation = scopeGeneration.current;
    setMutationBusy(true);
    setMutationFailure(null);
    try {
      const view = await patchAnalyticsPricing(await createClient(connection), {
        expectedCatalogFingerprint: state.view.catalogFingerprint,
        operations: [{ op: 'remove', pricingKey }],
      });
      if (generation !== scopeGeneration.current) return;
      publishView(view, 'Rate removed.');
      setConfirmingKey(null);
      setPreview(null);
      setSelectedPricingKeys(new Set());
    } catch (error) {
      if (generation !== scopeGeneration.current) return;
      if (isCatalogConflict(error)) {
        const message =
          'The pricing catalog changed before this removal. Refresh it and confirm the current row before retrying.';
        setMutationFailure(message);
        setStaleMessage(message);
      } else setMutationFailure(errorMessage(error));
    } finally {
      if (generation === scopeGeneration.current) setMutationBusy(false);
    }
  };

  const requestPreview = async (): Promise<void> => {
    if (state.status !== 'ready' || sourceId === '') return;
    const generation = scopeGeneration.current;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const next = await previewAnalyticsPricingSync(await createClient(connection), {
        sourceId,
        expectedCatalogFingerprint: state.view.catalogFingerprint,
      });
      if (generation !== scopeGeneration.current) return;
      setPreview(next);
      setSelectedPricingKeys(new Set());
      setPreviewInvalidMessage(null);
      setNotice('Fresh provider preview ready. Nothing is selected.');
    } catch (error) {
      if (generation !== scopeGeneration.current) return;
      if (isCatalogConflict(error)) {
        const message =
          'The catalog or configured source changed before this preview completed. Refresh the catalog, then request a fresh preview.';
        setPreviewError(message);
        setStaleMessage(message);
      } else setPreviewError(errorMessage(error));
    } finally {
      if (generation === scopeGeneration.current) setPreviewBusy(false);
    }
  };

  const applyPreview = async (): Promise<void> => {
    if (preview === null || selectedPricingKeys.size === 0) return;
    const generation = scopeGeneration.current;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const view = await applyAnalyticsPricingSync(await createClient(connection), {
        previewId: preview.previewId,
        expectedCatalogFingerprint: preview.baseCatalogFingerprint,
        expectedResultFingerprint: preview.resultCatalogFingerprint,
        selectedPricingKeys: [...selectedPricingKeys],
      });
      if (generation !== scopeGeneration.current) return;
      publishView(view, 'Selected provider changes applied. Catalog and sync metadata are current.');
      setPreview(null);
      setPreviewInvalidMessage(null);
      setSelectedPricingKeys(new Set());
    } catch (error) {
      if (generation !== scopeGeneration.current) return;
      if (isPreviewConflict(error)) {
        setPreviewInvalidMessage(
          `${errorMessage(error)} The reviewed diff remains visible, but Ferretry will not refetch or apply it automatically.`,
        );
      } else setPreviewError(errorMessage(error));
    } finally {
      if (generation === scopeGeneration.current) setPreviewBusy(false);
    }
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby="model-pricing-heading"
      data-pricing-daemon={String(connection.daemonId)}
    >
      <header className="kt-panel p-panel">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-meta font-semibold uppercase tracking-label text-accent">Analytics catalog</p>
            <h3 id="model-pricing-heading" className="mb-0 mt-1 text-title font-semibold text-fg">
              Model pricing
            </h3>
            <p className="mb-0 mt-1 text-ui leading-base text-muted">
              Rates, provenance, effective windows, and configured feeds for this daemon. Ferretry never guesses a price
              for unpriced usage.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={refreshing || state.status !== 'ready'}
              data-pricing-refresh=""
              onClick={() => void refresh(true)}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="kt-btn kt-btn-primary min-h-[44px]"
              disabled={state.status !== 'ready' || mutationBusy}
              data-pricing-add=""
              onClick={openAdd}
            >
              Add manual rate
            </button>
          </div>
        </div>
      </header>

      {notice ? (
        <p
          className="m-0 rounded-control border border-ok-border bg-ok-bg px-3 py-2 text-meta text-ok"
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
      ) : null}
      {staleMessage ? (
        <div
          className="rounded-panel border border-warn-border bg-warn-bg p-panel text-warn"
          role="status"
          data-pricing-stale=""
        >
          <p className="m-0 text-ui font-semibold">Showing stale pricing data</p>
          <p className="mb-0 mt-1 text-meta leading-base">{staleMessage}</p>
          <button
            type="button"
            className="kt-btn mt-3 min-h-[44px]"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            Refresh catalog
          </button>
        </div>
      ) : null}

      {state.status === 'loading' ? (
        <section className="kt-panel p-panel" role="status" aria-live="polite" data-pricing-loading="">
          <p className="m-0 text-ui text-muted">Loading model pricing…</p>
        </section>
      ) : state.status === 'failed' ? (
        <section className="kt-panel border-err-border bg-err-bg p-panel" role="alert" data-pricing-error="">
          <h4 className="m-0 text-ui font-semibold text-err">Model pricing unavailable</h4>
          <p className="mb-0 mt-1 text-meta leading-base text-err">{state.message}</p>
          <button type="button" className="kt-btn mt-3 min-h-[44px]" onClick={() => void refresh(false)}>
            Retry
          </button>
        </section>
      ) : (
        <>
          <ApplicabilityDisclosure view={state.view} />
          {draft === null ? null : (
            <PricingEditor
              key={editing?.pricingKey ?? 'new-rate'}
              draft={draft}
              editing={editing}
              errors={fieldErrors}
              busy={mutationBusy}
              failure={mutationFailure}
              onChange={setDraft}
              onCancel={() => {
                setDraft(null);
                setEditing(null);
                setFieldErrors({});
                setMutationFailure(null);
              }}
              onSubmit={() => void saveDraft()}
            />
          )}
          {mutationFailure && draft === null ? (
            <p
              className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta text-err"
              role="alert"
            >
              {mutationFailure}
            </p>
          ) : null}
          <section className="min-w-0" aria-labelledby="pricing-catalog-heading">
            <div className="mb-2 flex min-w-0 flex-wrap items-end justify-between gap-2 px-1">
              <div>
                <h4 id="pricing-catalog-heading" className="m-0 text-title font-semibold text-fg">
                  Current catalog
                </h4>
                <p className="mb-0 mt-1 text-meta text-muted">
                  {state.view.catalog.length} configured rate{state.view.catalog.length === 1 ? '' : 's'}
                </p>
              </div>
              <p className="m-0 break-all font-mono text-meta text-faint">
                Fingerprint: {state.view.catalogFingerprint}
              </p>
            </div>
            <CatalogLedger
              rates={state.view.catalog}
              busy={mutationBusy}
              confirmingKey={confirmingKey}
              onEdit={openEdit}
              onRequestRemove={pricingKey => {
                setConfirmingKey(pricingKey);
                setMutationFailure(null);
              }}
              onCancelRemove={() => setConfirmingKey(null)}
              onRemove={pricingKey => void removeRate(pricingKey)}
            />
          </section>
          <Sources
            sources={state.view.sources}
            selectedSourceId={sourceId}
            busy={previewBusy}
            onSelect={setSourceId}
            onPreview={() => void requestPreview()}
          />
          {previewBusy && preview === null ? (
            <p
              className="m-0 rounded-control border border-border bg-surface px-3 py-2 text-ui text-muted"
              role="status"
            >
              Checking the configured feed…
            </p>
          ) : null}
          {previewError && preview === null ? (
            <p
              className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta text-err"
              role="alert"
            >
              {previewError}
            </p>
          ) : null}
          {preview === null ? null : (
            <SyncPreview
              key={preview.previewId}
              preview={preview}
              selected={selectedPricingKeys}
              busy={previewBusy}
              invalidMessage={previewInvalidMessage}
              error={previewError}
              onSelect={(pricingKey, selected) => {
                setSelectedPricingKeys(current => {
                  const next = new Set(current);
                  if (selected) next.add(pricingKey);
                  else next.delete(pricingKey);
                  return next;
                });
              }}
              onApply={() => void applyPreview()}
              onFreshPreview={() => void requestPreview()}
            />
          )}
        </>
      )}
    </section>
  );
}

export const pricingSettingsTab = (createClient: AnalyticsPricingClientFactory) =>
  ({
    id: 'model-pricing',
    label: 'Model pricing',
    description: 'Model rates, provenance, manual overrides, and configured provider feeds.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <PricingSettings connection={connection} createClient={createClient} />
    ),
  }) as const;
