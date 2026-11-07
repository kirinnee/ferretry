/**
 * Catalogs' port (§2.3): the items this daemon installed from catalogs, pinned by digest, for Skills and MCP to show
 * where an item came from. An install never auto-updates.
 */
import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type CatalogInstallSummary, CatalogMemberIdSchema, SharedCatalogIdSchema } from './wire.ts';

export interface CatalogsApi {
  installs(): Promise<readonly CatalogInstallSummary[]>;
}

export const CatalogsPort = definePort<CatalogsApi>('catalogs');

/** A catalog, share, member or install changed. A wake-up: read the truth through the port. */
export const CatalogsChanged = defineEvent(
  'catalogs.changed',
  z.strictObject({
    catalog: SharedCatalogIdSchema.optional(),
    member: CatalogMemberIdSchema.optional(),
    change: z.enum(['catalog', 'share', 'member', 'link', 'install']),
  }),
);
