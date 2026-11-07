/**
 * THE COMPOSER'S SEAM: every name the composer files took from a shared PWA module that is NOT Conversation's and
 * has no `@ferretry/app` export, kept in ONE file so its owner can replace each in one place. Nothing here is new
 * behaviour: each is a re-export, a short marked copy of today's code, or a typed stand-in that behaves as today's
 * code does when the thing it stands for is absent.
 *
 *   - DaemonId / DaemonConnection / daemonConnection ...... identity only: the half's client is already one daemon
 *     (`useConversationDaemon()`), so a connection is the id the shell recorded for that client.
 *   - DaemonFerretScope / daemonFerretScope / daemonFerretKey .. re-exports of `@ferretry/app` (`compose/ferret-scope.ts`).
 *   - ConversationCaller / callRefusal ...................... the plugin client's `call` (§9.6), replacing today's
 *     `DaemonFetch` / `browserFetch` / `daemonRequest`; a refusal is `DaemonCallError` (status, code, sentence).
 *   - carrierDelivery ....................................... GAP(app-shell): today's `relay-carrier.ts` walk; the 5.0
 *     client does not classify an outage yet, so this reads a `delivery` mark off the error chain and finds none.
 *   - devicePreference, the foreground pin scope ......... re-exports of `@ferretry/app` (GAP(ferrets): nothing sets
 *     the pinned pane in front until Ferrets' app half does).
 *   - withReferences / referencesOf / withReferencePrefix ... copies of Agenda's "re:" chip helpers (today's
 *     `agenda-reply.ts`, `answer-chip.ts`): the composer stores the chips beside an unsent message.
 *   - FerretContext ......................................... GAP(C3, Q0): today's `SessionContext`, until the Ferrets
 *     contract exports the ferret view schemas.
 *   - WorkSearchPort ........................................ GAP(C4): the work-search port's shape, until C4's
 *     `app/search/work-search.ts` lands; the composer's pickers read it.
 *   - canSubmitComposer ..................................... copy of today's `session-screens.ts` one-liner (C3's split).
 */

import { type ComposerDaemonId, DaemonCallError } from '@ferretry/app';

export {
  clearForegroundPinScope,
  type DaemonFerretScope,
  daemonFerretKey,
  daemonFerretScope,
  type DevicePreference,
  devicePreference,
  getForegroundPinScope,
  setForegroundPinScope,
} from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { WorkSearchQuery, WorkSearchResponse } from '../../contract/index.ts';

// ─── the daemon this half talks to ────────────────────────────────────────────────────────────────────────────────

export type DaemonId = ComposerDaemonId;

/** Which daemon a value belongs to. The shell's per-daemon client already is one daemon: this is an identity only. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
}

export const daemonConnection = (daemonId: string): DaemonConnection => ({ daemonId });

// ─── the plugin client ────────────────────────────────────────────────────────────────────────────────────────────

/** The only client capability most composer files use. */
export type ConversationCaller = Pick<PluginClient, 'call'>;

export { DaemonCallError };

/** A refusal as the composer reads it: the status, the daemon's machine code when it sent one, and its sentence. */
export interface CallRefusal {
  readonly status: number;
  readonly code?: string;
  readonly message: string;
}

/** The refusal inside a thrown value, or `undefined` for anything that is not the daemon answering no. */
export const callRefusal = (error: unknown): CallRefusal | undefined => {
  if (error instanceof DaemonCallError)
    return { status: error.status, ...(error.code === '' ? {} : { code: error.code }), message: error.message };
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number' &&
    error instanceof Error
  ) {
    const code = (error as { code?: unknown }).code;
    return {
      status: (error as unknown as { status: number }).status,
      ...(typeof code === 'string' ? { code } : {}),
      message: error.message,
    };
  }
  return undefined;
};

/**
 * Whether a request that failed on the carrier may have reached the daemon: `unsent` (proved not to have left), or
 * `unknown`; `undefined` for anything that is not a carrier outage. GAP(app-shell): the 5.0 client marks no outage yet,
 * so this walks the chain for a `delivery` mark exactly as today's walk did and, absent one, says "not an outage".
 */
export type CarrierDelivery = 'unsent' | 'unknown';

export const carrierDelivery = (reason: unknown): CarrierDelivery | undefined => {
  let current = reason;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const delivery = (current as { delivery?: unknown }).delivery;
    if (delivery === 'unsent' || delivery === 'unknown') return delivery;
    current = current.cause;
  }
  return undefined;
};

// ─── Agenda's "re:" chips (copies of today's agenda-reply.ts / answer-chip.ts) ────────────────────────────────────

/** An Agenda item id (`A5`). */
export type AgendaId = string;

/**
 * A message with the items its "re:" chips name: each as a `!A5` reference at the front, in chip order, each once
 * (one already typed is not repeated). Nothing is guessed — only the chips the owner added.
 */
export const withReferences = (text: string, ids: readonly AgendaId[]): string => {
  const missing = [...new Set(ids)].filter(id => !new RegExp(`(?:^|\\s)!${id}(?=$|[\\s.,;:!?)])`, 'u').test(text));
  return missing.length === 0 ? text : `${missing.map(id => `!${id}`).join(' ')} ${text}`;
};

/** Where a reference-carrying client keeps its chips, for a sender that must remember them past this send. */
const REFERENCES: unique symbol = Symbol('agenda-references');

/** The Agenda items a client made by {@link withReferencePrefix} would prefix right now; none for any other client. */
export const referencesOf = (client: object): readonly AgendaId[] => {
  const read = (client as { readonly [REFERENCES]?: unknown })[REFERENCES];
  return typeof read === 'function' ? (read as () => readonly AgendaId[])() : [];
};

/** A client whose `send` carries the chips' references; every other method is the target's own. */
export const withReferencePrefix = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  idsOf: () => readonly AgendaId[],
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
      if (key === REFERENCES) return idsOf;
      const value = Reflect.get(target, key, receiver);
      if (key !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return (ferretId: string, body: { readonly message: string }, ...rest: unknown[]) =>
        (value as (...args: unknown[]) => unknown).call(
          target,
          ferretId,
          { ...body, message: withReferences(body.message, idsOf()) },
          ...rest,
        );
    },
  });

// ─── shapes owned elsewhere (GAPs) ────────────────────────────────────────────────────────────────────────────────

/** GAP(ferrets, Q0): today's `SessionContext` — `@ferretry/app`'s `ContextUsage` until the Ferrets contract exports it. */
export type { ContextUsage as FerretContext } from '@ferretry/app';

/** GAP(C4): the work search port, until `app/search/work-search.ts` lands. */
export interface WorkSearchPort {
  search(request: WorkSearchQuery, signal?: AbortSignal): Promise<WorkSearchResponse>;
}

/** Copy of today's `session-screens.ts` `canSubmitComposer` (C3 ports the rest of that file). */
export const canSubmitComposer = (draft: string, disabled: boolean, sending: boolean): boolean =>
  draft.trim().length > 0 && !disabled && !sending;

// ─── words put back from Voice's transcription log (copy of the receiving half of Voice's reinsert-transcription.ts) ─

/** The window event Voice's transcription log announces; a composer that takes the words cancels it. */
export const REINSERT_TRANSCRIPTION_EVENT = 'ferretry:reinsert-transcription';

/** The words a reinsert event carries; undefined for any other event or a detail that is not words. */
export function reinsertTranscriptionText(event: Event): string | undefined {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const text = (detail as { readonly text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}
