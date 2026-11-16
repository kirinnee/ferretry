/**
 * The browser's half of "Compact memory at" (docs/compact-at.md): read and set where one ferret squeezes its
 * conversation, through the half's own client, so a daemon only the relay reaches is reached and nothing here carries
 * a credential.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type CompactAt,
  type CompactAtPatchResult,
  CompactAtPatchResultSchema,
  type FerretCompactAt,
  FerretCompactAtSchema,
} from '../../contract/index.ts';

/** The value a launch would use now, and the model's window it is checked against. */
export const getFerretCompactAt = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
): Promise<FerretCompactAt> =>
  FerretCompactAtSchema.parse(await client.call('GET /v1/ferrets/:ferretId/compact-at', { params: { ferretId } }));

/** Sets it (`inherit` drops the ferret's own value); a running ferret takes it at its next launch. */
export const patchFerretCompactAt = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  compactAt: CompactAt | 'inherit',
): Promise<CompactAtPatchResult> =>
  CompactAtPatchResultSchema.parse(
    await client.call('PATCH /v1/ferrets/:ferretId/compact-at', {
      params: { ferretId },
      body: { compactAt },
      headers: { 'x-fy-request-id': crypto.randomUUID() },
    }),
  );
