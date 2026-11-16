import type { Loosens } from '@ferretry/kernel/contract';
import type { BrowsersConfig } from './wire.ts';

/**
 * `browsers.yaml` loosens when a proxy is newly set, pointed somewhere else, or given other credentials: today's
 * `browserProxyLoosening` (machine.yaml), word for word. The proxy sees every host the browser visits, and its
 * credential references are sent to whatever address is written, so an agent able to write the file could otherwise aim
 * a stored secret at a server of its choosing. Removing a proxy, or editing only its bypass list or the browser mode,
 * hands an agent nothing it did not have. A first file (no before) that names a proxy is a newly set one.
 */
export const browsersLoosens: Loosens<BrowsersConfig> = (before, after) => {
  const proxy = after.proxy;
  if (proxy === undefined) return [];
  const was = before?.proxy;
  const same =
    was !== undefined && was.url === proxy.url && was.username === proxy.username && was.password === proxy.password;
  return same ? [] : [`the agent browser now sends its traffic through the proxy at ${proxy.url}`];
};
