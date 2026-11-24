import type {
  Clock,
  ConfigPort,
  ConfigWriteOutcome,
  Log,
  OutboundSecretOutcome,
  SecretsPort,
  StatePort,
} from '@ferretry/kernel/contract';
import {
  DEFAULT_SEARCH_CONFIG,
  SEARCH_CONFIG,
  SEARCH_DEFAULT_RESULTS,
  SEARCH_LEDGER_STATE,
  SEARCH_PROVIDERS,
  type SearchConfig,
  type SearchHit,
  type SearchProviderId,
  type SearchSetupRequest,
  type SearchSetupResult,
  type SearchTestCode,
  type SearchTestResult,
  type SearchView,
  searchKeyReference,
  type WebSearchInput,
} from '../../contract/index.ts';
import { SEARCH_ADAPTERS } from './providers.ts';

/**
 * The search service: one search, one Test, one settings read and one setup, over the kernel's ports.
 *
 * THE PROVIDERS ARE AN ORDERED LIST. A search goes to the first and falls through to the next on a failure (the
 * network, a 5xx, a refused key, a rate limit or quota, a reply it cannot read) and NEVER on a valid empty answer,
 * which is an answer. The reply says which provider gave it. Every attempt that left the machine counts against the ONE
 * daily cap, a fall-through included, so a failing first provider cannot double the day's spend.
 *
 * THE CAP IS COUNTED BEFORE THE SEND. `reserve` takes one call from today's ledger inside the state file's own
 * serialization chain, so two ferrets searching at once can never both take the last call, and a crash between the
 * count and the answer never gives a free one. A call the kernel refused before anything left the machine (no key
 * stored, a damaged vault) is given back, so a missing key does not burn the day.
 *
 * THE KEY IS NEVER HERE. `secrets.send` puts it on the request and answers facts only; this file holds a name and a
 * provider's reply.
 */

type Ledger = { day: string; calls: number; tests: SearchTestResult[] };

/** Why ONE attempt did not return results: the Test's vocabulary, plus the two the tool alone can meet. */
type Failure = SearchTestCode | 'cap' | 'ledger_damaged';

/** A provider that was tried and did not answer, with why, in the order tried. */
export interface SearchAttempt {
  readonly provider: SearchProviderId;
  readonly code: SearchTestCode;
}

export type SearchOutcome =
  | {
      readonly kind: 'results';
      /** The provider that answered; `skipped` are the ones before it that did not. */
      readonly provider: SearchProviderId;
      readonly hits: readonly SearchHit[];
      readonly skipped: readonly SearchAttempt[];
    }
  /** No provider is listed: web search is off. */
  | { readonly kind: 'off' }
  /** Every provider tried failed, or the day ran out (`stopped: 'cap'`) or its counter broke before the rest were tried. */
  | {
      readonly kind: 'failed';
      readonly tried: readonly SearchAttempt[];
      readonly stopped?: 'cap' | 'ledger_damaged';
    };

type Attempt =
  | { readonly kind: 'results'; readonly hits: readonly SearchHit[] }
  | { readonly kind: 'failed'; readonly failure: Failure };

export interface SearchParts {
  readonly secrets: Pick<SecretsPort, 'send'>;
  readonly state: StatePort;
  readonly config: Pick<ConfigPort, 'file' | 'fileState' | 'writeAsCaller'>;
  readonly clock: Pick<Clock, 'now' | 'nowMs'>;
  readonly log: Log;
}

const SEARCH_TIMEOUT_MS = 15_000;
/** Ten short results are a few kilobytes; a provider answering past this is not answering a search. */
const SEARCH_MAX_REPLY_BYTES = 1_048_576;
const TEST_QUERY = 'ferretry';

/** What a person is told, one fixed sentence per code. Never a provider body: that could echo anything. */
export const SEARCH_MESSAGES: Readonly<Record<SearchTestCode, string>> = {
  ok: 'The key works.',
  not_set: 'No search provider set up: Settings › Web search',
  rejected: 'The provider refused this key. Check it was copied whole, or make a new one.',
  rate_limited: 'The provider is rate limiting or busy right now. Try again in a minute.',
  timeout: 'The provider did not answer in time. Try again.',
  unreachable: 'This machine could not reach the provider. Check its network connection.',
  provider_error: 'The provider returned an error. Try again later.',
  malformed: 'The provider answered with something unexpected.',
  vault_damaged: 'This machine’s secret store cannot be read, so the key could not be used.',
};

/** What each code is, as a short clause that follows a provider's name: "Serper (the key was refused)". */
const SEARCH_REASONS: Readonly<Record<SearchTestCode, string>> = {
  ok: 'answered',
  not_set: 'no key is stored for it',
  rejected: 'the key was refused',
  rate_limited: 'rate limited or busy',
  timeout: 'did not answer in time',
  unreachable: 'could not be reached',
  provider_error: 'returned an error',
  malformed: 'sent a reply that could not be read',
  vault_damaged: 'the secret store could not be read',
};

