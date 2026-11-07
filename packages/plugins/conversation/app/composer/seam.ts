/**
 * THE COMPOSER'S SEAM: every name the composer files took from a shared PWA module that is NOT Conversation's and
 * has no `@ferretry/app` export, kept in ONE file so its owner can replace each in one place. Nothing here is new
 * behaviour: each is a re-export, a short marked copy of today's code, or a typed stand-in that behaves as today's
 * code does when the thing it stands for is absent.
 *
 *   - DaemonId / DaemonConnection / daemonConnection ...... identity only: the half's client is already one daemon
 *     (`useConversationDaemon()`), so a connection is the id the shell recorded for that client.
 *   - DaemonFerretScope / daemonFerretScope / daemonFerretKey .. today's `lib/daemon-scope.ts`, renamed to the words.
 *   - ConversationCaller / callRefusal ...................... the plugin client's `call` (§9.6), replacing today's
 *     `DaemonFetch` / `browserFetch` / `daemonRequest`; a refusal is `DaemonCallError` (status, code, sentence).
 *   - carrierDelivery ....................................... GAP(app-shell): today's `relay-carrier.ts` walk; the 5.0
 *     client does not classify an outage yet, so this reads a `delivery` mark off the error chain and finds none.
 *   - devicePreference ...................................... copy of today's `lib/device-preference.ts` (Access's
 *     placement): a reader preference on this device; the key is a `localKey('conversation', …)` name.
 *   - foregroundPinScope .................................... GAP(ferrets): the pinned pane in front (Ferrets' pin
 *     bridge). Nothing is pinned until Ferrets' app half sets it.
 *   - withReferences / referencesOf / withReferencePrefix ... copies of Agenda's "re:" chip helpers (today's
 *     `agenda-reply.ts`, `answer-chip.ts`): the composer stores the chips beside an unsent message.
 *   - FerretContext ......................................... GAP(C3, Q0): today's `SessionContext`, until the Ferrets
 *     contract exports the ferret view schemas.
 *   - WorkSearchPort ........................................ GAP(C4): the work-search port's shape, until C4's
 *     `app/search/work-search.ts` lands; the composer's pickers read it.
 *   - canSubmitComposer ..................................... copy of today's `session-screens.ts` one-liner (C3's split).
 */

import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useSyncExternalStore } from 'react';
import type { WorkSearchQuery, WorkSearchResponse } from '../../contract/index.ts';

// ─── the daemon this half talks to ────────────────────────────────────────────────────────────────────────────────

export type DaemonId = string & { readonly daemonId: unique symbol };

/** Which daemon a value belongs to. The shell's per-daemon client already is one daemon: this is an identity only. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
}

export const daemonConnection = (daemonId: string): DaemonConnection => ({ daemonId: daemonId as DaemonId });

/** The required `(daemonId, ferretId)` identity for composer state; `item` names an Agenda item's own draft slot. */
export interface DaemonFerretScope {
  readonly daemonId: DaemonId;
  readonly ferretId: string;
  /** The DRAFT SLOT inside the ferret: the agenda item whose own composer this is. Absent is the ferret's chat. */
  readonly item?: string;
}

const requireFerretId = (value: string): string => {
  if (value.trim() === '') throw new Error('ferretId must not be empty');
  return value;
};

export const daemonFerretScope = (
  daemon: Pick<DaemonConnection, 'daemonId'>,
  ferretId: string,
  item?: string,
): DaemonFerretScope => ({
  daemonId: daemon.daemonId,
  ferretId: requireFerretId(ferretId),
  ...(item === undefined ? {} : { item }),
});

/** A collision-safe key for persisted or in-memory ferret state; an item slot adds a third part. */
export const daemonFerretKey = (scope: DaemonFerretScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.ferretId] : [scope.daemonId, scope.ferretId, scope.item],
  );

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

// ─── a reader preference kept on this device (copy of today's lib/device-preference.ts) ───────────────────────────

export interface DevicePreference<T extends string> {
  readonly key: string;
  readonly fallback: T;
  readonly parse: (raw: string | null) => T;
  readonly read: () => T;
  readonly write: (value: T) => void;
  /** The live value, with the default for static rendering. */
  readonly use: () => T;
}

/** Browser privacy settings may make even accessing localStorage throw. */
const browserStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

/** A preference stored under `key`, one of `values`, `fallback` whenever it is anything else. */
export const devicePreference = <T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
): DevicePreference<T> => {
  /** Same-tab change signal; the browser storage event only reaches other tabs. */
  const changeEvent = `ferretry:preference-change:${key}`;
  /** Falls back to this value when storage is unavailable or refuses a write. */
  let volatile: T | null = null;
  const parse = (raw: string | null): T => (values.find(value => value === raw) ?? fallback) as T;
  const read = (): T => {
    if (volatile !== null) return volatile;
    const storage = browserStorage();
    if (storage === null) return fallback;
    try {
      return parse(storage.getItem(key));
    } catch {
      return fallback;
    }
  };
  const write = (value: T): void => {
    volatile = value;
    const storage = browserStorage();
    if (storage !== null) {
      try {
        storage.setItem(key, value);
      } catch {
        // The in-page setting stays effective even if it cannot survive reload.
      }
    }
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(changeEvent));
    } catch {
      // An event shim must not make the setting itself fail.
    }
  };
  const subscribe = (onChange: () => void): (() => void) => {
    const target = typeof window === 'undefined' ? undefined : window;
    if (target === undefined) return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      volatile = null;
      onChange();
    };
    target.addEventListener(changeEvent, onChange);
    target.addEventListener('storage', onStorage);
    return () => {
      target.removeEventListener(changeEvent, onChange);
      target.removeEventListener('storage', onStorage);
    };
  };
  const use = (): T => useSyncExternalStore(subscribe, read, () => fallback);
  return { key, fallback, parse, read, write, use };
};

// ─── the pinned pane in front (GAP(ferrets)) ──────────────────────────────────────────────────────────────────────

let foreground: DaemonFerretScope | null = null;

/** Declares the complete identity of the pane currently in front of the reader (Ferrets' pinned panes). */
export const setForegroundPinScope = (scope: DaemonFerretScope | null): void => {
  if (foreground !== null && scope !== null && daemonFerretKey(foreground) === daemonFerretKey(scope)) return;
  foreground = scope;
};

/** Clears a departing pane only when it is still the foreground pane. */
export const clearForegroundPinScope = (scope: DaemonFerretScope): void => {
  if (foreground !== null && daemonFerretKey(foreground) === daemonFerretKey(scope)) setForegroundPinScope(null);
};

export const getForegroundPinScope = (): DaemonFerretScope | null => foreground;

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

/** GAP(C3, Q0): today's `SessionContext` — how much of the context window the ferret has used. */
export interface FerretContext {
  /** Tokens the newest model call carried: input plus cache reads and writes. */
  readonly usedTokens: number;
  /** The model's context window in tokens. */
  readonly windowTokens: number;
  /** `usedTokens` over `windowTokens`, one decimal, never above 100. */
  readonly percent: number;
  /** When the usage record was written. */
  readonly at: string;
}

/** GAP(C4): the work search port, until `app/search/work-search.ts` lands. */
export interface WorkSearchPort {
  search(request: WorkSearchQuery, signal?: AbortSignal): Promise<WorkSearchResponse>;
}

/** Copy of today's `session-screens.ts` `canSubmitComposer` (C3 ports the rest of that file). */
export const canSubmitComposer = (draft: string, disabled: boolean, sending: boolean): boolean =>
  draft.trim().length > 0 && !disabled && !sending;
