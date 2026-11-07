/**
 * THE VOICE APP HALF'S SHELL SEAM.
 *
 * Every name below is something today's PWA voice files imported from a shared PWA module (the app store, the shell
 * primitives, the daemon client and transport) that has no home for a plugin to import from in 5.0 yet, or whose home
 * (`@ferretry/app`, `@ferretry/app/ui`, on `rebuild/app-shell-fill`) is not on this branch's base. Each is a re-export of
 * the shell's own, a short clearly-marked copy, or a typed stand-in, kept here — in one file — so the shell can replace
 * them in one place when it lands. Nothing here is new behaviour: a copy is today's code, and a stand-in behaves as
 * today's code does OUTSIDE the app store (no client, no prompt).
 *
 * Where each lives today, and where it comes from:
 *   - cn, Button, Textarea, Badge, BottomSheet, useDocumentVisible, isKeyboardCaptured,
 *     trustedWorkerUrl, isSpeechWorkerScriptUrl, createTrustedTypes, isWorkerScriptUrl
 *         ........ pwa shell primitives / hooks / trusted types ...... `@ferretry/app/ui` (app-shell-fill)
 *   - findReferences, parseReferenceToken, Reference
 *         ........ pwa/src/lib/references.ts ........................ `@ferretry/app` (the reference grammar)
 *   - speechModelCache ......... §9.4 `fy:voice:<model>` .............. `@ferretry/app` (storage names)
 *   - DaemonConnection / DaemonId / daemonConnection ........ stand-in: a daemon is whichever one the shell's per-daemon
 *     client is for, so the connection is only an identity here
 *   - VoicePluginClient, useVoiceClient, pluginFetch ........ the plugin's own `PluginClient` (§9.6), put in a context by
 *     `app/index.ts`; replaces today's `useDaemonClient()` / `useDaemonFetch()` / `daemonRequest`
 *   - parseFyRender (header only), FY_RENDER_FENCE_LANGUAGE .. Conversation's renders; only the block type and alt are read
 *   - putSecret, readConfigFile, writeConfigFile, changeRefusalSentence ... stand-ins over the plugin client
 *   - browserFetch / DaemonFetch, browserClipboardWriter, clockOfInstant ... short copies
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createContext, createElement, type ReactNode, useContext } from 'react';
import { z } from 'zod';

export {
  Badge,
  BottomSheet,
  Button,
  cn,
  createTrustedTypes,
  isKeyboardCaptured,
  isSpeechWorkerScriptUrl,
  isWorkerScriptUrl,
  Textarea,
  trustedWorkerUrl,
  useDocumentVisible,
} from '@ferretry/app/ui';
export { findReferences, parseReferenceToken, type Reference, speechModelCache } from '@ferretry/app';

// ─── the daemon this half talks to ────────────────────────────────────────────────────────────────────────────────

export type DaemonId = string & { readonly daemonId: unique symbol };

/** Which daemon a request is for. The shell's per-daemon client already is one daemon, so this is an identity only. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly daemonName?: string;
}

export const daemonConnection = (input: {
  readonly daemonId: string;
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly daemonName?: string | undefined;
}): DaemonConnection => ({
  daemonId: input.daemonId as DaemonId,
  baseUrl: input.baseUrl,
  deviceId: input.deviceId,
  ...(input.daemonName === undefined ? {} : { daemonName: input.daemonName }),
});

// ─── the plugin client ────────────────────────────────────────────────────────────────────────────────────────────

/** The only client capability this half uses. */
export type VoicePluginClient = Pick<PluginClient, 'call'>;

/** The refusal the shell's generated client throws (`DaemonCallError` in `@ferretry/app`): a status, a code, a sentence. */
interface CallRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}
const isCallRefusal = (error: unknown): error is CallRefusal =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as CallRefusal).status === 'number' &&
  typeof (error as CallRefusal).code === 'string';

const VoiceClientContext = createContext<VoicePluginClient | null>(null);

/** `app/index.ts` wraps every surface of this half in this, with the plugin client the shell built for the daemon. */
export function VoiceClientProvider({
  client,
  children,
}: {
  readonly client: VoicePluginClient;
  readonly children?: ReactNode;
}) {
  return createElement(VoiceClientContext.Provider, { value: client }, children);
}

/** The plugin client, or `null` outside a provider (a component rendered on its own by a suite). */
export function useOptionalVoiceClient(): VoicePluginClient | null {
  return useContext(VoiceClientContext);
}

/** The route key (`METHOD /path` with `:params`) for a concrete request, among the keys this half may call. */
const ROUTES: readonly {
  readonly method: string;
  readonly template: string;
  readonly matcher: RegExp;
  readonly names: readonly string[];
}[] = [
  ['POST', '/v1/stt/enhance'],
  ['GET', '/v1/speedups'],
  ['POST', '/v1/speedups/:provider/test'],
  ['POST', '/v1/secrets'],
  ['GET', '/v1/secrets'],
  ['DELETE', '/v1/secrets/:name'],
  ['GET', '/v1/config/file'],
  ['PUT', '/v1/config/file'],
].map(([method, template]) => {
  const names: string[] = [];
  const source = (template as string).replace(/:([A-Za-z]+)/gu, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method: method as string, template: template as string, matcher: new RegExp(`^${source}$`, 'u'), names };
});