/**
 * What a ferret is told when no provider answered: ONE plain sentence naming each provider tried and why, in the order
 * tried. Fixed words and provider labels only; never a provider body.
 */
export function failedSentence(failed: Extract<SearchOutcome, { kind: 'failed' }>, dailyCap: number): string {
  const { tried, stopped } = failed;
  if (tried.length === 0 && stopped === 'cap')
    return `The daily web search limit (${String(dailyCap)} a day on this machine) is used up. It starts again tomorrow; the owner can raise it in Settings › Web search.`;
  if (tried.length === 0) return 'Web search is paused: its daily counter could not be read.';
  if (stopped === undefined && tried.every(attempt => attempt.code === 'not_set')) return SEARCH_MESSAGES.not_set;
  const named = tried
    .map(attempt => `${SEARCH_PROVIDERS[attempt.provider].label} (${SEARCH_REASONS[attempt.code]})`)
    .join('; ');
  const rest =
    stopped === 'cap'
      ? ` The daily limit (${String(dailyCap)} a day) was then used up, so the rest were not tried.`
      : stopped === 'ledger_damaged'
        ? ' Its daily counter could not be read, so the rest were not tried.'
        : '';
  return `Web search failed on every provider tried: ${named}.${rest} The owner can check them in Settings › Web search.`;
}

