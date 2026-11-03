/**
 * The Machine panels the shell harness had no data for — Pack mode, Terminals, Speed-ups and Model
 * pricing — answered from memory with temporary fake values, so the settings audit can open each one.
 * Nothing here reaches a daemon or the network.
 */

import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingRate,
  type AnalyticsPricingView,
  type SpeedupsView,
  type TerminalHoldersView,
} from '@ferretry/protocol';
import type { MachinePack } from '../src/features/pack/use-machine-pack.ts';
import type { AnalyticsPricingClient } from '../src/features/settings/pricing-api.ts';
import type { TerminalSlotsClient } from '../src/features/settings/terminal-slots-api.ts';
import type { SpeedupClient } from '../src/features/speedups/speedups-api.ts';
import { OWNER_VIEW } from '../tests/support/pack.ts';

const never = (): Promise<never> => new Promise(() => undefined);

/** Pack mode on a machine whose owner has written a routing prompt; no write ever completes. */
export const HARNESS_PACK_STATE: MachinePack = {
  read: { kind: 'ready', view: OWNER_VIEW },
  saveConfig: async () => ({ kind: 'applied' }) as never,
  savePrompt: never,
  cleanUp: never,
  readJob: never,
  accept: never,
  undo: never,
};

const answering =
  <Client extends { request: unknown }>(answers: Readonly<Record<string, unknown>>) =>
  async (): Promise<Client> =>
    ({
      request: async (path: string) => {
        const answer = answers[path];
        if (answer === undefined) throw new Error(`harness daemon has no answer for ${path}`);
        return answer;
      },
    }) as unknown as Client;

const TERMINALS: TerminalHoldersView = {
  limit: 24,
  open: 9,
  holders: [
    { sessionId: 's-1', label: 'fitzgerald', standing: 'finished', status: 'stopped', count: 6 },
    { sessionId: 's-2', label: 'wren', standing: 'live', status: 'running', count: 2 },
    { sessionId: 's-3', label: 'hadi', standing: 'live', status: 'running', count: 1 },
  ],
};

export const harnessTerminalSlotsClient = answering<TerminalSlotsClient>({ '/v1/terminals': TERMINALS });

const SPEEDUPS: SpeedupsView = {
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'Fast, cheap typed decisions: the Warden’s guard decides skip or investigate.',
      costNote: 'Fractions of a cent per decision.',
      privacyNote: 'A redacted summary of a flagged ferret leaves this machine.',
      keyUrl: 'https://jev.typesafe.ai/keys',
      testNote: 'One tiny decision; spends a fraction of a cent.',
      secretName: 'JEV_API_KEY',
      set: true,
      testStale: false,
    },
    {
      provider: 'groq',
      label: 'Groq',
      purpose: 'Cleans up a dictated transcript: punctuation, filler words, formatting.',
      costNote: 'Fractions of a cent per dictation.',
      privacyNote: 'Only the transcript text, only when you dictate.',
      keyUrl: 'https://console.groq.com/keys',
      testNote: 'Lists models; spends nothing.',
      secretName: 'GROQ_API_KEY',
      set: false,
      testStale: false,
    },
  ],
} as SpeedupsView;

export const harnessSpeedupsClient = answering<SpeedupClient>({ '/v1/speedups': SPEEDUPS });

const rate = (
  modelId: string,
  provider: AnalyticsPricingRate['provider'],
  input: number,
  output: number,
): AnalyticsPricingRate => ({
  pricingKey: `${provider}:${modelId}:2026-08`,
  modelId,
  aliases: [],
  provider,
  currency: 'USD',
  rates: {
    input,
    output,
    cachedInput: Math.round(input / 10),
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: null,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T08:00:00.000Z',
  lastSyncedAt: null,
});

const PRICING: AnalyticsPricingView = {
  catalog: [
    rate('claude-opus-5-5', 'anthropic', 5_000_000, 25_000_000),
    rate('claude-sonnet-5-5', 'anthropic', 3_000_000, 15_000_000),
    rate('gpt-5.6-sol', 'openai', 1_250_000, 10_000_000),
  ],
  catalogFingerprint: 'harness-catalog',
  sources: [
    {
      id: 'openai-feed',
      provider: 'openai',
      url: 'https://pricing.invalid/openai.json',
      enabled: true,
      lastSyncedAt: null,
    },
  ],
  sourcesFingerprint: 'harness-sources',
  rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
};

export const harnessPricingClient = answering<AnalyticsPricingClient>({ '/v1/analytics/pricing': PRICING });