/** Calls the route a concrete `method path` names, through the plugin client, and answers the parsed JSON. */
export async function callPath(
  client: VoicePluginClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const [pathname = path, search = ''] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.matcher.exec(pathname);
    if (match === null) continue;
    const params = Object.fromEntries(
      route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]),
    );
    return await client.call(`${route.method} ${route.template}`, {
      ...(route.names.length === 0 ? {} : { params }),
      ...(Object.keys(query).length === 0 ? {} : { query }),
      ...(body === undefined ? {} : { body }),
    });
  }
  throw new Error(`no route of this plugin answers ${method} ${path}`);
}

/**
 * A `fetch` that speaks through the plugin client: the request's route is called, its JSON answer comes back as a 200
 * `Response`, a refusal as a `Response` with the refusal's status and `{error, code}` body. So code written against a
 * `Response` (the remote enhancement) keeps its taxonomy, while no byte reaches a daemon any way but the shell's client.
 */
export function pluginFetch(client: VoicePluginClient): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (init.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    const answered = callPath(client, method, input, body);
    const aborted = new Promise<never>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    try {
      const value = await Promise.race([answered, aborted]);
      return new Response(JSON.stringify(value ?? null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      if (isCallRefusal(error))
        return new Response(JSON.stringify({ error: error.message, code: error.code }), {
          status: error.status === 0 ? 503 : error.status,
          headers: { 'content-type': 'application/json' },
        });
      throw error;
    }
  };
}

/**
 * The slice of today's `IFyApiClient` this half uses: `request(path, schema, init)`, parsing the answer with the
 * schema. Over the plugin client; a refusal throws {@link FyHttpError}.
 */
export class FyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FyHttpError';
  }
}

/** One event of a session's history, as far as a clean-up reads it: a type and its data. */
export interface FyEvent {
  readonly type: string;
  readonly data?: unknown;
}

/** The shortest value Vault will keep as a secret (Vault's own limit; a shorter one is refused). */
export const MIN_SECRET_VALUE_LENGTH = 8;

export interface IFyApiClient {
  /** Conversation's history read: a session's newest events (stand-in; the plugin client carries it). */
  history(sessionId: string, after?: number, limit?: number): Promise<readonly FyEvent[]>;
  request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string },
    timeoutMs?: number,
  ): Promise<T>;
}

/** The answer, or a refusal when it takes longer than `ms`. */
const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The daemon did not answer in time.')), ms);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export function apiClientOver(client: VoicePluginClient): IFyApiClient {
  return {
    // GAP: a session's history is Conversation's read, and no package this one declares exposes it yet, so the fallback
    // context read finds nothing. The page-held transcript (`readConversation`) is the context source that works.
    history: async () => [],
    request: async (path, schema, init, timeoutMs) => {
      try {
        const parsed = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
        const etag = Object.entries(init?.headers ?? {}).find(
          ([name]) => name.toLowerCase() === CONFIG_IF_MATCH_HEADER,
        )?.[1];
        const body = etag === undefined ? parsed : { ...(parsed as object), etag };
        const call = callPath(client, (init?.method ?? 'GET').toUpperCase(), path, body);
        return schema.parse(await (timeoutMs === undefined ? call : within(call, timeoutMs)));
      } catch (error) {
        if (isCallRefusal(error)) throw new FyHttpError(error.status, error.code, error.message);
        throw error;
      }
    },
  };
}

// ─── copies ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * THE ONLY WAY THIS PACKAGE IS ALLOWED TO SPELL "the real network" (copy of `runtime-models.ts`): `fetch` is a WebIDL
 * operation on the global, and a bare builtin stored and called as a member is rejected, so it is wrapped.
 */
export const browserFetch: DaemonFetch = (input, init) => globalThis.fetch(input, init);

export type ClipboardWriter = (text: string) => Promise<void>;

/** The real clipboard, which rejects rather than pretending on a browser that has none (copy of `copy-button.tsx`). */
export const browserClipboardWriter =
  (): ClipboardWriter =>
  async (text: string): Promise<void> => {
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (value: string) => Promise<void> } })
      ?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      throw new Error('this browser will not give the page clipboard access');
    }
    await clipboard.writeText(text);
  };

export { clockOfInstant, type ClockEnvironment, type MessageClock } from './lib/message-clock.ts';

// ─── what Conversation and the shell own ──────────────────────────────────────────────────────────────────────────

export const FY_RENDER_FENCE_LANGUAGE = 'fy-render';

const FY_RENDER_TYPES = [
  'mermaid',
  'svg',
  'html',
  'chart',
  'map',
  'image',
  'video',
  'audio',
  'pdf',
  'lottie',
  'card',
] as const;

