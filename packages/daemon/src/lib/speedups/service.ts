import {
  type SpeedupProvider,
  type SpeedupStatus,
  type SpeedupsView,
  type SpeedupTestCode,
  type SpeedupTestResult,
  SpeedupTestResultSchema,
} from '@ferretry/protocol';
import { SecretStoreError } from '../secrets/types.ts';
import { SPEEDUP_CATALOG, SPEEDUP_ORDER, type SpeedupCatalogEntry } from './catalog.ts';
import { TRIAGE_PROBE_SNAPSHOT, type TriageFailureCode, type TriageGuardPort } from './jev.ts';
import type {
  AuthorizedOutcome,
  OutboundAuthorizerPort,
  SecretNameSource,
  SpeedupClockPort,
  SpeedupTestLedgerPort,
} from './ports.ts';

/**
 * The Speed-ups surface: which keys are set, and a Test that proves one works.
 *
 * "SET" IS A NAME LOOKUP. Whether a key is present is read from the secret store's listing — names
 * and instants — and never by opening it. Only a Test spends a key, and only through the outbound
 * holder, which hands back a status and nothing else.
 *
 * A TEST NEVER SPENDS WITHOUT BEING ASKED. Groq and Cerebras are tested by listing models (free, no
 * inference). Jev has no free authenticated read, so its Test is one deliberately tiny decision about a
 * made-up ferret, and the screen says so before the button is pressed.
 */
export interface SpeedupsServiceParts {
  readonly authorizer: OutboundAuthorizerPort;
  readonly secrets: SecretNameSource;
  readonly ledger: SpeedupTestLedgerPort;
  readonly clock: SpeedupClockPort;
  /** The Jev guard, so its Test exercises exactly the path the Warden will. */
  readonly guard: TriageGuardPort;
}

export const SPEEDUP_TEST_TIMEOUT_MS = 8_000;
/** A model list is a few kilobytes; a 2xx past this is still a key that worked. */
const MODEL_LIST_MAX_BYTES = 512 * 1_024;

export const SPEEDUP_TEST_MESSAGES: Readonly<Record<SpeedupTestCode, string>> = {
  ok: 'The key works.',
  not_set: 'No key is set. Paste one and save it first.',
  rejected: 'The provider refused this key. Check it was copied whole, or make a new one.',
  rate_limited: 'The provider is rate limiting or busy right now. Try again in a minute.',
  timeout: 'The provider did not answer in time. Try again.',
  unreachable: 'This machine could not reach the provider. Check its network connection.',
  provider_error: 'The provider returned an error. Try again later.',
  malformed: 'The provider answered with something unexpected.',
  vault_damaged: 'This machine’s secret store cannot be read, so the key could not be used.',
};

/** What a model-list probe proved about the key. */
export function modelListCode(outcome: AuthorizedOutcome): SpeedupTestCode {
  switch (outcome.kind) {
    case 'completion':
      return 'ok';
    // Only a 2xx is ever read far enough to be oversized, so the key was accepted.
    case 'oversized':
      return 'ok';
    case 'unreadable':
      return 'malformed';
    case 'secret_missing':
      return 'not_set';
    case 'vault_damaged':
      return 'vault_damaged';
    case 'timeout':
      return 'timeout';
    case 'unreachable':
      return 'unreachable';
    case 'refused':
      return 'provider_error';
    case 'status':
      if (outcome.status === 401 || outcome.status === 403) return 'rejected';
      if (outcome.status === 429) return 'rate_limited';
      return 'provider_error';
  }
}

const TRIAGE_TEST_CODES: Readonly<Record<TriageFailureCode, SpeedupTestCode>> = {
  not_set: 'not_set',
  vault_damaged: 'vault_damaged',
  rejected: 'rejected',
  rate_limited: 'rate_limited',
  overloaded: 'rate_limited',
  timeout: 'timeout',
  unreachable: 'unreachable',
  malformed: 'malformed',
  misconfigured: 'provider_error',
  invalid_request: 'provider_error',
  too_large: 'provider_error',
  provider_error: 'provider_error',
};

