/**
 * Catalogs' port (§2.3): the items this daemon installed from catalogs, pinned by digest, for Skills and MCP to show
 * where an item came from. An install never auto-updates.
 */
import { defineEvent, definePort } from '@ferretry/kernel/contract';
import type { LiveWindowView } from '@ferretry/std/live-window';
import { z } from 'zod';
import { type CatalogInstallSummary, CatalogMemberIdSchema, SharedCatalogIdSchema } from './wire.ts';

export interface CatalogsApi {
  installs(): Promise<readonly CatalogInstallSummary[]>;
}

export const CatalogsPort = definePort<CatalogsApi>('catalogs');

/**
 * WHEN A SHARE INVITE WAS LIVE, as a yes or no (docs/pairing.md, "Never show it to an agent"): the invite's link and QR are a
 * credential that lets a browser join without an existing member passkey, so the agent browser refuses what a page showed
 * while one could be on it. The daemon's own ledger answers (opened by the mint, closed by ending, use or expiry), the same
 * shape as Access's `PairingWindowPort`. NO SHARE CODE, NO SHARE ID and no link crosses it. Until the shares are read it
 * answers "yes".
 */
export const ShareWindowPort = definePort<LiveWindowView>('catalogs.share-window');

/** A catalog, share, member or install changed. A wake-up: read the truth through the port. */
export const CatalogsChanged = defineEvent(
  'catalogs.changed',
  z.strictObject({
    catalog: SharedCatalogIdSchema.optional(),
    member: CatalogMemberIdSchema.optional(),
    change: z.enum(['catalog', 'share', 'member', 'link', 'install']),
  }),
);
