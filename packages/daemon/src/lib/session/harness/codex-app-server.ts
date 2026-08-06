/**
 * Asking a Codex account what models it advertises, as a pure conversation.
 *
 * Codex answers `model/list` over a line-delimited JSON-RPC channel on its own app-server. That is a
 * child with a pipe, which is an adapter's business — but every DECISION in the exchange is here:
 * which message to send next, what a reply means, when the catalog is complete, and which replies
 * are failures. The adapter therefore owns spawning, framing and the clock, and owns no judgement at
 * all.
 *
 * WHY THE PROBE IS EPHEMERAL. It is a second, short-lived speaker to the same account — never a
 * second owner of the running conversation. It exists because the picker the daemon has to drive is
 * built from exactly this list, so a catalog read from anywhere else could name a row the picker
 * will not show.
 *
 * ARRAY ORDER IS AUTHORITATIVE and deliberately retained: it is the order the picker renders, and a
 * sorted copy would make a row number computed here address a different row on screen.
 */

import type { RuntimeModelChoice, RuntimeReasoningChoice } from '@ferretry/protocol';

/** A JSON object, or `undefined` for anything else — an array included. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-blank string, trimmed. Blank is absent: the catalog must not offer a nameless row. */
function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** One page of `model/list`, with the cursor that continues it. */
export interface CodexModelListPage {
  readonly choices: readonly RuntimeModelChoice[];
  readonly nextCursor?: string;
}

/** The app-server refused, or answered something that is not a catalog. */
export class CodexModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexModelCatalogError';
  }
}

/** The reasoning levels one advertised model offers, deduplicated in advertised order. */
function reasoningEfforts(item: Record<string, unknown>): RuntimeReasoningChoice[] {
  const efforts: RuntimeReasoningChoice[] = [];
  const advertised = item.supportedReasoningEfforts;
  if (Array.isArray(advertised)) {
    for (const raw of advertised) {
      const effort = asObject(raw);
      const value = asString(effort?.reasoningEffort);
      if (value === undefined || efforts.some(candidate => candidate.value === value)) continue;
      const description = asString(effort?.description);
      efforts.push({ value, ...(description === undefined ? {} : { description }) });
    }
  }
  const fallback = asString(item.defaultReasoningEffort);
  // A provider that advertises no levels but names a default still has exactly one expressible
  // level. Retaining it is safer than inventing a scale the account never offered.
  if (efforts.length === 0 && fallback !== undefined) efforts.push({ value: fallback });
  return efforts;
}

/**
 * One `model/list` reply, parsed without assuming Codex's model or effort vocabulary.
 *
 * `model` is the value a settings update carries; `id` is catalog-internal metadata and must never
 * be promoted into a selectable runtime setting — they differ, and sending the wrong one selects
 * nothing.
 */
export function parseCodexModelListPage(message: unknown): CodexModelListPage {
  const envelope = asObject(message);
  const failure = asObject(envelope?.error);
  if (failure !== undefined) {
    throw new CodexModelCatalogError(
      `Codex model catalog request failed: ${asString(failure.message) ?? 'unknown app-server error'}`,
    );
  }
  const result = asObject(envelope?.result);
  if (result === undefined || !Array.isArray(result.data))
    throw new CodexModelCatalogError('Codex model/list returned an invalid response');

  const choices: RuntimeModelChoice[] = [];
  for (const raw of result.data) {
    const item = asObject(raw);
    if (item === undefined || item.hidden === true) continue;
    const value = asString(item.model);
    if (value === undefined) continue;
    const description = asString(item.description);
    const defaultReasoningEffort = asString(item.defaultReasoningEffort);
    choices.push({
      value,
      label: asString(item.displayName) ?? value,
      ...(description === undefined ? {} : { description }),
      ...(item.isDefault === true ? { isDefault: true as const } : {}),
      reasoningEfforts: reasoningEfforts(item),
      ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    });
  }
  const nextCursor = asString(result.nextCursor);
  return { choices, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

/** How many rows one page asks for. Codex's own client uses the same bound. */
const PAGE_LIMIT = 100;

/** The id of the handshake, distinct from every catalog request so a late reply cannot be mistaken. */
const INITIALIZE_ID = 1;

/** What the exchange wants done next. */
export interface CodexModelListStep {
  /** Messages to write, in order. */
  readonly send: readonly unknown[];
  /** Present exactly once, when the catalog is complete. */
  readonly choices?: readonly RuntimeModelChoice[];
}

/**
 * The `model/list` exchange as a state machine.
 *
 * Deliberately not a loop over a stream: the loop belongs to the adapter that owns the pipe, and
 * keeping the state here is what lets every branch — the handshake failing, a page erroring, a
 * cursor continuing, a duplicate row arriving twice — be driven without a child at all.
 */
export class CodexModelListExchange {
  #initialized = false;
  #nextRequestId = 2;
  #awaiting = 2;
  #done = false;
  readonly #choices: RuntimeModelChoice[] = [];

  /** The handshake. Always the first thing written. */
  start(clientName: string, clientVersion: string): unknown {
    return {
      method: 'initialize',
      id: INITIALIZE_ID,
      params: { clientInfo: { name: clientName, title: clientName, version: clientVersion } },
    };
  }

  /** True once {@link receive} has produced the complete catalog. */
  get complete(): boolean {
    return this.#done;
  }

  /**
   * Interpret one reply.
   *
   * A reply whose id is neither the handshake's nor the page currently awaited is IGNORED rather
   * than treated as an answer: the app-server also emits notifications, and reading one as a
   * catalog page would end the exchange with whatever it happened to contain.
   */
  receive(message: unknown): CodexModelListStep {
    const envelope = asObject(message);
    const id = typeof envelope?.id === 'number' ? envelope.id : undefined;
    if (id === INITIALIZE_ID && !this.#initialized) {
      // The handshake carries no catalog, so the only thing to read from it is a refusal.
      if (envelope?.error !== undefined) parseCodexModelListPage(message);
      this.#initialized = true;
      return { send: [{ method: 'initialized', params: {} }, this.#page()] };
    }
    if (id !== this.#awaiting || this.#done) return { send: [] };

    const page = parseCodexModelListPage(message);
    for (const choice of page.choices) {
      if (!this.#choices.some(candidate => candidate.value === choice.value)) this.#choices.push(choice);
    }
    if (page.nextCursor !== undefined) {
      this.#awaiting = ++this.#nextRequestId;
      return { send: [this.#page(page.nextCursor)] };
    }
    this.#done = true;
    if (this.#choices.length === 0)
      throw new CodexModelCatalogError('Codex did not advertise any selectable runtime models');
    return { send: [], choices: this.#choices };
  }

  #page(cursor?: string): unknown {
    return {
      method: 'model/list',
      id: this.#awaiting,
      params: { includeHidden: false, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
    };
  }
}
