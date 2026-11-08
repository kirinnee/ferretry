import { daemonOfClient } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { z } from 'zod';
import { type DaemonConnection, type IFyApiClient } from '../shell-grants.ts';
import { daemonId } from '../shell-pairing.ts';

/** The route keys this adapter carries: the grants read, the grants change, and the audit read. */
const GATE_ROUTES: ReadonlySet<string> = new Set(['GET /v1/grants', 'PATCH /v1/grants', 'GET /v1/audit']);

/**
 * GATE'S ROUTES, REACHED THROUGH THIS HALF'S OWN CLIENT (§9.6, ruling #26).
 *
 * The daemon-wide grants (`/v1/grants`) and the audit log (`/v1/audit`) are Gate's: Access's settings screens edit
 * them "through Gate's config route" (redesign.md §2.3), so the file is Gate's whatever plugin is on. A screen here
 * asks for a path and a schema; this turns the path into the route KEY the kernel client sends (it refuses a key no
 * compiled manifest declares, and sends the carrier's own session, so a widen from a remote device is refused by
 * Gate and the refusal's sentence is the error's message, shown whole).
 *
 * Only Gate's three routes cross here; any other key is a programming error and throws before a request is made.
 *
 * The step-up/passkey prompt is NOT here: the client asks for it by itself when Gate refuses, through Access's own
 * `step-up-shell.tsx`.
 */
export function gateRouteClient(client: PluginClient): IFyApiClient {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
      const [pathname = '', search = ''] = path.split('?');
      const route = `${init?.method ?? 'GET'} ${pathname}`;
      if (!GATE_ROUTES.has(route)) throw new TypeError(`${route} is not one of Gate's grants or audit routes`);
      if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string')
        throw new TypeError(`${route} carries a body that is not a JSON string`);
      const query = Object.fromEntries(new URLSearchParams(search));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const answer = await client.call(route, {
        ...(Object.keys(query).length === 0 ? {} : { query }),
        ...(body === undefined ? {} : { body }),
      });
      return schema.parse(answer);
    },
  };
}

/**
 * The machine a client was built for, as the screens' `DaemonConnection`. The shell hands a half a machine's identity,
 * not its address or this device's token, so those fields are empty: these screens read only the id.
 */
export function connectionOfClient(client: PluginClient): DaemonConnection | undefined {
  const id = daemonOfClient(client);
  return id === undefined ? undefined : { daemonId: daemonId(id), baseUrl: '', deviceId: '', carriers: [] };
}
