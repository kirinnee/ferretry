/**
 * Where the Pages build gets its SUGGESTIONS (docs/model-catalog.md § Suggestions): models.dev, trimmed, plus
 * LiteLLM's retirement dates. ONLY the build reads either; an owner's machine never does.
 *
 *   bun run scripts/suggestions-source.ts --refresh   rewrites daemon/data/suggestions/models-dev.json (a PR)
 *
 * THE BUILD NEVER PUBLISHES EMPTY and never depends on a third party being up:
 *
 * 1. models.dev is fetched from a fixed URL and trimmed. When it is down, is not JSON, lacks a provider the
 *    snapshot has, or holds under half the snapshot's models for one, the build uses the LAST COMMITTED
 *    SNAPSHOT and prints a `::warning::` saying why.
 * 2. LiteLLM failing costs only the retirement dates (the snapshot's are kept when it is the fallback).
 * 3. No usable fetch AND no valid snapshot is a failed build, loudly.
 *
 * Both documents are untrusted data: everything goes through `suggestions.ts`, which caps, checks and drops.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LITELLM_URL,
  MODELS_DEV_URL,
  readSuggestions,
  SUGGESTION_PROVIDERS,
  type Suggestions,
  stableJson,
  trimModelsDev,
  withRetirementDates,
} from '../daemon/lib/catalog/suggestions.ts';

/** The last committed snapshot, relative to this package. */
export const SUGGESTIONS_SNAPSHOT_FILE = resolve(
  import.meta.dir,
  '..',
  'daemon',
  'data',
  'suggestions',
  'models-dev.json',
);

/** A fresh models.dev must hold at least this share of each snapshot provider's models, or it is not believed. */
const MIN_SHARE = 0.5;

/** What the build needs from the world; tests hand in fakes. */
export interface SuggestionsDeps {
  /** GET a URL and parse the body as JSON. Rejects on a network error, a non-200, or a body that is not JSON. */
  readonly getJson: (url: string) => Promise<unknown>;
  /** The committed snapshot's parsed text, `undefined` when there is none. */
  readonly readSnapshot: () => Promise<unknown>;
  /** Today as YYYY-MM-DD (UTC). */
  readonly today: () => string;
  /** One line of build output (a `::warning::` line is a GitHub annotation). */
  readonly log: (line: string) => void;
}

/** The build could neither fetch models.dev nor use a committed snapshot. */
class SuggestionsUnavailableError extends Error {
  constructor(reason: string) {
    super(`❌ no suggestions to publish: ${reason}`);
    this.name = 'SuggestionsUnavailableError';
  }
}

const count = (suggestions: Suggestions, provider: string): number =>
  Object.keys(suggestions.providers[provider]?.models ?? {}).length;

/** Why a fresh trim is not believable next to the snapshot, or `undefined` when it is. */
function implausible(fresh: Suggestions, snapshot: Suggestions | undefined): string | undefined {
  const present = SUGGESTION_PROVIDERS.filter(provider => count(fresh, provider) > 0);
  if (present.length === 0) return 'models.dev held none of the providers we keep';
  if (snapshot === undefined) return undefined;
  for (const provider of Object.keys(snapshot.providers)) {
    const was = count(snapshot, provider);
    const now = count(fresh, provider);
    if (now < was * MIN_SHARE) return `${provider} has ${now} models, the snapshot ${was}`;
  }
  return undefined;
}

async function snapshotOf(deps: SuggestionsDeps): Promise<Suggestions | undefined> {
  const raw = await deps.readSnapshot().catch(() => undefined);
  if (raw === undefined) return undefined;
  const read = readSuggestions(raw);
  return read.suggestions !== undefined &&
    read.dropped.length === 0 &&
    Object.keys(read.suggestions.providers).length > 0
    ? read.suggestions
    : undefined;
}

/** models.dev now, trimmed, with LiteLLM's dates; a problem sentence when it cannot be believed. */
async function liveSuggestions(
  deps: SuggestionsDeps,
  snapshot: Suggestions | undefined,
): Promise<{ readonly suggestions: Suggestions } | { readonly problem: string }> {
  const raw = await deps.getJson(MODELS_DEV_URL).then(
    value => ({ value }),
    (error: unknown) => ({
      problem: `models.dev could not be read (${error instanceof Error ? error.message : String(error)})`,
    }),
  );
  if ('problem' in raw) return raw;
  const trimmed = trimModelsDev(raw.value);
  for (const dropped of trimmed.dropped) deps.log(`models.dev: dropped ${dropped.where}: ${dropped.problem}`);
  const dates = await deps.getJson(LITELLM_URL).then(
    value => ({ value }),
    (error: unknown) => {
      deps.log(
        `::warning::LiteLLM could not be read (${error instanceof Error ? error.message : String(error)}); no retirement dates this build`,
      );
      return undefined;
    },
  );
  const providers =
    dates === undefined ? trimmed.providers : withRetirementDates(trimmed.providers, dates.value).providers;
  const suggestions: Suggestions = {
    generated: deps.today(),
    sources: { modelsDev: MODELS_DEV_URL, ...(dates === undefined ? {} : { litellm: LITELLM_URL }) },
    providers,
  };
  const problem = implausible(suggestions, snapshot);
  return problem === undefined ? { suggestions } : { problem };
}

/** What the build publishes: live when believable, else the committed snapshot, else a thrown error. */
export async function buildSuggestions(deps: SuggestionsDeps): Promise<Suggestions> {
  const snapshot = await snapshotOf(deps);
  const live = await liveSuggestions(deps, snapshot);
  if ('suggestions' in live) return live.suggestions;
  if (snapshot === undefined)
    throw new SuggestionsUnavailableError(`${live.problem}, and there is no valid committed snapshot`);
  deps.log(`::warning::${live.problem}; publishing the committed snapshot of ${snapshot.generated}`);
  return snapshot;
}

/** The real world: Bun's fetch with a timeout, the committed file, the clock. */
export function realSuggestionsDeps(): SuggestionsDeps {
  return {
    getJson: async url => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return (await response.json()) as unknown;
    },
    readSnapshot: async () => JSON.parse(await readFile(SUGGESTIONS_SNAPSHOT_FILE, 'utf8')) as unknown,
    today: () => new Date().toISOString().slice(0, 10),
    log: line => process.stdout.write(`${line}\n`),
  };
}

if (import.meta.main) {
  if (process.argv[2] !== '--refresh') {
    process.stderr.write('❌ usage: bun run scripts/suggestions-source.ts --refresh\n');
    process.exit(64);
  }
  const deps = realSuggestionsDeps();
  const live = await liveSuggestions(deps, await snapshotOf(deps));
  if ('problem' in live) {
    process.stderr.write(`❌ the snapshot was not refreshed: ${live.problem}\n`);
    process.exit(1);
  }
  await writeFile(SUGGESTIONS_SNAPSHOT_FILE, stableJson(live.suggestions));
  process.stdout.write(`✅ ${SUGGESTIONS_SNAPSHOT_FILE} written (${live.suggestions.generated})\n`);
}
