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
 * 3. No usable fetch AND no valid snapshot is a failed build, loudly. A snapshot is valid only when it reads whole
 *    and every provider we keep holds models: one provider with none would publish an empty suggestion set.
 * 4. Each download is capped at {@link MAX_DOWNLOAD_BYTES} BEFORE it is parsed, so a hostile or broken answer
 *    cannot make the build read without limit.
 * 5. The FINAL `catalog/models.json` must gzip under {@link GZIP_BUDGET_BYTES}. Over it, the build publishes the
 *    committed snapshot instead (with a `::warning::`); when that is over too, the build fails.
 *
 * Both documents are untrusted data: everything goes through `suggestions.ts`, which caps, checks and drops.
 */
import { gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelCatalog } from '../daemon/lib/catalog/schema.ts';
import { publishedModelCatalogFiles } from '../daemon/lib/catalog/published.ts';
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

/**
 * The most bytes one download may hold before it is parsed. models.dev's `api.json` is a few MB and LiteLLM's price
 * file about the same; 8 MiB leaves several times that room for growth while a runaway body stops the build at a
 * size its memory can hold.
 */
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** The published `catalog/models.json` must gzip under this (docs/model-catalog.md § Suggestions). */
export const GZIP_BUDGET_BYTES = 300 * 1024;

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
  return read.suggestions !== undefined && read.dropped.length === 0 && holdsEveryProvider(read.suggestions)
    ? read.suggestions
    : undefined;
}

/**
 * A snapshot is a fallback only when it holds models for EVERY provider we keep: the same "none lost" rule the live
 * fetch applies against it (`implausible`), so a snapshot with a provider emptied, or one missing, cannot be
 * published as if it were whole.
 */
function holdsEveryProvider(snapshot: Suggestions): boolean {
  return SUGGESTION_PROVIDERS.every(provider => count(snapshot, provider) > 0);
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
  const dated = dates === undefined ? undefined : withRetirementDates(trimmed.providers, dates.value);
  for (const dropped of dated?.dropped ?? []) deps.log(`LiteLLM: dropped ${dropped.where}: ${dropped.problem}`);
  const providers = dated === undefined ? trimmed.providers : dated.providers;
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
  return (await chooseSuggestions(deps)).suggestions;
}

/** {@link buildSuggestions}, and whether the answer is the fresh fetch or the committed snapshot. */
async function chooseSuggestions(
  deps: SuggestionsDeps,
): Promise<{ readonly suggestions: Suggestions; readonly from: 'live' | 'snapshot' }> {
  const snapshot = await snapshotOf(deps);
  const live = await liveSuggestions(deps, snapshot);
  if ('suggestions' in live) return { suggestions: live.suggestions, from: 'live' };
  if (snapshot === undefined)
    throw new SuggestionsUnavailableError(`${live.problem}, and there is no valid committed snapshot`);
  deps.log(`::warning::${live.problem}; publishing the committed snapshot of ${snapshot.generated}`);
  return { suggestions: snapshot, from: 'snapshot' };
}

/** `catalog/models.json`'s size once gzipped, the figure the budget is held against. */
const gzippedBytes = (text: string): number => gzipSync(text).length;

/**
 * The files the build writes, with the final `models.json` held to the gzip budget BEFORE anything is written. A
 * live fetch that pushes it over falls back to the committed snapshot; a snapshot that is over too fails the build.
 */
export async function buildPublishedFiles(
  version: number,
  catalogs: Readonly<Record<string, ModelCatalog>>,
  deps: SuggestionsDeps,
  budget: number = GZIP_BUDGET_BYTES,
): Promise<Readonly<Record<string, string>>> {
  const chosen = await chooseSuggestions(deps);
  const within = (suggestions: Suggestions): Readonly<Record<string, string>> | { readonly over: number } => {
    const files = publishedModelCatalogFiles(version, catalogs, suggestions);
    const size = gzippedBytes(files['catalog/models.json'] ?? '');
    return size <= budget ? files : { over: size };
  };
  const first = within(chosen.suggestions);
  if (!('over' in first)) return first;
  const snapshot = chosen.from === 'live' ? await snapshotOf(deps) : undefined;
  const second = snapshot === undefined ? undefined : within(snapshot);
  if (second !== undefined && !('over' in second)) {
    deps.log(
      `::warning::the published models.json would be ${first.over} bytes gzipped, over the ${budget} budget; publishing the committed snapshot of ${snapshot?.generated}`,
    );
    return second;
  }
  throw new SuggestionsUnavailableError(
    `the published models.json is ${first.over} bytes gzipped, over the ${budget} budget` +
      (second === undefined
        ? chosen.from === 'live'
          ? ', and there is no valid committed snapshot to fall back to'
          : ' (it is the committed snapshot: trim it)'
        : `, and the committed snapshot is ${second.over} bytes`),
  );
}

/**
 * Read a response as JSON, but never more than `max` bytes of it: a declared length over the cap is refused before a
 * byte is read, and a body that outgrows the cap while streaming is cancelled.
 */
export async function readJsonCapped(url: string, response: Response, max: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max)
    throw new Error(`${url} declares ${declared} bytes, over the ${max} byte cap`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${url} sent no body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${url} is over the ${max} byte cap`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** The real world: Bun's fetch with a timeout and a byte cap, the committed file, the clock. */
export function realSuggestionsDeps(): SuggestionsDeps {
  return {
    getJson: async url => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return readJsonCapped(url, response, MAX_DOWNLOAD_BYTES);
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
