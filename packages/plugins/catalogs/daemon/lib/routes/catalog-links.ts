import { CAPABILITIES } from '@ferretry/core-gate/contract';
/**
 * Download links: ONE skill or MCP setup behind a URL (docs/catalogs.md § Links). The domain is `catalog-links/`;
 * the wire is `@ferretry/protocol` catalog-link.
 *
 * Every route is `sharing`/`use`; move, change, Copy and turn-off are the `narrowing` boundary demand (below). A FERRET HOLDS THE ADMIN TOKEN BUT MAY ONLY READ: previewing, minting, copying
 * and turning off are the owner's (`ownerOnly`). A prompt-injected agent that could mint a link could hand a
 * stranger a skill or an MCP setup from this machine, and one that could Copy would read a public link's key.
 *
 * MINTING ADDS ACCESS, so a governed caller proves a fresh passkey for the act `share-link` alone, claimed
 * atomically (a replayed proof is refused). So does MOVING a link (it serves other bytes at the same URL) and a
 * CHANGE that reaches further (a later end, a higher or no cap). A change that narrows takes access away and asks for
 * nothing, like turning off; Copy only shows what the owner already made, so it needs the device unlock and no new proof.
 *
 * THE LINK LEAVES THIS MACHINE IN TWO ANSWERS: the mint's and Copy's. No other answer has a field for a URL or a
 * key, and the audit decorator reads only the named response fields.
 */
import {
  CatalogLinkIdSchema,
  CatalogLinkPreviewRequestSchema,
  CreateCatalogLinkRequestSchema,
  MoveCatalogLinkRequestSchema,
  SharedCatalogItemIdSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
  UpdateCatalogLinkRequestSchema,
} from '../boundary.ts';
import { isAgentCaller } from '../http.ts';
import { parseBody } from '../body.ts';
import type { CapabilityDemand } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { type ApiResponse, decodeParameter } from '@ferretry/kernel/contract';
import { jsonResponse } from '@ferretry/kernel/contract';
import type { ApiRoute, RouteContext } from '../http.ts';
import type { CatalogLinkService } from '../catalog-links/service.ts';
import { CatalogLinkRefusal, LINK_STATUS } from '../catalog-links/refusal.ts';

const SHARING_USE = { capability: CAPABILITIES.sharing, axis: 'use' } as const satisfies CapabilityDemand;
/**
 * What the routes that move, change, copy or turn off a link demand at the boundary: the grant, the device and the
 * unlock, and NOT a generic per-action proof. The boundary cannot tell a narrowing from a widening, and it would
 * spend the held proof before the handler claims the fresh `share-link` one that a move or a widening needs; the
 * handler asks that itself. A narrowing, Copy and turning off then ask nothing more.
 */
const SHARING_NARROWING = { ...SHARING_USE, narrowing: true } as const satisfies CapabilityDemand;

export interface CatalogLinkSubsystem {
  readonly links: Pick<
    CatalogLinkService,
    'storeStatus' | 'preview' | 'mint' | 'list' | 'get' | 'copy' | 'revoke' | 'move' | 'widens' | 'update'
  >;
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
 * Claims the passkey proof for an act that adds access, atomically. `undefined` means it may go on; an ungoverned
 * caller (the machine's own `fy`) needs none.
 */
function claimPasskey(context: RouteContext, what = 'making a download link'): ApiResponse | undefined {
  if (context.governance?.governed !== true || context.claimFreshStepUp?.(STEP_UP_ACTS.shareLink) === true)
    return undefined;
  return jsonResponse(
    {
      error: `${what} needs a passkey confirmation for it, from this device`,
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
      method: 'PUT',
      path: '/v1/catalog-links/:linkId/version',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_NARROWING,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'move a download link');
        const id = linkId(context);
        const request = await parseBody(context.request, MoveCatalogLinkRequestSchema);
        const refusal = claimPasskey(context, 'moving a download link to another version');
        if (refusal !== undefined) return refusal;
        return await answer(() => links.move(id, request));
      },
    },
    {
      method: 'PATCH',
      path: '/v1/catalog-links/:linkId',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_NARROWING,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'change a download link');
        const id = linkId(context);
        const request = await parseBody(context.request, UpdateCatalogLinkRequestSchema);
        // Only a change that reaches further asks for a passkey; the service refuses one that became so after this.
        let widens = false;
        try {
          widens = await links.widens(id, request);
        } catch (error) {
          if (error instanceof CatalogLinkRefusal)
            throw new ApiError(LINK_STATUS[error.refusal], error.message, error.refusal);
          throw error;
        }
        if (widens) {
          const refusal = claimPasskey(context, 'making a download link reach further');
          if (refusal !== undefined) return refusal;
        }
        return await answer(() => links.update(id, request, widens));
      },
    },
    {
      method: 'POST',
      path: '/v1/catalog-links/:linkId/copy',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_NARROWING,
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
      capability: SHARING_NARROWING,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'turn off a download link');
        const id = linkId(context);
        return await answer(() => links.revoke(id));
      },
    },
  ];
}
