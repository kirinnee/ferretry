/**
 * Download links: ONE skill or MCP setup behind a URL (docs/catalogs.md § Links). The domain is `catalog-links/`;
 * the wire is `@ferretry/protocol` catalog-link.
 *
 * Every route is `sharing`/`use`. A FERRET HOLDS THE ADMIN TOKEN BUT MAY ONLY READ: previewing, minting, copying
 * and turning off are the owner's (`ownerOnly`). A prompt-injected agent that could mint a link could hand a
 * stranger a skill or an MCP setup from this machine, and one that could Copy would read a public link's key.
 *
 * MINTING ADDS ACCESS, so a governed caller proves a fresh passkey for the act `share-link` alone, claimed
 * atomically (a replayed proof is refused). Copy only shows what the owner already made, so it needs the device
 * unlock and no new proof. Turning off takes access away and asks for nothing.
 *
 * THE LINK LEAVES THIS MACHINE IN TWO ANSWERS: the mint's and Copy's. No other answer has a field for a URL or a
 * key, and the audit decorator reads only the named response fields.
 */
import {
  CatalogLinkIdSchema,
  CatalogLinkPreviewRequestSchema,
  CreateCatalogLinkRequestSchema,
  SharedCatalogItemIdSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { CatalogLinkService } from '../../catalog-links/service.ts';
import { CatalogLinkRefusal, LINK_STATUS } from '../../catalog-links/refusal.ts';

const SHARING_USE: CapabilityDemand = { capability: 'sharing', axis: 'use' };

export interface CatalogLinkSubsystem {
  readonly links: Pick<CatalogLinkService, 'storeStatus' | 'preview' | 'mint' | 'list' | 'get' | 'copy' | 'revoke'>;
}

async function answer(work: () => Promise<unknown>, success = 200): Promise<ApiResponse> {
  try {
    return jsonResponse(await work(), success);
  } catch (error) {
    if (error instanceof CatalogLinkRefusal)
      throw new ApiError(LINK_STATUS[error.refusal], error.message, error.refusal);
    throw error;
  }
}

/** A ferret reads. It does not make, copy or end a link. */
function ownerOnly(context: RouteContext, act: string): void {
  if (!isAgentCaller(context)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. A download link lets another person install a skill or an MCP setup from this machine.`,
    'forbidden',
  );
}

/**
 * Claims the passkey proof for minting, atomically. `undefined` means it may go on; an ungoverned caller (the
 * machine's own `fy`) needs none.
 */
function claimPasskey(context: RouteContext): ApiResponse | undefined {
  if (context.governance?.governed !== true || context.claimFreshStepUp?.(STEP_UP_ACTS.shareLink) === true)
    return undefined;
  return jsonResponse(
    {
      error: 'making a download link needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...SHARING_USE, act: STEP_UP_ACTS.shareLink },
    } satisfies StepUpRequiredBody,
    403,
  );
}

function linkId(context: RouteContext): string {
  const parsed = CatalogLinkIdSchema.safeParse(decodeParameter(context.params.get('linkId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(404, 'there is no such link', 'link_unknown');
  return parsed.data;
}

/** `?itemId=` on the list: the links of one item. Any other parameter, or an id that could never be one, is refused. */
function itemFilter(context: RouteContext): string | undefined {
  for (const [name] of context.request.query) {
    if (name !== 'itemId') throw new ApiError(400, `unknown parameter ${name}`, 'unknown_parameter');
  }
  const raw = context.request.query.get('itemId')?.[0];
  if (raw === undefined) return undefined;
  const parsed = SharedCatalogItemIdSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'not an item id', 'invalid_item_id');
  return parsed.data;
}

/**
 * This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client.
 * The two fixed paths come before `:linkId`, which would otherwise take them.
 */
export function catalogLinkRoutes(subsystem: CatalogLinkSubsystem): readonly ApiRoute[] {
  const { links } = subsystem;
  return [
    {
      method: 'GET',
      path: '/v1/catalog-links/store',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async () => await answer(() => links.storeStatus()),
    },
    {
      method: 'POST',
      path: '/v1/catalog-links/preview',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'preview a download link');
        const request = await parseBody(context.request, CatalogLinkPreviewRequestSchema);
        return await answer(() => links.preview(request));
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-links',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const itemId = itemFilter(context);
        return await answer(() => links.list(itemId));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-links',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'make a download link');
        const request = await parseBody(context.request, CreateCatalogLinkRequestSchema);
        const refusal = claimPasskey(context);
        if (refusal !== undefined) return refusal;
        return await answer(() => links.mint(request), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-links/:linkId',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const id = linkId(context);
        return await answer(() => links.get(id));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-links/:linkId/copy',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'copy a download link');
        const id = linkId(context);
        return await answer(() => links.copy(id));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-links/:linkId',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'turn off a download link');
        const id = linkId(context);
        return await answer(() => links.revoke(id));
      },
    },
  ];
}
