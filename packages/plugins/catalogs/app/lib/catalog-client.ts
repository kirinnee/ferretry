/**
 * THE BROWSER'S CLIENT FOR ONE MACHINE'S CATALOG ROUTES. Today's surfaces call `request(path, schema, init)`; here the
 * same call is sent through the half's own {@link PluginClient} by the ROUTE KEY Catalogs' manifest declares for that
 * method and path. A path no declared route matches is refused before anything is sent, so this half can never reach a
 * route the manifest does not list (and never another plugin's).
 */

import type { NoReach } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { z } from 'zod';
import manifest from '../../manifest.ts';

/** The only client capability the catalog surfaces use. */
export interface CatalogClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: CatalogRequestInit): Promise<T>;
}

type CatalogRequestInit = Pick<RequestInit, 'method' | 'headers' | 'body'>;

/** The one read beyond Catalogs' own routes: the NAMES of this machine's secrets, governed by the Vault route's own grant (operator, secrets.use), not by `secretNamePicker`. */
export const SECRET_NAMES_PATH = '/v1/secrets';
const SECRET_NAMES_ROUTE = 'GET /v1/secrets';

interface Pattern {
  readonly key: string;
  readonly method: string;
  readonly parts: readonly string[];
}

const PATTERNS: readonly Pattern[] = manifest.actions.routes.map(declared => {
  const space = declared.key.indexOf(' ');
  return {
    key: declared.key,
    method: declared.key.slice(0, space),
    parts: declared.key
      .slice(space + 1)
      .split('/')
      .filter(part => part !== ''),
  };
});

const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** The declared route (most literal segments first) a method and path address, with its `:placeholders` filled. */
export function routeFor(
  method: string,
  pathname: string,
): { readonly key: string; readonly params: Readonly<Record<string, string>> } | undefined {
  const actual = pathname.split('/').filter(part => part !== '');
  let best: { key: string; params: Record<string, string>; literals: number } | undefined;
  for (const pattern of PATTERNS) {
    if (pattern.method !== method || pattern.parts.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    const matched = pattern.parts.every((part, index) => {
      const value = actual[index] as string;
      if (part.startsWith(':')) {
        params[part.slice(1)] = decoded(value);
        return true;
      }
      if (part !== value) return false;
      literals += 1;
      return true;
    });
    if (matched && (best === undefined || literals > best.literals)) best = { key: pattern.key, params, literals };
  }
  return best === undefined ? undefined : { key: best.key, params: best.params };
}

/** A client over this half's {@link PluginClient}. A body is the JSON the call sent; the answer is parsed by `schema`. */
export function catalogClientOf(client: Pick<PluginClient, 'call'>): CatalogClient {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init: CatalogRequestInit = {}): Promise<T> {
      const url = new URL(path, 'http://catalogs.invalid');
      // The route-key call carries no headers and only a JSON string body: refuse what it cannot carry, never drop it.
      for (const [name] of new Headers(init.headers)) {
        if (name !== 'content-type') throw new Error(`The Catalogs client cannot carry the request header ${name}`);
      }
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string')
        throw new Error('The Catalogs client carries only a JSON string body');
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.pathname === SECRET_NAMES_PATH)
        return schema.parse(await client.call(SECRET_NAMES_ROUTE));
      const route = routeFor(method, url.pathname);
      if (route === undefined) throw new Error(`Catalogs declares no route for ${method} ${url.pathname}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const answer = await client.call(route.key, {
        ...(Object.keys(route.params).length === 0 ? {} : { params: route.params }),
        ...(Object.keys(query).length === 0 ? {} : { query }),
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      return schema.parse(answer);
    },
  };
}

/** What an install on a machine with no Catalogs row says: not connected yet, or Catalogs is off there. */
export const NO_MACHINE_SENTENCE = 'This device cannot reach Catalogs on that machine yet.';

/**
 * The catalog client of any paired machine: this half's own for the daemon it was built for, Catalogs' own row client
 * (`useEveryDaemon`) on another, and a refusal saying so where there is none.
 */
export const machineCatalogClient =
  (
    own: CatalogClient,
    ownId: string,
    others: ReadonlyMap<string, PluginClient> | RowSource,
  ): ((connection: { readonly daemonId: string }) => Promise<CatalogClient>) =>
  async connection => {
    if (connection.daemonId === ownId) return own;
    const source: RowSource = 'clients' in others ? others : { clients: () => others };
    const deadline = Date.now() + (source.waitMs ?? ROW_WAIT_MS);
    for (;;) {
      const row = source.clients().get(connection.daemonId);
      if (row !== undefined) return catalogClientOf(row);
      const why = source.whyNone?.(connection.daemonId);
      if (why !== undefined && !why.waiting) throw new Error(why.line);
      // The shell allowing the plugin before the row map has caught up (`why === undefined`) is one more loop, not an end.
      if (source.whyNone === undefined || Date.now() >= deadline) throw new Error(why?.line ?? NO_MACHINE_SENTENCE);
      await new Promise(resolve => setTimeout(resolve, ROW_POLL_MS));
    }
  };

/** How long an install on another machine waits for its row (connecting, or its plugin list being read). */
const ROW_WAIT_MS = 15_000;
const ROW_POLL_MS = 100;

/** The live row clients (a getter, so a wait sees a row that arrives), and the shell's reason a machine has none. */
export interface RowSource {
  readonly clients: () => ReadonlyMap<string, PluginClient>;
  readonly whyNone?: (daemon: string) => NoReach | undefined;
  readonly waitMs?: number;
}
