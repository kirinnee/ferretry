/**
 * The Browser tab's two daemon calls (docs/browser-proxy.md): the browser's state, and "Test proxy".
 *
 * A proxy setting holds `${secret:NAME}` references and never a value, so neither call can carry a
 * credential; the daemon resolves the names from its own secret store while it tests.
 */

import {
  BROWSER_PROXY_TEST_PATH,
  BROWSER_STATE_PATH,
  type BrowserProxySetting,
  BrowserProxyTestRequestSchema,
  type BrowserProxyTestResult,
  BrowserProxyTestResultSchema,
  type BrowserStateView,
  BrowserStateViewSchema,
} from '@ferretry/protocol';
import type { FleetClient } from '../fleet-client.ts';

/** Whether the machine's shared browser runs, and which proxy it started with. */
export async function readBrowserState(client: FleetClient): Promise<BrowserStateView> {
  return await client.request(BROWSER_STATE_PATH, BrowserStateViewSchema);
}

/**
 * Try a proxy. Omit `proxy` to test the SAVED one; pass it to test what is being edited and not saved yet.
 * Nothing is saved either way.
 */
export async function testBrowserProxy(
  client: FleetClient,
  proxy?: BrowserProxySetting,
): Promise<BrowserProxyTestResult> {
  return await client.request(BROWSER_PROXY_TEST_PATH, BrowserProxyTestResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(BrowserProxyTestRequestSchema.parse(proxy === undefined ? {} : { proxy })),
  });
}
