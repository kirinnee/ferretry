/**
 * The browser's half of the Hypermedia switch (docs/hypermedia.md): one read of whether a ferret is told to use
 * hypermedia, and one write, through the half's own client, so a daemon only the relay reaches is reached and nothing
 * here carries a credential.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { type HypermediaResult, HypermediaResultSchema, HypermediaStateSchema } from '../../contract/index.ts';

export type HypermediaPatchResult = HypermediaResult;

/**
 * Whether one ferret is told to use hypermedia now: Conversation's own `GET /v1/ferrets/:ferretId/hypermedia`, which says
 * the switch the owner set, else the default for the ferret's mode. (Ferrets' summary carries neither.)
 */
export const readFerretHypermedia = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<boolean> =>
  HypermediaStateSchema.parse(await client.call('GET /v1/ferrets/:ferretId/hypermedia', { params: { ferretId } }))
    .enabled;

/** Switches whether one ferret is told to use hypermedia; it takes effect at that ferret's next launch. */
export const patchFerretHypermedia = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  enabled: boolean,
): Promise<HypermediaPatchResult> =>
  HypermediaResultSchema.parse(
    await client.call('PATCH /v1/ferrets/:ferretId/hypermedia', {
      params: { ferretId },
      body: { enabled },
      headers: { 'x-fy-request-id': crypto.randomUUID() },
    }),
  );
