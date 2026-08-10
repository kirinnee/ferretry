import { describe, expect, it } from 'bun:test';
import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingRate,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import {
  type AnalyticsPricingClientFactory,
  PricingSettings,
  pricingSettingsTab,
} from '../../../../src/features/settings/pricing-settings.tsx';
import { type DaemonConnection, daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const connection = (id = 'alpha') =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });

const manualRate = (overrides: Partial<AnalyticsPricingRate> = {}): AnalyticsPricingRate => ({
  pricingKey: 'openai:gpt-5:2026-08',
  modelId: 'gpt-5',
  aliases: ['gpt-5-2026-08-01'],
  provider: 'openai',
  currency: 'USD',
  rates: {
    input: 1_250_000,
    output: 10_000_000,
    cachedInput: 125_000,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 2_000_000,
    image: 40_000,
    tool: 10_000,
  },
  source: { kind: 'manual' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T08:00:00.000Z',
  lastSyncedAt: null,
  ...overrides,
});

const syncedRate = (overrides: Partial<AnalyticsPricingRate> = {}): AnalyticsPricingRate => ({
  ...manualRate(),
  source: {
    kind: 'provider_sync',
    provider: 'openai',
    sourceUrl: 'https://pricing.example.test/openai.json',
  },
  lastSyncedAt: '2026-08-05T12:00:00.000Z',
  ...overrides,
});

const pricingView = (overrides: Partial<AnalyticsPricingView> = {}): AnalyticsPricingView => ({
  catalog: [manualRate()],
  catalogFingerprint: 'catalog-current',
  sources: [
    {
      id: 'openai-feed',
      provider: 'openai',
      url: 'https://pricing.example.test/openai.json',
      enabled: true,
      lastSyncedAt: null,
    },
    {
      id: 'anthropic-disabled',
      provider: 'anthropic',
      url: 'https://pricing.example.test/anthropic.json',
      enabled: false,
      lastSyncedAt: null,
    },
  ],
  sourcesFingerprint: 'sources-current',
  rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
  ...overrides,
});

const preview = (overrides: Partial<AnalyticsPricingSyncPreview> = {}): AnalyticsPricingSyncPreview => {
  const fetchedAt = '2026-08-06T12:00:00.000Z';
  const added = syncedRate({
    pricingKey: 'openai:gpt-5-mini:2026-08',
    modelId: 'gpt-5-mini',
    aliases: [],
    validFrom: '2026-08-06T00:00:00.000Z',
    verifiedAt: fetchedAt,
    lastSyncedAt: fetchedAt,
  });
  const updated = syncedRate({
    rates: { ...manualRate().rates, input: 2_000_000 },
    verifiedAt: fetchedAt,
    lastSyncedAt: fetchedAt,
  });
  return {
    previewId: 'preview-1',
    sourceId: 'openai-feed',
    provider: 'openai',
    sourceUrl: 'https://pricing.example.test/openai.json',
    fetchedAt,
    baseCatalogFingerprint: 'catalog-current',
    resultCatalogFingerprint: 'catalog-proposed',
    changes: [
      { kind: 'added', pricingKey: added.pricingKey, after: added },
      { kind: 'updated', pricingKey: updated.pricingKey, before: manualRate(), after: updated },
      {
        kind: 'unchanged',
        pricingKey: 'openai:gpt-5-nano:2026-08',
        before: manualRate({
          pricingKey: 'openai:gpt-5-nano:2026-08',
          modelId: 'gpt-5-nano',
          aliases: [],
        }),
      },
    ],
    ...overrides,
  };
};

interface PricingCall {
  readonly connectionId: string;
  readonly path: string;
  readonly init: RequestInit | undefined;
}

type Answer = unknown | Error;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
}

