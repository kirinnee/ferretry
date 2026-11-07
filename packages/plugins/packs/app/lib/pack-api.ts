/**
 * The browser's half of one ferret's Pack switch (docs/pack-mode.md): one write, through the per-daemon client, so a
 * daemon only the relay reaches is reached and nothing here carries a credential. Mirrors the Hypermedia switch.
 */

import { type FerretPackPatchResult, FerretPackPatchResultSchema } from '../../contract/index.ts';
import type { PacksClient } from './client.ts';

/** Switches whether one ferret may delegate to helpers; it takes effect at that ferret's next launch. */
export const patchFerretPack = async (
  client: PacksClient,
  ferretId: string,
  enabled: boolean,
): Promise<FerretPackPatchResult> =>
  FerretPackPatchResultSchema.parse(
    await client.call('PATCH /v1/ferrets/:ferretId/pack', { params: { ferretId }, body: { enabled } }),
  );
