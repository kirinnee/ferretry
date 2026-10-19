/**
 * Reading the models Ollama has installed on this machine (docs/model-catalog.md § Local models).
 *
 * Ollama lists them at `GET /api/tags`. This file knows the address, the reply and what each outcome of
 * the read means for a person — a pure translation, so the service that does the reading (and the routes
 * that show it) hold no Ollama knowledge of their own. Nothing here is a credential: the read carries no
 * key, and a model list is the same data `ollama list` prints.
 *
 * Pure.
 */
import { catalogDefault, MODEL_ID_PATTERN, type ModelCatalog } from '@ferretry/fleet';
import { isLoopbackHost, type LocalModel, type LocalModels } from '@ferretry/protocol';
import { z } from 'zod';
import type { AuthorizedOutcome } from '../speedups/ports.ts';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_PORT = '11434';

/** A model list is a few kilobytes even for a long shelf; this is generous and still bounded. */
export const OLLAMA_MAX_BYTES = 1_024 * 1_024;
/** A server on this machine answers at once or is not there. */
export const OLLAMA_TIMEOUT_MS = 3_000;

/** The address to read, or why it may not be. */
export type OllamaAddress =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly baseUrl: string };

/**
 * Where Ollama is: `OLLAMA_HOST` in the forms Ollama itself takes (`127.0.0.1:11434`, `0.0.0.0`, `:11434`,
 * `http://localhost:9999`), or the default. Only a server on this machine is ever read — the same rule a
 * login Test without a key follows — so an address anywhere else is refused, never dialled.
 */
export function ollamaAddress(raw: string | undefined): OllamaAddress {
  const text = raw?.trim() ?? '';
  if (text === '') return { ok: true, baseUrl: DEFAULT_OLLAMA_URL };
  // A bare `:port` means "this machine, that port".
  const withHost = text.startsWith(':') ? `127.0.0.1${text}` : text;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(withHost) ? withHost : `http://${withHost}`);
  } catch {
    return { ok: false, baseUrl: DEFAULT_OLLAMA_URL };
  }
  // `0.0.0.0` and `[::]` mean "listen on every interface"; the way to reach that is this machine.
  const wildcard: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '[::]': '[::1]' };
  const host = wildcard[parsed.hostname] ?? parsed.hostname;
  // The address is rebuilt from its host and port alone: a credential in it never reaches a message.
  const baseUrl = `http://${host}:${parsed.port === '' ? OLLAMA_PORT : parsed.port}`;
  if (parsed.protocol !== 'http:' || !isLoopbackHost(host)) return { ok: false, baseUrl };
  return { ok: true, baseUrl };
}

const TagSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative().optional(),
  modified_at: z.string().optional(),
  details: z
    .object({
      family: z.string().optional(),
      parameter_size: z.string().optional(),
      quantization_level: z.string().optional(),
    })
    .optional(),
});
const TagsSchema = z.object({ models: z.array(z.unknown()) });

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

const instantOf = (value: string | undefined): string | undefined => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

/**
 * The installed models in `/api/tags`'s reply, in the order Ollama gave (newest first), or `undefined`
 * when the reply is not Ollama's. An entry that is not a usable id is left out: a name the CLIs could
 * not be handed would only fail later.
 */
export function parseOllamaTags(payload: unknown): readonly LocalModel[] | undefined {
  const tags = TagsSchema.safeParse(payload);
  if (!tags.success) return undefined;
  const seen = new Set<string>();
  const models: LocalModel[] = [];
  for (const raw of tags.data.models) {
    const tag = TagSchema.safeParse(raw);
    if (!tag.success || !MODEL_ID_PATTERN.test(tag.data.name) || seen.has(tag.data.name)) continue;
    seen.add(tag.data.name);
    const modifiedAt = instantOf(tag.data.modified_at);
    const parameterSize = present(tag.data.details?.parameter_size);
    const quantization = present(tag.data.details?.quantization_level);
    const family = present(tag.data.details?.family);
    models.push({
      id: tag.data.name,
      label: tag.data.name,
      ...(tag.data.size === undefined ? {} : { sizeBytes: tag.data.size }),
      ...(parameterSize === undefined ? {} : { parameterSize }),
      ...(quantization === undefined ? {} : { quantization }),
      ...(family === undefined ? {} : { family }),
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
    });
  }
  return models;
}

/** What the install command names when the catalog suggests nothing. */
const FALLBACK_SUGGESTION = 'gpt-oss:20b';

/** The model the Ollama catalog launches with: what the empty state tells a person to pull. */
export function suggestedOllamaModel(catalogs: Readonly<Record<string, ModelCatalog>>): string {
  const half = catalogs.ollama?.codex;
  return half === undefined ? FALLBACK_SUGGESTION : catalogDefault(half).id;
}

/** The exact command that installs a model. */
export const pullCommand = (model: string): string => `ollama pull ${model}`;

const plural = (count: number): string => `${count} model${count === 1 ? '' : 's'}`;

/** What one read of Ollama came to, as the view a person reads. `suggested` is the model to pull. */
export function describeOllama(input: {
  readonly address: OllamaAddress;
  /** `undefined` when nothing was sent: the address was refused, or reading is switched off. */
  readonly outcome: AuthorizedOutcome | undefined;
  readonly disabled?: boolean;
  readonly suggested: string;
  readonly at: string;
}): LocalModels {
  const { address, outcome, suggested, at, disabled = false } = input;
  const view = (state: LocalModels['state'], message: string, models: readonly LocalModel[] = []): LocalModels => ({
    provider: 'ollama',
    baseUrl: address.baseUrl,
    state,
    models,
    checkedAt: at,
    message,
    pullCommand: pullCommand(suggested),
  });
  if (disabled) {
    return view(
      'disabled',
      'Reading the models Ollama has installed is switched off on this daemon (FY_LOCAL_MODELS=off).',
    );
  }
  if (!address.ok || outcome === undefined) {
    return view(
      'refused',
      'Ferretry only reads an Ollama server on this machine, and OLLAMA_HOST names another address. Point it at localhost, or unset it.',
    );
  }
  if (outcome.kind === 'completion') {
    const models = parseOllamaTags(outcome.payload);
    if (models === undefined) return view('unreadable', unreadable(address.baseUrl));
    return models.length === 0
      ? view('none-pulled', `Ollama is running, but no model is installed yet. Run: ${pullCommand(suggested)}`)
      : view('found', `Ollama has ${plural(models.length)} installed on this machine.`, models);
  }
  if (outcome.kind === 'timeout' || outcome.kind === 'unreachable') {
    return view(
      'not-running',
      `Ollama is not running at ${address.baseUrl}. Start it (open the Ollama app, or run: ollama serve), then check again.`,
    );
  }
  return view('unreadable', unreadable(address.baseUrl));
}

const unreadable = (baseUrl: string): string =>
  `Something answered at ${baseUrl}, but not as Ollama does. Check that the address is an Ollama server.`;