const deferred = <Value,>(): Deferred<Value> => {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

type RoutedAnswer = unknown | Error | Promise<unknown>;

const routedPricingApi = (answers: Readonly<Record<string, readonly RoutedAnswer[]>>) => {
  const calls: PricingCall[] = [];
  const queues = new Map(Object.entries(answers).map(([key, values]) => [key, [...values]]));
  const createClient: AnalyticsPricingClientFactory = async daemon => {
    const connectionId = String(daemon.daemonId);
    return {
      request: (async (path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
        calls.push({ connectionId, path, init });
        const key = `${connectionId} ${init?.method ?? 'GET'} ${path}`;
        const answer = queues.get(key)?.shift();
        if (answer === undefined) throw new Error(`missing routed pricing answer for ${key}`);
        const resolved = await answer;
        if (resolved instanceof Error) throw resolved;
        return schema.parse(resolved);
      }) as never,
    };
  };
  return { calls, createClient };
};

const pricingApi = (...answers: readonly Answer[]) => {
  const calls: PricingCall[] = [];
  let answerIndex = 0;
  let activeConnection = '';
  const client = {
    request: (async (path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
      calls.push({ connectionId: activeConnection, path, init });
      const answer = answers[answerIndex++];
      if (answer instanceof Error) throw answer;
      return schema.parse(answer);
    }) as never,
  };
  const createClient: AnalyticsPricingClientFactory = async daemon => {
    activeConnection = String(daemon.daemonId);
    return client;
  };
  return { calls, createClient };
};

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const marked = (renderer: ReactTestRenderer, attribute: string, value?: string): ReactTestInstance[] =>
  renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props[attribute] !== undefined &&
      (value === undefined || node.props[attribute] === value),
  );

const press = (renderer: ReactTestRenderer, attribute: string, value?: string): void => {
  const target = marked(renderer, attribute, value)[0];
  if (target === undefined) throw new Error(`missing ${attribute}`);
  run(() => target.props.onClick());
};

const change = (renderer: ReactTestRenderer, attribute: string, value: string, next: string): void => {
  const target = marked(renderer, attribute, value)[0];
  if (target === undefined) throw new Error(`missing ${attribute}=${value}`);
  run(() => target.props.onChange({ currentTarget: { value: next } }));
};

const toggle = (renderer: ReactTestRenderer, pricingKey: string, checked: boolean): void => {
  const target = marked(renderer, 'data-pricing-select', pricingKey)[0];
  if (target === undefined) throw new Error(`missing selection ${pricingKey}`);
  run(() => target.props.onChange({ currentTarget: { checked } }));
};

const submitPricingForm = (renderer: ReactTestRenderer): void => {
  const form = marked(renderer, 'data-pricing-form')[0];
  if (form === undefined) throw new Error('missing pricing form');
  run(() => form.props.onSubmit({ preventDefault: () => undefined }));
};

const enterValidManualDraft = (renderer: ReactTestRenderer, pricingKey: string, modelId: string): void => {
  change(renderer, 'data-pricing-field', 'pricingKey', pricingKey);
  change(renderer, 'data-pricing-field', 'modelId', modelId);
  change(renderer, 'data-pricing-field', 'aliases', `${modelId}-alias`);
  change(renderer, 'data-pricing-field', 'validFrom', '2026-08-06T00:00:00.000Z');
  change(renderer, 'data-pricing-field', 'verifiedAt', '2026-08-06T01:00:00.000Z');
  change(renderer, 'data-pricing-rate-field', 'input', '1.25');
  change(renderer, 'data-pricing-rate-field', 'output', '10');
  change(renderer, 'data-pricing-rate-field', 'cachedInput', '0.125');
};

const buttonNamed = (renderer: ReactTestRenderer, name: string): ReactTestInstance => {
  const target = renderer.root.findAll(
    node => typeof node.type === 'string' && node.type === 'button' && node.children.join('') === name,
  )[0];
  if (target === undefined) throw new Error(`missing button ${name}`);
  return target;
};

const renderPricing = async (api: ReturnType<typeof pricingApi>, daemon = connection()): Promise<ReactTestRenderer> => {
  const renderer = render(<PricingSettings connection={daemon} createClient={api.createClient} />);
  await settle();
  return renderer;
};

