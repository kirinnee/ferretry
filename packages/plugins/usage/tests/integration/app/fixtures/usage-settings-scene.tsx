/**
 * The browser entry for the three Usage settings tabs over FAKE data (no daemon): the REAL pages read from scripted clients.
 *
 *   ?tab=budgets|pricing|performance   ?theme=<family>-<mode>   ?motion=reduced
 *   ?act=add        pricing: opens the manual-rate form      ?act=feed   pricing: picks the feed and reads its changes
 *   ?act=record     performance: records once and waits for the report
 */
import { ANALYTICS_PRICING_RATE_APPLICABILITY } from '../../../../contract/index.ts';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { LoginBudgetSchema } from '@ferretry/plugin-logins/contract';
import { createRoot } from 'react-dom/client';
import { BudgetsSettings } from '../../../../app/features/settings/budgets-settings.tsx';
import { PerformanceSettings } from '../../../../app/features/settings/performance-settings.tsx';
import { PricingSettings } from '../../../../app/features/settings/pricing-settings.tsx';
import { fakeClient } from '../../../unit/app/support/client.ts';
import { harnessPerformanceClient, harnessRecorder } from '../../../unit/app/fixtures/performance-fixture.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';
const tab = params.get('tab') ?? 'budgets';
const act = params.get('act') ?? '';
const connection = { daemonId: 'studio' };

const period = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  trigger: 40,
  hard: 60,
  spentUsd: 12.4,
  level: 'ok',
  startsAt: '2026-10-13T04:00:00.000Z',
  resetsAt: '2026-10-14T04:00:00.000Z',
  ...overrides,
});
const budget = (overrides: Readonly<Record<string, unknown>> = {}) =>
  LoginBudgetSchema.parse({
    timeZone: 'America/New_York',
    timeZoneSet: true,
    daily: period(),
    weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-10-19T04:00:00.000Z' }),
    level: 'ok',
    unpriced: 0,
    measured: true,
    ...overrides,
  });

const budgets = fakeClient({
  'GET /v1/logins': {
    format: 1,
    machine: 'studio-mac',
    logins: [
      sampleLogin('claude-personal', { label: 'personal' }),
      sampleLogin('claude-work', { label: 'work' }),
      sampleLogin('codex', { harness: 'codex', harnesses: ['codex'] }),
    ],
  },
  'GET /v1/usage/budgets': {
    budgets: [
      { login: 'claude-personal', budget: budget() },
      {
        login: 'claude-work',
        budget: budget({ level: 'over_trigger', daily: period({ level: 'over_trigger', spentUsd: 44 }) }),
      },
    ],
  },
  'GET /v1/config/file': {
    path: 'usage.yaml',
    exists: true,
    text: '# usage\ntimeZone: America/New_York\n',
    etag: 'e1',
  },
});

const rate = (
  modelId: string,
  provider: 'openai' | 'anthropic',
  kind: 'manual' | 'provider_sync' | 'model_catalog',
) => ({
  pricingKey: `${provider}:${modelId}:2026-08`,
  modelId,
  aliases: [`${modelId}-2026-08-01`],
  provider,
  currency: 'USD' as const,
  rates: {
    input: 1_250_000,
    output: 10_000_000,
    cachedInput: 125_000,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 2_000_000,
    image: null,
    tool: null,
  },
  source:
    kind === 'manual'
      ? { kind: 'manual' as const }
      : kind === 'provider_sync'
        ? { kind: 'provider_sync' as const, provider, sourceUrl: 'https://pricing.example.test/openai.json' }
        : { kind: 'model_catalog' as const, catalog: provider, sourceUrl: 'https://pricing.example.test/catalog' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T08:00:00.000Z',
  lastSyncedAt: kind === 'provider_sync' ? '2026-08-05T12:00:00.000Z' : null,
});
const updated = {
  ...rate('gpt-5', 'openai', 'provider_sync'),
  rates: { ...rate('gpt-5', 'openai', 'manual').rates, input: 2_000_000 },
};
const pricing = fakeClient({
  'GET /v1/usage/pricing': {
    catalog: [rate('gpt-5', 'openai', 'provider_sync'), rate('claude-fable-5', 'anthropic', 'manual')],
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
        id: 'anthropic-feed',
        provider: 'anthropic',
        url: 'https://pricing.example.test/anthropic.json',
        enabled: false,
        lastSyncedAt: null,
      },
    ],
    sourcesFingerprint: 'sources-current',
    rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
    modelCatalogRates: [rate('deepseek-v4', 'openai', 'model_catalog')],
  },
  'POST /v1/usage/pricing/sync/preview': {
    previewId: 'preview-1',
    sourceId: 'openai-feed',
    provider: 'openai',
    sourceUrl: 'https://pricing.example.test/openai.json',
    fetchedAt: '2026-08-06T12:00:00.000Z',
    baseCatalogFingerprint: 'catalog-current',
    resultCatalogFingerprint: 'catalog-proposed',
    changes: [
      { kind: 'added', pricingKey: 'openai:gpt-5-mini:2026-08', after: rate('gpt-5-mini', 'openai', 'provider_sync') },
      {
        kind: 'updated',
        pricingKey: updated.pricingKey,
        before: rate('gpt-5', 'openai', 'provider_sync'),
        after: updated,
      },
    ],
  },
});

const click = (match: (button: HTMLButtonElement) => boolean, tries = 60): void => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(match);
  if (button !== undefined && !button.disabled) button.click();
  else if (tries > 0) setTimeout(() => click(match, tries - 1), 50);
};

if (tab === 'pricing' && act === 'add') click(button => button.textContent === 'Add manual rate');
if (tab === 'pricing' && act === 'feed') {
  const pick = (tries = 60): void => {
    const card = document.querySelector<HTMLInputElement>('[data-choice="openai-feed"] input');
    const select = document.querySelector<HTMLSelectElement>('[data-pricing-source-select]');
    if (card !== null) card.click();
    else if (select !== null) {
      // The page before this change chose a feed from a dropdown: set it the way a person's pick reaches React.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'openai-feed');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tries > 0) return void setTimeout(() => pick(tries - 1), 50);
    setTimeout(() => click(button => button.textContent === 'Check for updates'), 300);
  };
  pick();
}
if (tab === 'performance' && act === 'record') click(button => button.textContent?.startsWith('Record') === true);

const page =
  tab === 'pricing' ? (
    <PricingSettings connection={connection} client={pricing} />
  ) : tab === 'performance' ? (
    <PerformanceSettings
      connection={connection}
      client={harnessPerformanceClient()}
      recorder={harnessRecorder()}
      seconds={30}
    />
  ) : (
    <BudgetsSettings connection={connection} client={budgets} deviceTimeZone="America/New_York" />
  );

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[1100px] p-4" data-scene-ready="">
      {page}
    </div>,
  );