/**
 * STAND-IN for Conversation's `parseFyRender`: reads only what a spoken description needs — the block's `type` and `alt`
 * headers above the exact `---` boundary — and refuses what has none. Speech never renders the payload.
 */
export function parseFyRender(
  source: string,
): { readonly ok: true; readonly block: { readonly type: string; readonly alt: string } } | { readonly ok: false } {
  const lines = source.split('\n');
  const boundary = lines.indexOf('---');
  if (boundary === -1) return { ok: false };
  const headers = new Map<string, string>();
  for (const line of lines.slice(0, boundary)) {
    const split = line.indexOf(':');
    if (split <= 0) return { ok: false };
    headers.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  const type = headers.get('type');
  const alt = headers.get('alt');
  if (type === undefined || alt === undefined || alt === '') return { ok: false };
  if (!(FY_RENDER_TYPES as readonly string[]).includes(type)) return { ok: false };
  return { ok: true, block: { type, alt } };
}

/**
 * STAND-IN for the Release keeper's cache-name prefix: the release caches the keeper prunes begin with this, so a
 * speech-model cache (`fy:voice:<model>`, §9.4) must not.
 */
export const RELEASE_CACHE_PREFIX = 'fy-release:';

/** The words of a message a person could have spoken: a pasted block is unwrapped; Ferretry's own plumbing is not words. */
export function readUserMessage(
  raw: string,
):
  | { readonly kind: 'human'; readonly text: string }
  | { readonly kind: 'peer'; readonly body: string }
  | { readonly kind: 'combined'; readonly parts: readonly { readonly body: string }[] }
  | { readonly kind: 'notice' | 'handoff'; readonly text: string } {
  const text = raw.replace(
    /<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/gu,
    (_block, inner: string) => inner,
  );
  const notice = parseFerretryNotice(text);
  if (notice !== null) return { kind: 'notice', text: notice };
  if (parseHandoffPointer(text) !== null) return { kind: 'handoff', text };
  const peer = parsePeerEnvelope(text.trimStart());
  return peer === null ? { kind: 'human', text } : { kind: 'peer', body: peer.body };
}
import { parseFerretryNotice, parseHandoffPointer, parsePeerEnvelope } from '../contract/cleanup/plumbing.ts';

// ─── config files and secrets (the shell's config door and Vault's secret route) ───────────────────────────────

/** The header a configuration write names the digest it was edited from in (the plugin client carries it as `etag`). */
export const CONFIG_IF_MATCH_HEADER = 'if-match';

const ConfigFileReadSchema = z.looseObject({ text: z.string(), etag: z.string() });
const ConfigFileWriteSchema = z.looseObject({
  outcome: z.enum(['applied', 'pending']),
  pending: z.looseObject({ changes: z.array(z.string()) }).optional(),
});
export type ConfigFileRead = z.infer<typeof ConfigFileReadSchema>;
export type ConfigFileWrite = z.infer<typeof ConfigFileWriteSchema>;

/**
 * The configuration-file routes (`GET /v1/config/file?path=`, `PUT /v1/config/file`): `voice.yaml` is read and written as TEXT
 * so the owner's comments survive, against the etag just read. The routes belong to the configuration door, not this plugin.
 */
export async function readConfigFile(client: Pick<IFyApiClient, 'request'>, file: string): Promise<ConfigFileRead> {
  return await client.request(`/v1/config/file?path=${encodeURIComponent(file)}`, ConfigFileReadSchema);
}
export async function writeConfigFile(
  client: Pick<IFyApiClient, 'request'>,
  file: string,
  text: string,
  etag: string,
): Promise<ConfigFileWrite> {
  return await client.request('/v1/config/file', ConfigFileWriteSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', [CONFIG_IF_MATCH_HEADER]: etag },
    body: JSON.stringify({ path: file, text }),
  });
}

/** The sentence a refused configuration change reads as (stand-in for `apply-change.ts`). */
export function changeRefusalSentence(cause: unknown): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : 'The change was refused.';
}

/** `POST /v1/secrets {name, value}` (Vault's route): the value goes in and never comes back. */
export async function putSecret(client: Pick<IFyApiClient, 'request'>, name: string, value: string): Promise<unknown> {
  return await client.request(
    '/v1/secrets',
    { parse: answer => answer },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, value }),
    },
  );
}

/** STAND-IN for `daemonRequest`: the plugin client addresses the daemon, so a request is only its path and options. */
export const daemonRequest = (
  _daemon: DaemonConnection,
  path: string,
  init: RequestInit = {},
): { readonly url: string; readonly init: RequestInit } => {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('daemon path must be an origin-relative path');
  return { url: path, init };
};

/** STAND-IN for the "this machine is older than the app" check, which reads the fleet; absent, nothing is claimed. */
export const useMachineIsOlder = (_store: unknown, _daemon: DaemonConnection | undefined): boolean => false;
