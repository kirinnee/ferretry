/**
 * What crosses between a worker thread and the main thread for a worker's granted roots and network: ONE dedicated
 * `MessageChannel` the kernel makes at start (its far end goes in `workerData`, never the plugin's own handle).
 * It is a grant channel, not a sandbox: the worker is an in-process thread (see `../../worker.ts`). Shapes only, no dependencies, so the worker bundle carries nothing it does not need. The main thread validates
 * every request (`serve.ts`); the worker side (`../../worker.ts`) only builds them.
 */

/** The key the kernel puts the grant channel under in the worker's `workerData`. */
export const WORKER_GRANTS_KEY = 'ferretryGrants';

/** What a worker holds of its grants: the channel and the NAMES it was granted (never a path, never a scope). */
export interface WorkerGrantsData {
  readonly port: MessagePort;
  readonly roots: readonly string[];
  readonly network: boolean;
}

/** The most one fetched body, one in-flight request set and one request body may be. */
export const MAX_GRANT_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_GRANT_IN_FLIGHT = 32;
/** More refused requests than this in one window end the channel: a worker that floods it is not asking for anything. */
export const MAX_GRANT_REFUSALS_PER_WINDOW = 1000;
export const GRANT_REFUSAL_WINDOW_MS = 1000;

export interface WorkerFetchInit {
  readonly method?: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string | Uint8Array;
}

export type WorkerGrantRequest =
  | {
      readonly id: number;
      readonly kind: 'root';
      readonly root: string;
      readonly op: string;
      readonly args: readonly unknown[];
    }
  | { readonly id: number; readonly kind: 'fetch'; readonly url: string; readonly init?: WorkerFetchInit }
  | { readonly kind: 'cancel'; readonly id: number };

export interface WorkerFetchAnswer {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

/** A refusal is a fixed word and a fixed sentence the kernel wrote: never what a lower layer threw. */
export type WorkerGrantResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly refusal: string; readonly message: string };
