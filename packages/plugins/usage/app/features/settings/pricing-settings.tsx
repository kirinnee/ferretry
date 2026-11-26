/**
 * SETTINGS › MODEL PRICING: the rates this daemon prices usage with, where each came from, and the feeds it can check.
 *
 * This file is the page's state and its calls; what is drawn lives beside it (`pricing-ledger.tsx` the two rate lists,
 * `pricing-editor.tsx` the manual-rate form, `pricing-sources.tsx` what insights applies and the feeds,
 * `pricing-sync-preview.tsx` the review of a feed), the pure words and parsing in `pricing-model.ts`.
 */
import { Button, Loading, PanelPath, readPress } from '@ferretry/app/ui';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type {
  AnalyticsPricingRate,
  AnalyticsPricingSyncPreview,
  AnalyticsPricingView,
} from '../../../contract/index.ts';
import type { DaemonConnection } from '../../shell.ts';
import { PricingEditor } from './pricing-editor.tsx';
import { CatalogLedger, ModelCatalogRates } from './pricing-ledger.tsx';
import {
  blankDraft,
  draftRate,
  errorMessage,
  isCatalogConflict,
  isPreviewConflict,
  type PricingDraft,
  type PricingFieldErrors,
  type PricingLoadState,
  rateDraft,
} from './pricing-model.ts';
import { ApplicabilityDisclosure, Sources } from './pricing-sources.tsx';
import { SyncPreview } from './pricing-sync-preview.tsx';
import {
  type AnalyticsPricingClient,
  applyAnalyticsPricingSync,
  patchAnalyticsPricing,
  previewAnalyticsPricingSync,
  readAnalyticsPricing,
} from './pricing-api.ts';

export function PricingSettings({
  connection,
  client,
}: {
  readonly connection: DaemonConnection;
  /** This daemon's client, which the catalog is read and written through. */
  readonly client: AnalyticsPricingClient;
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
    // `pressed`: a person asked for this read (Refresh, Retry), so it may open the passkey prompt; the page's own never does.
    async (preserveCurrent: boolean, pressed = preserveCurrent): Promise<void> => {
      const generation = ++readGeneration.current;
      setNotice(null);
      if (preserveCurrent) setRefreshing(true);
      else setState({ status: 'loading' });
      try {
        const view = await readAnalyticsPricing(client, readPress(pressed));
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
    [client, publishView],
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

  const openOverride = (rate: AnalyticsPricingRate): void => {
    setEditing(null);
    setDraft({ ...rateDraft(rate), pricingKey: `operator:${rate.modelId}` });
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
      const view = await patchAnalyticsPricing(client, {
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
      const view = await patchAnalyticsPricing(client, {
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
      const next = await previewAnalyticsPricingSync(client, {
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
      const view = await applyAnalyticsPricingSync(client, {
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
      className="fy-usage-settings flex min-w-0 flex-col gap-8"
      aria-label="Model pricing"
      data-pricing-daemon={String(connection.daemonId)}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <p className="m-0 text-cell leading-base text-muted">
            Rates, where each came from, and the feeds this daemon can check. Ferretry never guesses a price for
            unpriced usage.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-[44px]"
            disabled={refreshing || state.status !== 'ready'}
            data-pricing-refresh=""
            onClick={() => void refresh(true)}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-[44px]"
            disabled={state.status !== 'ready' || mutationBusy}
            data-pricing-add=""
            onClick={openAdd}
          >
            Add manual rate
          </Button>
        </div>
      </div>

      {notice ? (
        <p
          className="m-0 rounded-panel border border-ok-border bg-ok-bg px-panel py-2 text-meta text-ok"
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
      ) : null}
      {staleMessage ? (
        <div
          className="flex min-w-0 flex-col items-start gap-2 rounded-panel border border-warn-border bg-warn-bg p-panel text-warn"
          role="status"
          data-pricing-stale=""
        >
          <p className="m-0 text-ui font-semibold">Showing stale pricing data</p>
          <p className="m-0 text-meta leading-base">{staleMessage}</p>
          <Button type="button" className="min-h-[44px]" disabled={refreshing} onClick={() => void refresh(true)}>
            Refresh catalog
          </Button>
        </div>
      ) : null}

      {state.status === 'loading' ? (
        <Loading kind="page" label="Loading model pricing…" />
      ) : state.status === 'failed' ? (
        <section
          className="flex min-w-0 flex-col items-start gap-2 rounded-panel border border-err-border bg-err-bg p-panel"
          role="alert"
          data-pricing-error=""
        >
          <h4 className="m-0 text-ui font-semibold text-err">Model pricing unavailable</h4>
          <p className="m-0 text-meta leading-base text-err">{state.message}</p>
          <Button type="button" className="min-h-[44px]" onClick={() => void refresh(false, true)}>
            Retry
          </Button>
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
              className="m-0 rounded-panel border border-err-border bg-err-bg px-panel py-2 text-meta text-err"
              role="alert"
            >
              {mutationFailure}
            </p>
          ) : null}
          <div className="min-w-0">
            <CatalogLedger
              rates={state.view.catalog}
              catalogPriced={state.view.modelCatalogRates.length > 0}
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
            <p className="mb-0 mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 px-1 text-meta text-muted">
              <span>
                {state.view.catalog.length} configured rate{state.view.catalog.length === 1 ? '' : 's'}
              </span>
              <span className="flex min-w-0 gap-1 text-faint">
                Fingerprint: <PanelPath value={state.view.catalogFingerprint} className="text-faint" />
              </span>
            </p>
          </div>
          <ModelCatalogRates rates={state.view.modelCatalogRates} busy={mutationBusy} onOverride={openOverride} />
          <Sources
            sources={state.view.sources}
            selectedSourceId={sourceId}
            busy={previewBusy}
            onSelect={setSourceId}
            onPreview={() => void requestPreview()}
          />
          {previewBusy && preview === null ? <Loading kind="bar" label="Checking the configured feed…" /> : null}
          {previewError && preview === null ? (
            <p
              className="m-0 rounded-panel border border-err-border bg-err-bg px-panel py-2 text-meta text-err"
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
