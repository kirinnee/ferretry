import { ReferenceCatalog } from '../../contract/index.ts';
import { AgentsReferenceMenu } from '../references/agents-menu.ts';
import { referenceCatalogRoute } from '../references/catalog.ts';
import { FilesReferenceMenu } from '../references/files-menu.ts';
import type { ConversationFeature } from './types.ts';

/** The composer's reference menus: the catalog route, and the `:` (fleet callsigns) and `@` (a ferret's files) menus. */
export default {
  id: 'references',
  register: f => ({
    routes: {
      'GET /v1/ferrets/:ferretId/references': referenceCatalogRoute({
        providerOf: prefix => f.hooks.provider(ReferenceCatalog, prefix),
        ferrets: f.ferrets,
      }),
    },
    hooks: () => ({
      // The composer's `:` (fleet callsigns) and `@` (one folder of the ferret's files) menus, each declaring the demand
      // its own read route asks (fleet, filesystem); the route asks it of the caller before they run.
      'reference.catalog::': new AgentsReferenceMenu(f.ferrets),
      'reference.catalog:@': new FilesReferenceMenu(f.ferrets),
    }),
  }),
} satisfies ConversationFeature;