/** The ledger as it rests: one last result per provider. Anything unreadable is simply "never tested". */
export function parseTestLedger(raw: unknown): Partial<Record<SpeedupProvider, SpeedupTestResult>> {
  if (typeof raw !== 'object' || raw === null || !('results' in raw)) return {};
  const results = (raw as { results: unknown }).results;
  if (typeof results !== 'object' || results === null) return {};
  const parsed: Partial<Record<SpeedupProvider, SpeedupTestResult>> = {};
  for (const provider of SPEEDUP_ORDER) {
    const entry = SpeedupTestResultSchema.safeParse((results as Record<string, unknown>)[provider]);
    if (entry.success && entry.data.provider === provider) parsed[provider] = entry.data;
  }
  return parsed;
}

/** True when the key was replaced after the test, so the test no longer describes it. */
export function testIsStale(lastTest: SpeedupTestResult | undefined, secretUpdatedAt: string | undefined): boolean {
  if (lastTest === undefined || secretUpdatedAt === undefined) return false;
  return Date.parse(secretUpdatedAt) > Date.parse(lastTest.at);
}

function statusOf(
  entry: SpeedupCatalogEntry,
  updatedAt: string | undefined,
  lastTest: SpeedupTestResult | undefined,
): SpeedupStatus {
  return {
    provider: entry.id,
    label: entry.label,
    purpose: entry.purpose,
    costNote: entry.costNote,
    privacyNote: entry.privacyNote,
    keyUrl: entry.keyUrl,
    testNote: entry.testNote,
    secretName: entry.secretName,
    set: updatedAt !== undefined,
    ...(updatedAt === undefined ? {} : { secretUpdatedAt: updatedAt }),
    ...(lastTest === undefined ? {} : { lastTest }),
    testStale: testIsStale(lastTest, updatedAt),
  };
}

export class SpeedupsService {
  constructor(private readonly parts: SpeedupsServiceParts) {}

  async view(): Promise<SpeedupsView> {
    const tests = parseTestLedger(await this.parts.ledger.read());
    let names: ReadonlyMap<string, string>;
    let vault: SpeedupsView['vault'] = 'ok';
    try {
      names = new Map((await this.parts.secrets.list()).map(summary => [summary.name, summary.updatedAt]));
    } catch (error) {
      if (!(error instanceof SecretStoreError)) throw error;
      names = new Map();
      vault = 'damaged';
    }
    return {
      providers: SPEEDUP_ORDER.map(provider => {
        const entry = SPEEDUP_CATALOG[provider];
        return statusOf(entry, names.get(entry.secretName), tests[provider]);
      }),
      vault,
    };
  }

  /** Spend the provider's key once, the cheapest way it can be spent, and remember the answer. */
  async test(provider: SpeedupProvider): Promise<SpeedupTestResult> {
    const entry = SPEEDUP_CATALOG[provider];
    const startedAt = this.parts.clock.monotonicMs();
    const code = await this.probe(entry);
    const result: SpeedupTestResult = {
      provider,
      secretName: entry.secretName,
      ok: code === 'ok',
      code,
      message: SPEEDUP_TEST_MESSAGES[code],
      latencyMs: Math.max(0, this.parts.clock.monotonicMs() - startedAt),
      at: this.parts.clock.now(),
    };
    // Read-modify-write without a lock: two Tests racing can only lose one LAST-RESULT line, which the
    // next Test rewrites. Nothing else lives in this document.
    const results = { ...parseTestLedger(await this.parts.ledger.read()), [provider]: result };
    await this.parts.ledger.write({ v: 1, results });
    return result;
  }

  private async probe(entry: SpeedupCatalogEntry): Promise<SpeedupTestCode> {
    if (entry.probe.kind === 'decision') {
      const decision = await this.parts.guard.decide(TRIAGE_PROBE_SNAPSHOT);
      return decision.failure === undefined ? 'ok' : TRIAGE_TEST_CODES[decision.failure.code];
    }
    const outcome = await this.parts.authorizer.send(entry.secretName, entry.hosts, {
      method: 'GET',
      url: entry.probe.url,
      headers: { accept: 'application/json' },
      timeoutMs: SPEEDUP_TEST_TIMEOUT_MS,
      maxResponseBytes: MODEL_LIST_MAX_BYTES,
    });
    return modelListCode(outcome);
  }
}
