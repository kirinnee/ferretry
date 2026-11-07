/**
 * The browser's half of the Hypermedia switch (docs/hypermedia.md): one read of whether a ferret is told to use
 * hypermedia, and one write, through the half's own client, so a daemon only the relay reaches is reached and nothing
 * here carries a credential.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';

// GAP(ferrets): `GET /v1/ferrets/:ferretId` answers the ferret's summary today, which carries `mode` but not the
// ferret's own `hypermedia` switch; the ferret view (lead decision Q0) carries both under `config`. Both are read, loosely,
// so the switch shows the mode's default until the view is served and the ferret's own value after.
const HypermediaConfigSchema = z.object({
  mode: z.string().optional(),
  hypermedia: z.boolean().optional(),
});
const FerretViewSchema = z.object({ config: HypermediaConfigSchema });
const FerretReadSchema = z.union([FerretViewSchema, HypermediaConfigSchema.transform(config => ({ config }))]);
export type HypermediaConfig = z.infer<typeof HypermediaConfigSchema>;

/**
 * The switch's answer. Today it also carried the whole ferret view; Conversation's contract names no answer schema, so
 * the view is read when present and the `note` is the part a reader is shown.
 */
const HypermediaPatchResultSchema = z.object({
  note: z.string().min(1),
  restartRequired: z.boolean().optional(),
  view: FerretViewSchema.optional(),
});
export type HypermediaPatchResult = z.infer<typeof HypermediaPatchResultSchema>;

/** Absent means the mode's default: on for an interactive ferret, off for an automatic one (Ferrets' rule). */
export const hypermediaOn = (config: HypermediaConfig): boolean => config.hypermedia ?? config.mode === 'interactive';

/** Whether one ferret is told to use hypermedia now, from Ferrets' `GET /v1/ferrets/:ferretId`. */
export const readFerretHypermedia = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<boolean> =>
  hypermediaOn(FerretReadSchema.parse(await client.call('GET /v1/ferrets/:ferretId', { params: { ferretId } })).config);

/** Switches whether one ferret is told to use hypermedia; it takes effect at that ferret's next launch. */
export const patchFerretHypermedia = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  enabled: boolean,
): Promise<HypermediaPatchResult> =>
  HypermediaPatchResultSchema.parse(
    await client.call('PATCH /v1/ferrets/:ferretId/hypermedia', {
      params: { ferretId },
      body: { enabled },
      headers: { 'x-fy-request-id': crypto.randomUUID() },
    }),
  );