describe('PricingSettings', () => {
  it('loads a dense catalog with explicit rates, provenance, source metadata, limitations, and daemon scope', async () => {
    const api = pricingApi(pricingView({ catalog: [syncedRate()] }));

    const renderer = await renderPricing(api);
    const rendered = text(renderer);

    expect(marked(renderer, 'data-pricing-loading')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-row', 'openai:gpt-5:2026-08')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-ledger', 'desktop')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-ledger', 'mobile')).toHaveLength(1);
    expect(rendered).toContain('gpt-5-2026-08-01');
    expect(rendered).toContain('$1.25 USD / million tokens');
    expect(rendered).toContain('Provider sync · ');
    expect(rendered).toContain('Last sync:');
    expect(rendered).toContain('Image and tool rates can be recorded');
    expect(rendered).toContain('Reasoning rates are applied when transcript evidence exists');
    expect(rendered).toContain('do not provide a machine-readable first-party pricing API');
    expect(marked(renderer, 'data-pricing-daemon', 'alpha')).toHaveLength(1);
    expect(api.calls.map(call => call.connectionId)).toEqual(['alpha']);
  });

  it('renders honest empty catalog and configured-source states', async () => {
    const renderer = await renderPricing(pricingApi(pricingView({ catalog: [], sources: [] })));

    expect(marked(renderer, 'data-pricing-empty')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-sources-empty')).toHaveLength(1);
    expect(text(renderer)).toContain('Usage stays explicitly unpriced');
    expect(text(renderer)).not.toContain('https://attacker');
  });

  it('shows an initial error and retries only when the operator asks', async () => {
    const api = pricingApi(new Error('daemon offline'), pricingView({ catalog: [] }));
    const renderer = await renderPricing(api);

    expect(marked(renderer, 'data-pricing-error')).toHaveLength(1);
    expect(text(renderer)).toContain('daemon offline');

    run(() => buttonNamed(renderer, 'Retry').props.onClick());
    await settle();

    expect(marked(renderer, 'data-pricing-error')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-empty')).toHaveLength(1);
    expect(api.calls).toHaveLength(2);
  });

  it('keeps the last catalog visible and marks it stale after a failed refresh', async () => {
    const api = pricingApi(pricingView(), new Error('refresh timed out'));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-refresh');
    await settle();

    expect(marked(renderer, 'data-pricing-stale')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-row', 'openai:gpt-5:2026-08')).toHaveLength(1);
    expect(text(renderer)).toContain('refresh timed out');
  });

  it('uses the shared schema for field errors and preserves authored input after a failed save', async () => {
    const api = pricingApi(pricingView({ catalog: [] }), new Error('configuration write failed'));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-add');
    submitPricingForm(renderer);
    expect(api.calls).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-field', 'pricingKey')[0]?.props['aria-invalid']).toBe(true);
    expect(marked(renderer, 'data-pricing-field', 'validFrom')[0]?.props['aria-invalid']).toBe(true);
    expect(marked(renderer, 'data-pricing-rate-field', 'input')[0]?.props['aria-invalid']).toBe(true);

    change(renderer, 'data-pricing-field', 'pricingKey', 'manual:gpt-5.1:2026-08');
    change(renderer, 'data-pricing-field', 'modelId', 'gpt-5.1');
    change(renderer, 'data-pricing-field', 'aliases', 'gpt-5.1-chat');
    change(renderer, 'data-pricing-field', 'validFrom', '2026-08-06T00:00:00.000Z');
    change(renderer, 'data-pricing-field', 'verifiedAt', '2026-08-06T01:00:00.000Z');
    change(renderer, 'data-pricing-rate-field', 'input', '1.25');
    change(renderer, 'data-pricing-rate-field', 'output', '10');
    change(renderer, 'data-pricing-rate-field', 'cachedInput', '0.125');
    submitPricingForm(renderer);
    await settle();

    expect(text(renderer)).toContain('configuration write failed');
    expect(marked(renderer, 'data-pricing-field', 'modelId')[0]?.props.value).toBe('gpt-5.1');
    const body = JSON.parse(String(api.calls[1]?.init?.body));
    expect(body.operations[0].rate).toMatchObject({
      pricingKey: 'manual:gpt-5.1:2026-08',
      modelId: 'gpt-5.1',
      aliases: ['gpt-5.1-chat'],
      source: { kind: 'manual' },
      lastSyncedAt: null,
      rates: { input: 1_250_000, output: 10_000_000, cachedInput: 125_000 },
    });
  });

  it('turns a provider-synced edit into canonical manual provenance and warns about historical repricing', async () => {
    const before = pricingView({ catalog: [syncedRate()] });
    const afterRate = manualRate({ rates: { ...manualRate().rates, input: 9_500_000 } });
    const api = pricingApi(before, pricingView({ catalog: [afterRate], catalogFingerprint: 'catalog-after-edit' }));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-edit', syncedRate().pricingKey);
    expect(text(renderer)).toContain('will become a manual override');
    expect(text(renderer)).toContain('can reprice rows during later analytics reingestion');
    expect(text(renderer)).toContain('Create a new effective window');
    change(renderer, 'data-pricing-rate-field', 'input', '9.5');
    submitPricingForm(renderer);
    await settle();

    const body = JSON.parse(String(api.calls[1]?.init?.body));
    expect(body.expectedCatalogFingerprint).toBe('catalog-current');
    expect(body.operations[0].rate.source).toEqual({ kind: 'manual' });
    expect(body.operations[0].rate.lastSyncedAt).toBeNull();
    expect(body.operations[0].rate.rates.input).toBe(9_500_000);
    expect(marked(renderer, 'data-pricing-editor')).toHaveLength(0);
    expect(text(renderer)).toContain('Manual override saved');
  });

  it('requires explicit removal confirmation and surfaces a stale-write conflict without deleting the row', async () => {
    const api = pricingApi(pricingView(), new FyHttpError('catalog moved', 409, 'analytics_pricing_stale_catalog'));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-remove', manualRate().pricingKey);
    run(() => buttonNamed(renderer, 'Confirm removal').props.onClick());
    await settle();

    const body = JSON.parse(String(api.calls[1]?.init?.body));
    expect(body.operations).toEqual([{ op: 'remove', pricingKey: manualRate().pricingKey }]);
    expect(marked(renderer, 'data-pricing-stale')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-row', manualRate().pricingKey)).toHaveLength(1);
    expect(text(renderer)).toContain('Refresh it and confirm the current row');
  });

  it('previews only configured feeds, selects nothing, and applies only checked changed rows', async () => {
    const applied = pricingView({
      catalog: [manualRate({ rates: { ...manualRate().rates, input: 2_000_000 } })],
      catalogFingerprint: 'catalog-applied',
      sources: [
        {
          id: 'openai-feed',
          provider: 'openai',
          url: 'https://pricing.example.test/openai.json',
          enabled: true,
          lastSyncedAt: '2026-08-06T12:00:00.000Z',
        },
      ],
    });
    const api = pricingApi(pricingView(), preview(), applied);
    const renderer = await renderPricing(api);

    const sourceSelect = marked(renderer, 'data-pricing-source-select')[0];
    const previewButton = marked(renderer, 'data-pricing-preview')[0];
    expect(sourceSelect?.props.value).toBe('');
    expect(previewButton?.props.disabled).toBe(true);
    const disabledOption = sourceSelect?.findAll(
      node => node.type === 'option' && node.props.value === 'anthropic-disabled',
    )[0];
    expect(disabledOption?.props.disabled).toBe(true);

    run(() => sourceSelect?.props.onChange({ currentTarget: { value: 'openai-feed' } }));
    press(renderer, 'data-pricing-preview');
    await settle();

    expect(marked(renderer, 'data-pricing-change', 'added')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-change', 'updated')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-change', 'unchanged')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-select')).toHaveLength(2);
    expect(marked(renderer, 'data-pricing-select').every(input => input.props.checked === false)).toBe(true);
    expect(marked(renderer, 'data-pricing-apply')[0]?.props.disabled).toBe(true);

    toggle(renderer, manualRate().pricingKey, true);
    expect(marked(renderer, 'data-pricing-apply')[0]?.props.disabled).toBe(false);
    press(renderer, 'data-pricing-apply');
    await settle();

    const previewBody = JSON.parse(String(api.calls[1]?.init?.body));
    expect(previewBody).toEqual({ sourceId: 'openai-feed', expectedCatalogFingerprint: 'catalog-current' });
    expect(previewBody.sourceUrl).toBeUndefined();
    const applyBody = JSON.parse(String(api.calls[2]?.init?.body));
    expect(applyBody.selectedPricingKeys).toEqual([manualRate().pricingKey]);
    expect(applyBody).toMatchObject({
      previewId: 'preview-1',
      expectedCatalogFingerprint: 'catalog-current',
      expectedResultFingerprint: 'catalog-proposed',
    });
    expect(marked(renderer, 'data-pricing-preview-id')).toHaveLength(0);
    expect(text(renderer)).toContain('Selected provider changes applied');
    expect(text(renderer)).toContain('Last applied:');
    expect(text(renderer)).toContain('2026-08-06 12:00:00Z');
  });

  it('preserves an expired reviewed diff and its selection until an explicit fresh preview', async () => {
    const refreshedPreview = preview({ previewId: 'preview-2', resultCatalogFingerprint: 'catalog-proposed-2' });
    const api = pricingApi(
      pricingView(),
      preview(),
      new FyHttpError('that pricing preview expired', 410, 'analytics_pricing_expired_preview'),
      refreshedPreview,
    );
    const renderer = await renderPricing(api);

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();
    toggle(renderer, manualRate().pricingKey, true);
    press(renderer, 'data-pricing-apply');
    await settle();

    expect(marked(renderer, 'data-pricing-preview-id', 'preview-1')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-preview-stale')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-select', manualRate().pricingKey)[0]?.props.checked).toBe(true);
    expect(text(renderer)).toContain('will not refetch or apply it automatically');

    run(() => buttonNamed(renderer, 'Run a fresh preview').props.onClick());
    await settle();

    expect(marked(renderer, 'data-pricing-preview-id', 'preview-1')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-preview-id', 'preview-2')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-select').every(input => input.props.checked === false)).toBe(true);
  });

  it('keeps beta authoritative when an alpha manual save resolves during beta save', async () => {
    const alphaWrite = deferred<AnalyticsPricingView>();
    const betaWrite = deferred<AnalyticsPricingView>();
    const alphaView = pricingView({
      catalog: [manualRate({ pricingKey: 'alpha-rate', modelId: 'alpha-model' })],
      catalogFingerprint: 'alpha-current',
    });
    const betaView = pricingView({
      catalog: [manualRate({ pricingKey: 'beta-rate', modelId: 'beta-model' })],
      catalogFingerprint: 'beta-current',
    });
    const api = routedPricingApi({
      'alpha GET /v1/analytics/pricing': [alphaView],
      'alpha PATCH /v1/analytics/pricing': [alphaWrite.promise],
      'beta GET /v1/analytics/pricing': [betaView],
      'beta PATCH /v1/analytics/pricing': [betaWrite.promise],
    });
    const renderer = await renderPricing(api, connection('alpha'));

    press(renderer, 'data-pricing-add');
    enterValidManualDraft(renderer, 'alpha-new-rate', 'alpha-new-model');
    submitPricingForm(renderer);
    await settle();

    run(() => renderer.update(<PricingSettings connection={connection('beta')} createClient={api.createClient} />));
    await settle();
    press(renderer, 'data-pricing-add');
    enterValidManualDraft(renderer, 'beta-new-rate', 'beta-new-model');
    submitPricingForm(renderer);
    await settle();

    alphaWrite.resolve(
      pricingView({
        catalog: [manualRate({ pricingKey: 'alpha-late-rate', modelId: 'alpha-late-model' })],
        catalogFingerprint: 'alpha-late',
      }),
    );
    await settle();

    expect(marked(renderer, 'data-pricing-daemon', 'beta')).toHaveLength(1);
    expect(text(renderer)).toContain('beta-model');
    expect(text(renderer)).not.toContain('alpha-late-model');
    expect(text(renderer)).not.toContain('Manual rate added.');
    expect(marked(renderer, 'data-pricing-editor', 'add')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-field', 'modelId')[0]?.props.value).toBe('beta-new-model');
    expect(buttonNamed(renderer, 'Saving…').props.disabled).toBe(true);

    betaWrite.resolve(
      pricingView({
        catalog: [manualRate({ pricingKey: 'beta-saved-rate', modelId: 'beta-saved-model' })],
        catalogFingerprint: 'beta-saved',
      }),
    );
    await settle();
    expect(text(renderer)).toContain('beta-saved-model');
    expect(text(renderer)).toContain('Manual rate added.');
  });

  it('keeps beta removal busy and clean when an alpha removal rejects late', async () => {
    const alphaRemove = deferred<AnalyticsPricingView>();
    const betaRemove = deferred<AnalyticsPricingView>();
    const alphaRate = manualRate({ pricingKey: 'alpha-rate', modelId: 'alpha-model' });
    const betaRate = manualRate({ pricingKey: 'beta-rate', modelId: 'beta-model' });
    const api = routedPricingApi({
      'alpha GET /v1/analytics/pricing': [pricingView({ catalog: [alphaRate], catalogFingerprint: 'alpha-current' })],
      'alpha PATCH /v1/analytics/pricing': [alphaRemove.promise],
      'beta GET /v1/analytics/pricing': [pricingView({ catalog: [betaRate], catalogFingerprint: 'beta-current' })],
      'beta PATCH /v1/analytics/pricing': [betaRemove.promise],
    });
    const renderer = await renderPricing(api, connection('alpha'));

    press(renderer, 'data-pricing-remove', alphaRate.pricingKey);
    run(() => buttonNamed(renderer, 'Confirm removal').props.onClick());
    await settle();

    run(() => renderer.update(<PricingSettings connection={connection('beta')} createClient={api.createClient} />));
    await settle();
    press(renderer, 'data-pricing-remove', betaRate.pricingKey);
    run(() => buttonNamed(renderer, 'Confirm removal').props.onClick());
    await settle();

    alphaRemove.reject(new FyHttpError('alpha catalog moved', 409, 'analytics_pricing_stale_catalog'));
    await settle();

    expect(marked(renderer, 'data-pricing-daemon', 'beta')).toHaveLength(1);
    expect(text(renderer)).toContain('beta-model');
    expect(text(renderer)).not.toContain('alpha catalog moved');
    expect(text(renderer)).not.toContain('Showing stale pricing data');
    expect(text(renderer)).not.toContain('Rate removed.');
    expect(buttonNamed(renderer, 'Confirm removal').props.disabled).toBe(true);

    betaRemove.resolve(pricingView({ catalog: [], catalogFingerprint: 'beta-removed' }));
    await settle();
    expect(marked(renderer, 'data-pricing-empty')).toHaveLength(1);
    expect(text(renderer)).toContain('Rate removed.');
  });

  it('keeps beta preview pending when an alpha preview resolves late', async () => {
    const alphaPreview = deferred<AnalyticsPricingSyncPreview>();
    const betaPreview = deferred<AnalyticsPricingSyncPreview>();
    const api = routedPricingApi({
      'alpha GET /v1/analytics/pricing': [
        pricingView({ catalog: [manualRate({ modelId: 'alpha-model' })], catalogFingerprint: 'alpha-current' }),
      ],
      'alpha POST /v1/analytics/pricing/sync/preview': [alphaPreview.promise],
      'beta GET /v1/analytics/pricing': [
        pricingView({ catalog: [manualRate({ modelId: 'beta-model' })], catalogFingerprint: 'beta-current' }),
      ],
      'beta POST /v1/analytics/pricing/sync/preview': [betaPreview.promise],
    });
    const renderer = await renderPricing(api, connection('alpha'));

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();

    run(() => renderer.update(<PricingSettings connection={connection('beta')} createClient={api.createClient} />));
    await settle();
    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();

    alphaPreview.resolve(
      preview({
        previewId: 'alpha-late-preview',
        baseCatalogFingerprint: 'alpha-current',
        resultCatalogFingerprint: 'alpha-proposed',
      }),
    );
    await settle();

    expect(marked(renderer, 'data-pricing-daemon', 'beta')).toHaveLength(1);
    expect(text(renderer)).toContain('beta-model');
    expect(marked(renderer, 'data-pricing-preview-id', 'alpha-late-preview')).toHaveLength(0);
    expect(text(renderer)).not.toContain('Fresh provider preview ready. Nothing is selected.');
    expect(buttonNamed(renderer, 'Checking…').props.disabled).toBe(true);

    betaPreview.resolve(
      preview({
        previewId: 'beta-preview',
        baseCatalogFingerprint: 'beta-current',
        resultCatalogFingerprint: 'beta-proposed',
      }),
    );
    await settle();
    expect(marked(renderer, 'data-pricing-preview-id', 'beta-preview')).toHaveLength(1);
    expect(text(renderer)).toContain('Fresh provider preview ready. Nothing is selected.');
  });

  it('keeps beta reviewed diff and apply busy when an alpha apply resolves late', async () => {
    const alphaApply = deferred<AnalyticsPricingView>();
    const betaApply = deferred<AnalyticsPricingView>();
    const alphaView = pricingView({
      catalog: [manualRate({ modelId: 'alpha-model' })],
      catalogFingerprint: 'alpha-current',
    });
    const betaView = pricingView({
      catalog: [manualRate({ modelId: 'beta-model' })],
      catalogFingerprint: 'beta-current',
    });
    const alphaReview = preview({
      previewId: 'alpha-preview',
      baseCatalogFingerprint: 'alpha-current',
      resultCatalogFingerprint: 'alpha-proposed',
    });
    const betaReview = preview({
      previewId: 'beta-preview',
      baseCatalogFingerprint: 'beta-current',
      resultCatalogFingerprint: 'beta-proposed',
    });
    const api = routedPricingApi({
      'alpha GET /v1/analytics/pricing': [alphaView],
      'alpha POST /v1/analytics/pricing/sync/preview': [alphaReview],
      'alpha POST /v1/analytics/pricing/sync/apply': [alphaApply.promise],
      'beta GET /v1/analytics/pricing': [betaView],
      'beta POST /v1/analytics/pricing/sync/preview': [betaReview],
      'beta POST /v1/analytics/pricing/sync/apply': [betaApply.promise],
    });
    const renderer = await renderPricing(api, connection('alpha'));

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();
    toggle(renderer, manualRate().pricingKey, true);
    press(renderer, 'data-pricing-apply');
    await settle();

    run(() => renderer.update(<PricingSettings connection={connection('beta')} createClient={api.createClient} />));
    await settle();
    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();
    toggle(renderer, manualRate().pricingKey, true);
    press(renderer, 'data-pricing-apply');
    await settle();

    alphaApply.resolve(
      pricingView({
        catalog: [manualRate({ pricingKey: 'alpha-late-rate', modelId: 'alpha-late-model' })],
        catalogFingerprint: 'alpha-late',
      }),
    );
    await settle();

    expect(marked(renderer, 'data-pricing-daemon', 'beta')).toHaveLength(1);
    expect(text(renderer)).toContain('beta-model');
    expect(text(renderer)).not.toContain('alpha-late-model');
    expect(marked(renderer, 'data-pricing-preview-id', 'beta-preview')).toHaveLength(1);
    expect(text(renderer)).not.toContain('Selected provider changes applied.');
    expect(buttonNamed(renderer, 'Applying…').props.disabled).toBe(true);

    betaApply.resolve(
      pricingView({
        catalog: [manualRate({ pricingKey: 'beta-applied-rate', modelId: 'beta-applied-model' })],
        catalogFingerprint: 'beta-applied',
      }),
    );
    await settle();
    expect(marked(renderer, 'data-pricing-preview-id')).toHaveLength(0);
    expect(text(renderer)).toContain('beta-applied-model');
    expect(text(renderer)).toContain('Selected provider changes applied.');
  });

  it('discards a late read from the previous daemon after the tab is re-scoped', async () => {
    let resolveAlpha: ((view: AnalyticsPricingView) => void) | undefined;
    const alphaRead = new Promise<AnalyticsPricingView>(resolve => {
      resolveAlpha = resolve;
    });
    const betaView = pricingView({ catalog: [manualRate({ modelId: 'beta-model', pricingKey: 'beta-rate' })] });
    const seen: string[] = [];
    const createClient: AnalyticsPricingClientFactory = async daemon => {
      const daemonId = String(daemon.daemonId);
      seen.push(daemonId);
      return {
        request: (async (_path: string, schema: { parse(value: unknown): unknown }) =>
          schema.parse(daemonId === 'alpha' ? await alphaRead : betaView)) as never,
      };
    };
    const alpha = connection('alpha');
    const beta = connection('beta');
    const renderer = render(<PricingSettings connection={alpha} createClient={createClient} />);

    run(() => renderer.update(<PricingSettings connection={beta} createClient={createClient} />));
    await settle();
    resolveAlpha?.(pricingView({ catalog: [manualRate({ modelId: 'late-alpha' })] }));
    await settle();

    expect(seen).toEqual(['alpha', 'beta']);
    expect(marked(renderer, 'data-pricing-daemon', 'beta')).toHaveLength(1);
    expect(text(renderer)).toContain('beta-model');
    expect(text(renderer)).not.toContain('late-alpha');
  });

  it('refuses a rate amount the shared precision rule cannot parse and sends nothing', async () => {
    const api = pricingApi(pricingView({ catalog: [] }));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-add');
    enterValidManualDraft(renderer, 'manual:gpt-5:2026-08', 'gpt-5');
    change(renderer, 'data-pricing-rate-field', 'reasoning', '0.1234567');
    submitPricingForm(renderer);
    await settle();

    expect(text(renderer)).toContain('Enter a non-negative USD amount with no more than six decimal places.');
    expect(marked(renderer, 'data-pricing-rate-field', 'reasoning')[0]?.props['aria-invalid']).toBe(true);
    expect(marked(renderer, 'data-pricing-rate-field', 'reasoning')[0]?.props.value).toBe('0.1234567');
    expect(marked(renderer, 'data-pricing-rate-field', 'input')[0]?.props['aria-invalid']).toBe(false);
    expect(marked(renderer, 'data-pricing-field', 'modelId')[0]?.props['aria-invalid']).toBe(false);
    expect(api.calls).toHaveLength(1);
  });

  it('says the same refusal in the editor and beside the catalog when a save meets a moved catalog', async () => {
    const api = pricingApi(
      pricingView({ catalog: [] }),
      new FyHttpError('catalog moved', 409, 'analytics_pricing_stale_catalog'),
    );
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-add');
    enterValidManualDraft(renderer, 'manual:gpt-5:2026-08', 'gpt-5');
    submitPricingForm(renderer);
    await settle();

    const refusal =
      'The pricing catalog changed after this form opened. Refresh the catalog, review the current row, and retry your save.';
    const rendered = text(renderer);
    expect(rendered.split(refusal)).toHaveLength(3);
    expect(marked(renderer, 'data-pricing-editor', 'add')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-field', 'modelId')[0]?.props.value).toBe('gpt-5');
    expect(marked(renderer, 'data-pricing-stale')).toHaveLength(1);
    expect(rendered).not.toContain('catalog moved');
  });

  it('reports a moved catalog on the preview surface and marks the shown catalog stale', async () => {
    const api = pricingApi(pricingView(), new FyHttpError('sources moved', 409, 'analytics_pricing_stale_sources'));
    const renderer = await renderPricing(api);

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();

    const refusal =
      'The catalog or configured source changed before this preview completed. Refresh the catalog, then request a fresh preview.';
    const rendered = text(renderer);
    expect(rendered.split(refusal)).toHaveLength(3);
    expect(marked(renderer, 'data-pricing-preview-id')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-stale')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-row', manualRate().pricingKey)).toHaveLength(1);
    expect(rendered).not.toContain('sources moved');
  });

  it('keeps the reviewed diff and its selection when an apply fails for a reason the preview survives', async () => {
    const api = pricingApi(pricingView(), preview(), new Error('the daemon refused the write'));
    const renderer = await renderPricing(api);

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();
    toggle(renderer, manualRate().pricingKey, true);
    press(renderer, 'data-pricing-apply');
    await settle();

    const rendered = text(renderer);
    expect(rendered.split('the daemon refused the write')).toHaveLength(2);
    expect(marked(renderer, 'data-pricing-preview-id', 'preview-1')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-preview-stale')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-stale')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-select', manualRate().pricingKey)[0]?.props.checked).toBe(true);
    expect(marked(renderer, 'data-pricing-apply')[0]?.props.disabled).toBe(false);
  });

  it('states that a configured feed proposed no catalog entries instead of showing an empty ledger', async () => {
    const api = pricingApi(pricingView(), preview({ changes: [] }));
    const renderer = await renderPricing(api);

    change(renderer, 'data-pricing-source-select', '', 'openai-feed');
    press(renderer, 'data-pricing-preview');
    await settle();

    expect(marked(renderer, 'data-pricing-preview-id', 'preview-1')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-preview-empty')).toHaveLength(1);
    expect(text(renderer)).toContain('This configured feed proposed no catalog entries.');
    expect(marked(renderer, 'data-pricing-select')).toHaveLength(0);
    expect(marked(renderer, 'data-pricing-apply')[0]?.props.disabled).toBe(true);
  });

  it('drops the draft and its failure when the operator cancels the editor', async () => {
    const api = pricingApi(pricingView(), new Error('configuration write failed'));
    const renderer = await renderPricing(api);

    press(renderer, 'data-pricing-edit', manualRate().pricingKey);
    change(renderer, 'data-pricing-rate-field', 'input', 'one dollar');
    submitPricingForm(renderer);
    expect(marked(renderer, 'data-pricing-rate-field', 'input')[0]?.props['aria-invalid']).toBe(true);

    change(renderer, 'data-pricing-rate-field', 'input', '2.5');
    submitPricingForm(renderer);
    await settle();
    expect(text(renderer)).toContain('configuration write failed');

    run(() => buttonNamed(renderer, 'Cancel').props.onClick());

    expect(marked(renderer, 'data-pricing-editor')).toHaveLength(0);
    expect(text(renderer)).not.toContain('configuration write failed');
    expect(marked(renderer, 'data-pricing-row', manualRate().pricingKey)).toHaveLength(1);

    press(renderer, 'data-pricing-add');
    expect(marked(renderer, 'data-pricing-editor', 'add')).toHaveLength(1);
    expect(marked(renderer, 'data-pricing-field', 'modelId')[0]?.props.value).toBe('');
    expect(marked(renderer, 'data-pricing-rate-field', 'input')[0]?.props['aria-invalid']).toBe(false);
  });

  it('exports an iconless daemon Settings tab definition', () => {
    const createClient: AnalyticsPricingClientFactory = async (_daemon: DaemonConnection) =>
      ({ request: async () => null }) as never;
    const tab = pricingSettingsTab(createClient);

    expect(tab.id).toBe('model-pricing');
    expect(tab.label).toBe('Model pricing');
    expect('icon' in tab).toBe(false);
  });

  it('renders the pricing surface the exported tab hands the Settings shell, scoped to its daemon', async () => {
    const api = pricingApi(pricingView({ catalog: [manualRate({ modelId: 'tab-model' })] }));
    const tab = pricingSettingsTab(api.createClient);

    const renderer = render(<tab.Surface connection={connection('gamma')} />);
    await settle();

    expect(marked(renderer, 'data-pricing-daemon', 'gamma')).toHaveLength(1);
    expect(text(renderer)).toContain('tab-model');
    expect(api.calls.map(call => call.connectionId)).toEqual(['gamma']);
  });
});
