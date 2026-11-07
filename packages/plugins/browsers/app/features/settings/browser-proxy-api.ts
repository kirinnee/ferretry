/**
 * The Browser tab's two daemon calls (docs/browser-proxy.md): the browser's state, and "Test proxy".
 *
 * A proxy setting holds `${secret:NAME}` references and never a value, so neither call can carry a
 * credential; the daemon resolves the names from its own secret store while it tests.
 */

import {
  type BrowserProxySetting,
  BrowserProxyTestRequestSchema,
  type BrowserProxyTestResult,
  BrowserProxyTestResultSchema,
  type BrowserStateView,
  BrowserStateViewSchema,
} from '../../../contract/index.ts';
import type { CallClient } from '../../lib/clients.ts';

export const BROWSER_STATE_ROUTE = 'GET /v1/browser/state';
export const BROWSER_PROXY_TEST_ROUTE = 'POST /v1/browser/proxy/test';

/** Whether the machine's shared browser runs, and which proxy it started with. */
export async function readBrowserState(client: CallClient): Promise<BrowserStateView> {
  return BrowserStateViewSchema.parse(await client.call(BROWSER_STATE_ROUTE));
}

/**
 * Try a proxy. Omit `proxy` to test the SAVED one; pass it to test what is being edited and not saved yet.
 * Nothing is saved either way.
 */
export async function testBrowserProxy(
  client: CallClient,
  proxy?: BrowserProxySetting,
): Promise<BrowserProxyTestResult> {
  return BrowserProxyTestResultSchema.parse(
    await client.call(BROWSER_PROXY_TEST_ROUTE, {
      body: BrowserProxyTestRequestSchema.parse(proxy === undefined ? {} : { proxy }),
    }),
  );
}