/** The calendar day on THIS machine's clock (`2026-11-24`): a day of searches is the machine's own day. */
function dayOf(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

function codeOf(outcome: Exclude<OutboundSecretOutcome, { readonly kind: 'completion' }>): SearchTestCode {
  switch (outcome.kind) {
    case 'status':
      if (outcome.status === 401 || outcome.status === 403) return 'rejected';
      return outcome.status === 429 ? 'rate_limited' : 'provider_error';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'unreachable';
    case 'too_large':
    case 'unreadable':
      return 'malformed';
    case 'vault_damaged':
      return 'vault_damaged';
    case 'refused':
      return outcome.refused === 'destination' || outcome.refused === 'placement' ? 'provider_error' : 'not_set';
  }
}

/** Nothing left the machine: the kernel refused before it sent. */
const leftNothing = (outcome: OutboundSecretOutcome): boolean =>
  outcome.kind === 'refused' || outcome.kind === 'vault_damaged';

/** Today's ledger, or a fresh one when the stored day is not today. */
const today = (current: Ledger | undefined, day: string): Ledger =>
  current?.day === day ? current : { day, calls: 0, tests: current?.tests ?? [] };

export class SearchService {
  constructor(private readonly parts: SearchParts) {}

  private config(): SearchConfig {
    return this.parts.config.file(SEARCH_CONFIG) ?? DEFAULT_SEARCH_CONFIG;
  }

  /** One lookup for a ferret: the providers in order, the first that answers wins. Every attempt counts against the cap and none is made past it. */
  async lookup(input: WebSearchInput): Promise<SearchOutcome> {
    const count = input.count ?? SEARCH_DEFAULT_RESULTS;
    const { providers } = this.config();
    if (providers.length === 0) return { kind: 'off' };
    const skipped: SearchAttempt[] = [];
    for (const { provider } of providers) {
      const answer = await this.attempt(provider, input.query, count, true);
      if (answer.kind === 'results') return { kind: 'results', provider, hits: answer.hits, skipped };
      if (answer.failure === 'cap' || answer.failure === 'ledger_damaged')
        return { kind: 'failed', tried: skipped, stopped: answer.failure };
      skipped.push({ provider, code: answer.failure });
    }
    return { kind: 'failed', tried: skipped };
  }

  /**
   * The owner's Test of ONE listed provider: one real search of a fixed word, with no fall-through, or `undefined`
   * while that provider is not in the list. Counted, but never refused for the cap: it is their own act.
   */
  async test(provider: SearchProviderId): Promise<SearchTestResult | undefined> {
    if (!this.config().providers.some(entry => entry.provider === provider)) return undefined;
    const started = this.parts.clock.nowMs();
    const outcome = await this.attempt(provider, TEST_QUERY, 1, false);
    const code: SearchTestCode =
      outcome.kind === 'results'
        ? 'ok'
        : outcome.failure === 'cap' || outcome.failure === 'ledger_damaged'
          ? 'provider_error'
          : outcome.failure;
    return await this.remember(this.resultOf(provider, code, Math.max(0, this.parts.clock.nowMs() - started)));
  }

  async view(): Promise<SearchView> {
    const config = this.config();
    const ledger = await this.parts.state.read(SEARCH_LEDGER_STATE);
    const current = ledger.ok ? ledger.value : undefined;
    const status = this.parts.config.fileState(SEARCH_CONFIG);
    return {
      providers: config.providers.map(({ provider }) => {
        const lastTest = current?.tests.find(test => test.provider === provider);
        return { provider, ...(lastTest === undefined ? {} : { lastTest }) };
      }),
      dailyCap: config.dailyCap,
      usedToday: current?.day === dayOf(this.parts.clock.nowMs()) ? current.calls : 0,
      held: status.state === 'held' ? [...status.sentences] : [],
    };
  }

  /**
   * The caller's own setup: the whole ordered provider list, each naming its key (`key: ${secret:NAME}`), and/or the
   * cap, as ONE write of the file. In effect when the caller is the owner; otherwise held for the owner and answered as sentences.
   */
  async setup(request: SearchSetupRequest): Promise<SearchSetupResult> {
    const patch = {
      ...(request.providers === undefined
        ? {}
        : { providers: request.providers.map(provider => ({ provider, key: searchKeyReference(provider) })) }),
      ...(request.dailyCap === undefined ? {} : { dailyCap: request.dailyCap }),
    };
    const result = await this.parts.config.writeAsCaller(SEARCH_CONFIG, undefined, { patch });
    return setupOutcome(result);
  }

  /** One send to one provider. Takes a call from the day first and says why not when it cannot. */
  private async attempt(
    provider: SearchProviderId,
    query: string,
    count: number,
    enforceCap: boolean,
  ): Promise<Attempt> {
    const config = this.config();
    if (!config.providers.some(entry => entry.provider === provider)) return { kind: 'failed', failure: 'not_set' };

    const reserved = await this.reserve(config.dailyCap, enforceCap);
    if (reserved !== 'taken') return { kind: 'failed', failure: reserved };

    const adapter = SEARCH_ADAPTERS[provider];
    const request = adapter.request(query, count);
    const sent = await this.parts.secrets.send(
      SEARCH_PROVIDERS[provider].secretName,
      {
        method: request.method,
        url: request.url,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        timeoutMs: SEARCH_TIMEOUT_MS,
        maxResponseBytes: SEARCH_MAX_REPLY_BYTES,
      },
      request.placement,
    );
    // One line per search: the provider and what came back. Never the query (it is the owner's words) or a body.
    this.parts.log.info('search.sent', { provider, outcome: sent.kind });
    if (leftNothing(sent)) await this.giveBack();
    if (sent.kind !== 'completion') return { kind: 'failed', failure: codeOf(sent) };
    const hits = adapter.read(sent.payload);
    return hits === undefined
      ? { kind: 'failed', failure: 'malformed' }
      : { kind: 'results', hits: hits.slice(0, count) };
  }

  /** Takes one call from today's ledger, or says why not. Atomic: the state file's own chain orders callers. */
  private async reserve(cap: number, enforceCap: boolean): Promise<'taken' | 'cap' | 'ledger_damaged'> {
    const day = dayOf(this.parts.clock.nowMs());
    let capped = false;
    const written = await this.parts.state.update(SEARCH_LEDGER_STATE, (current): Ledger => {
      const base = today(current, day);
      if (enforceCap && base.calls >= cap) {
        capped = true;
        return current ?? base;
      }
      return { ...base, calls: base.calls + 1 };
    });
    if (!written.ok) return 'ledger_damaged';
    return capped ? 'cap' : 'taken';
  }

  private async giveBack(): Promise<void> {
    const day = dayOf(this.parts.clock.nowMs());
    await this.parts.state.update(SEARCH_LEDGER_STATE, (current): Ledger => {
      const base = today(current, day);
      return { ...base, calls: Math.max(0, base.calls - 1) };
    });
  }

  private resultOf(provider: SearchProviderId, code: SearchTestCode, latencyMs: number | undefined): SearchTestResult {
    return {
      provider,
      ok: code === 'ok',
      code,
      message: SEARCH_MESSAGES[code],
      ...(latencyMs === undefined ? {} : { latencyMs }),
      at: this.parts.clock.now(),
    };
  }

  private async remember(result: SearchTestResult): Promise<SearchTestResult> {
    const day = dayOf(this.parts.clock.nowMs());
    await this.parts.state.update(SEARCH_LEDGER_STATE, (current): Ledger => {
      const base = today(current, day);
      return { ...base, tests: [...base.tests.filter(test => test.provider !== result.provider), result] };
    });
    return result;
  }
}

/** What a write came to, for the setup route: applied, held with the sentences, or an error the route raises. */
function setupOutcome(result: ConfigWriteOutcome): SearchSetupResult {
  switch (result.kind) {
    case 'written':
      return { outcome: 'applied', held: [...(result.stillHeld?.sentences ?? [])] };
    case 'held':
      return { outcome: 'held', held: [...result.sentences] };
    case 'conflict':
      throw new SearchSetupRefused(409, 'search.yaml changed while you were editing it. Read it again and retry.');
    case 'refused':
      throw new SearchSetupRefused(
        400,
        result.issues.map(issue => issue.message).join('; ') || 'search.yaml could not be written.',
      );
  }
}

export class SearchSetupRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SearchSetupRefused';
  }
}
