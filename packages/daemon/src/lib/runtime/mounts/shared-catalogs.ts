/**
 * The catalogs this machine publishes (docs/catalogs.md § The publisher side). The domain is
 * `shared-catalogs/`; the wire is `@ferretry/protocol` shared-catalog-owner.
 *
 * Every route is `sharing`/`use`. A governed caller therefore proves a passkey for it, because what leaves
 * through the export is the contents of skills and the shape of MCP setups.
 *
 * A FERRET HOLDS THE ADMIN TOKEN BUT MAY ONLY LIST. Making a catalog, adding to it, publishing, withdrawing
 * and exporting are the owner's (`ownerOnly`): a prompt-injected agent that could publish would be one that
 * could hand a skill, or a server's address, to whoever the owner next sends the file to.
 *
 * Nothing here reads a request body for the audit log. The decorator records ids, versions and digests from
 * the ANSWER (`lib/audit/routes.ts`), never what an item holds.
 */
import {
  AddCatalogItemRequestSchema,
  CatalogItemPreviewRequestSchema,
  CreateCatalogRequestSchema,
  ExportCatalogRequestSchema,
  PublishCatalogVersionRequestSchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
  UpdateCatalogRequestSchema,
} from '@ferretry/protocol';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { CatalogRefusal, type CatalogRefusalCode } from '../../shared-catalogs/refusal.ts';
import type { SharedCatalogService } from '../../shared-catalogs/service.ts';

const SHARING_USE: CapabilityDemand = { capability: 'sharing', axis: 'use' };

export interface SharedCatalogSubsystem {
  readonly catalogs: Pick<
    SharedCatalogService,
    | 'list'
    | 'create'
    | 'update'
    | 'remove'
    | 'previewItem'
    | 'addItem'
    | 'publishVersion'
    | 'withdraw'
    | 'exportCatalog'
  >;
}

/**
 * How each refusal answers. A damaged store and a file that would not verify are this machine's fault, so
 * they are 500s; no identity to sign with is a 503; the rest are the caller's to fix.
 */
const STATUS: Readonly<Record<CatalogRefusalCode, number>> = {
  catalog_unknown: 404,
  item_unknown: 404,
  item_withdrawn: 409,
  name_taken: 409,
  catalog_full: 409,
  public_unavailable: 400,
  source_unknown: 404,
  source_ambiguous: 409,
  source_refused: 422,
  changed_since_preview: 409,
  nothing_to_publish: 409,
  signing_unavailable: 503,
  store_damaged: 500,
  export_failed: 500,
  export_too_big: 413,
};

async function answer(work: () => Promise<unknown>, success = 200): Promise<ApiResponse> {
  try {
    return jsonResponse(await work(), success);
  } catch (error) {
    if (error instanceof CatalogRefusal) throw new ApiError(STATUS[error.refusal], error.message, error.refusal);
    throw error;
  }
}

/** A ferret lists. It does not publish. */
function ownerOnly(context: RouteContext, act: string): void {
  if (!isAgentCaller(context)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. A catalog hands skills and MCP setups to other machines, so the owner makes, changes and exports it.`,
    'forbidden',
  );
}

function catalogId(context: RouteContext): string {
  const parsed = SharedCatalogIdSchema.safeParse(decodeParameter(context.params.get('id') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(404, 'there is no such catalog', 'catalog_unknown');
  return parsed.data;
}

function itemId(context: RouteContext): string {
  const parsed = SharedCatalogItemIdSchema.safeParse(decodeParameter(context.params.get('itemId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(404, 'there is no such item', 'item_unknown');
  return parsed.data;
}

export function sharedCatalogRoutes(subsystem: SharedCatalogSubsystem): readonly ApiRoute[] {
  const { catalogs } = subsystem;
  return [
    {
      method: 'GET',
      path: '/v1/catalogs',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context =>
        await answer(() => catalogs.list({ sourceState: queryValue(context.request, 'sourceState') === '1' })),
    },
    {
      method: 'POST',
      path: '/v1/catalogs',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'make a catalog');
        const request = await parseBody(context.request, CreateCatalogRequestSchema);
        return await answer(() => catalogs.create(request), 201);
      },
    },
    {
      method: 'PATCH',
      path: '/v1/catalogs/:id',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'change a catalog');
        const id = catalogId(context);
        const request = await parseBody(context.request, UpdateCatalogRequestSchema);
        return await answer(() => catalogs.update(id, request));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalogs/:id',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'delete a catalog');
        const id = catalogId(context);
        return await answer(() => catalogs.remove(id));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs/:id/items/preview',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const id = catalogId(context);
        const request = await parseBody(context.request, CatalogItemPreviewRequestSchema);
        return await answer(() => catalogs.previewItem(id, request));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs/:id/items',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'add an item to a catalog');
        const id = catalogId(context);
        const request = await parseBody(context.request, AddCatalogItemRequestSchema);
        return await answer(() => catalogs.addItem(id, request), 201);
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs/:id/items/:itemId/versions',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'publish a new version of a catalog item');
        const id = catalogId(context);
        const item = itemId(context);
        const request = await parseBody(context.request, PublishCatalogVersionRequestSchema);
        return await answer(() => catalogs.publishVersion(id, item, request), 201);
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalogs/:id/items/:itemId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'withdraw a catalog item');
        const id = catalogId(context);
        const item = itemId(context);
        return await answer(() => catalogs.withdraw(id, item));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs/:id/export',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'export a catalog');
        const id = catalogId(context);
        const request = await parseBody(context.request, ExportCatalogRequestSchema);
        return await answer(() => catalogs.exportCatalog(id, request));
      },
    },
  ];
}
