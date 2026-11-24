/**
 * The model ids in the body of a provider's model-list reply (docs/model-catalog.md § Live model list).
 *
 * THE REPLY IS UNTRUSTED: it came from a host the person pointed a key at (a gateway may be anybody's). Only the
 * identifier of each model is read; every other field (names, prices, owners, whatever a gateway adds) is ignored and
 * never kept. An id that is not one word of the catalog's grammar is dropped, the list is cut at
 * {@link MODEL_LIST_MAX_IDS} (and says so), and a reply that is not a model list at all is `undefined` — the caller keeps
 * the list it had.
 *
 * Three shapes, read from the providers' own documentation:
 * - `anthropic`: `{ data: [{ id, type: "model", … }], first_id, has_more, last_id }`. Anthropic, and MiniMax's
 *   Anthropic-compatible `/anthropic/v1/models`, which documents the same shape. `has_more: true` means a page.
 * - `openai`: `{ object: "list", data: [{ id, object: "model", … }] }`. OpenAI, Azure OpenAI, DeepSeek, Moonshot, MiniMax's
 *   `/v1/models`, LiteLLM and most gateways. It has no pages.
 * - `gemini`: `{ models: [{ name: "models/<id>", supportedGenerationMethods, … }], nextPageToken }`. A `nextPageToken`
 *   means a page; a model that lists its methods and cannot `generateContent` (an embedding model) is left out.
 *
 * Pure.
 */
import { MODEL_LIST_ID, MODEL_LIST_MAX_IDS } from '../../../contract/model-list.ts';

type ModelListShape = 'anthropic' | 'openai' | 'gemini';

/** What one reply held: the shape it was read as, its ids in the provider's order, and whether it was the whole list. */
export interface ParsedModelList {
  readonly shape: ModelListShape;
  readonly ids: readonly string[];
  readonly complete: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The accepted, de-duplicated ids and whether the cap cut any. */
function accepted(candidates: readonly unknown[]): { readonly ids: readonly string[]; readonly cut: boolean } {
  const seen = new Set<string>();
  let cut = false;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !MODEL_LIST_ID.test(candidate) || seen.has(candidate)) continue;
    if (seen.size >= MODEL_LIST_MAX_IDS) {
      cut = true;
      break;
    }
    seen.add(candidate);
  }
  return { ids: [...seen], cut };
}

const result = (shape: ModelListShape, candidates: readonly unknown[], paged: boolean): ParsedModelList | undefined => {
  const { ids, cut } = accepted(candidates);
  // A list with no usable id proves nothing about the key (a gateway that lists none answers an error or `[]`).
  return ids.length === 0 ? undefined : { shape, ids, complete: !paged && !cut };
};

/** `{ data: [{ id }], has_more }`: Anthropic's shape, which MiniMax's Anthropic-compatible endpoint documents too. */
export function parseAnthropicList(payload: unknown): ParsedModelList | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  return result(
    'anthropic',
    payload.data.map(row => (isRecord(row) ? row.id : undefined)),
    payload.has_more === true,
  );
}

/** `{ object: "list", data: [{ id }] }`: the OpenAI-style shape. */
export function parseOpenAiList(payload: unknown): ParsedModelList | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  return result(
    'openai',
    payload.data.map(row => (isRecord(row) ? row.id : undefined)),
    false,
  );
}

const GEMINI_NAME = /^models\/(.+)$/u;

/** `{ models: [{ name: "models/<id>" }], nextPageToken }`: Gemini's shape. */
export function parseGeminiList(payload: unknown): ParsedModelList | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;
  const ids = payload.models.map(row => {
    if (!isRecord(row) || typeof row.name !== 'string') return undefined;
    const methods = row.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) return undefined;
    return GEMINI_NAME.exec(row.name)?.[1];
  });
  const paged = typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0;
  return result('gemini', ids, paged);
}

/**
 * The ids in a reply, whatever of the three shapes it is: a top-level `models` array is Gemini's, a `data` array that
 * says `object: "list"` (or whose rows say `object: "model"`) is OpenAI-style, any other `data` array is Anthropic's.
 */
export function parseModelList(payload: unknown): ParsedModelList | undefined {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.models)) return parseGeminiList(payload);
  if (!Array.isArray(payload.data)) return undefined;
  const openAiStyle = payload.object === 'list' || payload.data.some(row => isRecord(row) && row.object === 'model');
  return openAiStyle ? parseOpenAiList(payload) : parseAnthropicList(payload);
}
