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
  PreviewSharedItemVersionRequestSchema,
  PublishCatalogVersionRequestSchema,
  PublishSharedItemVersionRequestSchema,
  QuickAddRequestSchema,
  QuickAddUndoRequestSchema,
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
    | 'listItems'
    | 'create'
    | 'update'
    | 'remove'
    | 'previewItem'
    | 'addItem'
    | 'publishVersion'
    | 'getItem'
    | 'currentOf'
    | 'itemVersion'
    | 'itemChanges'
    | 'previewItemVersion'
    | 'publishItemVersion'
    | 'withdraw'
    | 'exportCatalog'
    | 'quickAdd'
    | 'undoQuickAdd'
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
  catalogs_full: 409,
  items_full: 409,
  item_listed: 409,
  current_changed: 409,
  public_unavailable: 400,
  source_unknown: 404,
  source_ambiguous: 409,
  source_refused: 422,
  changed_since_preview: 409,
  nothing_to_publish: 409,
  same_as_version: 409,
  version_unknown: 404,
  signing_unavailable: 503,
  store_damaged: 500,
  export_failed: 500,
  export_too_big: 413,
  undo_expired: 410,
};

async function answer(
  work: () => Promise<unknown>,
  success: number | ((answered: unknown) => number) = 200,
): Promise<ApiResponse> {
  try {
    const answered = await work();
    return jsonResponse(answered, typeof success === 'number' ? success : success(answered));
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

/**
 * A ferret keeps only today's view of an item: the current version, the one every catalog serves. An older or
 * not-yet-current version is the owner's to read, because it can hold what the owner took out on purpose.
 */
async function currentOnlyForAFerret(
  context: RouteContext,
  catalogs: SharedCatalogSubsystem['catalogs'],
  item: string,
  versions: readonly number[],
): Promise<void> {
  if (!isAgentCaller(context)) return;
  const current = await catalogs.currentOf(item);
  if (versions.every(version => version === current)) return;
  throw new ApiError(
    403,
    'a ferret reads only the current version of an item; the owner reads the others.',
    'forbidden',
  );
}

/** Who tapped, from the credential and never the body: a paired device, the agents, or the host's own shell. */
function callerOf(context: RouteContext): string {
  const credential = context.credential;
  if (credential?.tokenClass === 'device') return `device:${credential.deviceId}`;
  return isAgentCaller(context) ? 'agents' : 'host';
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

/** A version number as the wire writes it: digits, from 1. Anything else is a version nobody published. */
function versionNumber(value: string | undefined): number {
  const parsed = /^[1-9][0-9]{0,8}$/u.test(value ?? '') ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new ApiError(404, 'there is no such version', 'version_unknown');
  return parsed;
}

export function sharedCatalogRoutes(subsystem: SharedCatalogSubsystem): readonly ApiRoute[] {
  const { catalogs } = subsystem;
  return [
    {
      method: 'GET',
      path: '/v1/catalogs',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context =>
        await answer(() => catalogs.list({ sourceState: queryValue(context.request, 'sourceState') === '1' })),
    },
    {
      method: 'GET',
      path: '/v1/catalog-items',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context =>
        await answer(() => catalogs.listItems({ sourceState: queryValue(context.request, 'sourceState') === '1' })),
    },
    {
      method: 'GET',
      path: '/v1/catalog-items/:itemId',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const item = itemId(context);
        return await answer(() =>
          catalogs.getItem(item, { sourceState: queryValue(context.request, 'sourceState') === '1' }),
        );
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-items/:itemId/versions/:version',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const item = itemId(context);
        const version = versionNumber(decodeParameter(context.params.get('version') ?? ''));
        return await answer(async () => {
          await currentOnlyForAFerret(context, catalogs, item, [version]);
          return await catalogs.itemVersion(item, version);
        });
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-items/:itemId/changes',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const item = itemId(context);
        const from = versionNumber(queryValue(context.request, 'from'));
        const to = versionNumber(queryValue(context.request, 'to'));
        return await answer(async () => {
          await currentOnlyForAFerret(context, catalogs, item, [from, to]);
          return await catalogs.itemChanges(item, from, to);
        });
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-items/:itemId/versions/preview',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const item = itemId(context);
        await parseBody(context.request, PreviewSharedItemVersionRequestSchema);
        return await answer(() => catalogs.previewItemVersion(item));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-items/:itemId/versions',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'publish a new version of an item');
        const item = itemId(context);
        const request = await parseBody(context.request, PublishSharedItemVersionRequestSchema);
        return await answer(() => catalogs.publishItemVersion(item, request), 201);
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs',
      minimum: 'operator',
      caller: 'person',
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
      caller: 'person',
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
      caller: 'person',
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
      caller: 'any',
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
      caller: 'person',
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
      caller: 'person',
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
      caller: 'person',
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
      path: '/v1/catalog-items/quick-add',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'add to the default catalog');
        const request = await parseBody(context.request, QuickAddRequestSchema);
        return await answer(
          () => catalogs.quickAdd(callerOf(context), request),
          answered => ((answered as { outcome?: unknown }).outcome === 'added' ? 201 : 200),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-items/quick-add/undo',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'undo an add to the default catalog');
        const request = await parseBody(context.request, QuickAddUndoRequestSchema);
        return await answer(() => catalogs.undoQuickAdd(callerOf(context), request.token));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalogs/:id/export',
      minimum: 'operator',
      caller: 'person',
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
