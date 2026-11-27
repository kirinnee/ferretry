/**
 * The identities a machine's browser knows, and stopping one (`GET /v1/browser/identities`,
 * `POST /v1/browser/identities/:identity/stop`). Adding one is NOT here: it is an edit of `browsers.yaml` through the
 * config proposal path (`browsers-config.ts`), so a proxy that loosens still waits for the owner.
 */

import {
  type BrowserIdentitiesView,
  BrowserIdentitiesViewSchema,
  type BrowserIdentityRow,
  BrowserIdentityRowSchema,
} from '../../contract/index.ts';
import type { CallClient } from './clients.ts';

/** The daemon's real identities, running or not. Nothing is added to the answer here. */
export async function readBrowserIdentities(client: CallClient): Promise<BrowserIdentitiesView> {
  return BrowserIdentitiesViewSchema.parse(await client.call('GET /v1/browser/identities'));
}

/** Closes ONE identity's Chrome and pages; the others stay live and its profile folder (every sign-in on it) stays. */
export async function stopBrowserIdentity(client: CallClient, identity: string): Promise<BrowserIdentityRow> {
  return BrowserIdentityRowSchema.parse(
    await client.call('POST /v1/browser/identities/:identity/stop', { params: { identity } }),
  );
}
