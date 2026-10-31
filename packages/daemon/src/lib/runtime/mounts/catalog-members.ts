/**
 * The people a catalog is shared with, and the codes that let them in (docs/catalogs.md § Members). The domain
 * is `catalog-members/`; the wire is `@ferretry/protocol` catalog-member.
 *
 * Every route is `sharing`/`use`. A FERRET HOLDS THE ADMIN TOKEN BUT MAY ONLY LIST: minting, ending, renaming,
 * revoking and removing are the owner's (`ownerOnly`). A prompt-injected agent that could mint a share could
 * hand a stranger every skill and MCP setup on this machine.
 *
 * MINTING ADDS ACCESS, so a governed caller proves a fresh passkey for the act `share-catalog` alone, claimed
 * atomically (a replayed proof is refused) exactly as a catalog install claims its own. Ending, revoking and
 * removing only take access away and ask for nothing.
 *
 * THE CODE AND THE LINK LEAVE THIS MACHINE IN ONE ANSWER: the mint's. Nothing else here can return either —
 * the list view has no field for one, and the audit decorator reads only the named response fields.
 */
import {
  CatalogMemberIdSchema,
  CatalogMemberKeyIdSchema,
  CatalogMemberRenameRequestSchema,
  CatalogShareIdSchema,
  CatalogShareMintRequestSchema,
  SharedCatalogIdSchema,
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
import { CatalogMemberRefusal, type CatalogMemberRefusalCode } from '../../catalog-members/refusal.ts';
import type { CatalogMemberService } from '../../catalog-members/service.ts';

const SHARING_USE: CapabilityDemand = { capability: 'sharing', axis: 'use' };

export interface CatalogMemberSubsystem {
  readonly members: Pick<
    CatalogMemberService,
    'mint' | 'listShares' | 'endShare' | 'listMembers' | 'renameMember' | 'revokeMember' | 'removeKey' | 'removeCatalog'
  >;
}

/**
 * How each refusal answers. A damaged store is this machine's fault (500) and no address to put in a link is a
 * 503; the owner's mistakes are 404 (no such id) or 409 (the state will not take it).
 */
const STATUS: Readonly<Record<CatalogMemberRefusalCode, number>> = {
  share_refused: 409,
  share_other_member: 409,
  share_new_member: 409,
  members_full: 409,
  member_unknown: 404,
  member_key_unknown: 404,
  catalog_unknown: 404,
  share_unknown: 404,
  shares_full: 409,
  catalogs_full: 409,
  share_link_unavailable: 503,
  store_damaged: 500,
};

async function answer(work: () => Promise<unknown>, success = 200): Promise<ApiResponse> {
  try {
    return jsonResponse(await work(), success);
  } catch (error) {
    if (error instanceof CatalogMemberRefusal) throw new ApiError(STATUS[error.refusal], error.message, error.refusal);
    throw error;
  }
}

/** A ferret lists. It does not change who can read what. */
function ownerOnly(context: RouteContext, act: string): void {
  if (!isAgentCaller(context)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. Sharing a catalog lets another person read skills and MCP setups from this machine.`,
    'forbidden',
  );
}

/**
 * Claims the passkey proof for minting, atomically. `undefined` means it may go on; an ungoverned caller (the
 * machine's own `fy`) needs none.
 */
function claimPasskey(context: RouteContext): ApiResponse | undefined {
  if (context.governance?.governed !== true || context.claimFreshStepUp?.(STEP_UP_ACTS.shareCatalog) === true)
    return undefined;
  return jsonResponse(
    {
      error: 'sharing a catalog needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...SHARING_USE, act: STEP_UP_ACTS.shareCatalog },
    } satisfies StepUpRequiredBody,
    403,
  );
}

function pathId(
  context: RouteContext,
  name: string,
  parse: (text: string) => { success: boolean; data?: string },
  what: string,
  code: CatalogMemberRefusalCode,
): string {
  const parsed = parse(decodeParameter(context.params.get(name) ?? '') ?? '');
  if (!parsed.success || parsed.data === undefined) throw new ApiError(404, `there is no such ${what}`, code);
  return parsed.data;
}

const shareId = (context: RouteContext): string =>
  pathId(context, 'shareId', text => CatalogShareIdSchema.safeParse(text), 'share', 'share_unknown');
const memberId = (context: RouteContext): string =>
  pathId(context, 'memberId', text => CatalogMemberIdSchema.safeParse(text), 'member', 'member_unknown');
const keyId = (context: RouteContext): string =>
  pathId(context, 'keyId', text => CatalogMemberKeyIdSchema.safeParse(text), 'browser', 'member_key_unknown');
const catalogId = (context: RouteContext): string =>
  pathId(context, 'catalogId', text => SharedCatalogIdSchema.safeParse(text), 'catalog', 'catalog_unknown');

/** This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client. */
export function catalogMemberRoutes(subsystem: CatalogMemberSubsystem): readonly ApiRoute[] {
  const { members } = subsystem;
  return [
    {
      method: 'POST',
      path: '/v1/catalog-shares',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'share a catalog');
        const request = await parseBody(context.request, CatalogShareMintRequestSchema);
        const refusal = claimPasskey(context);
        if (refusal !== undefined) return refusal;
        return await answer(() => members.mint(request), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-shares',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async () => await answer(() => members.listShares()),
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-shares/:shareId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'end a share');
        const id = shareId(context);
        return await answer(() => members.endShare(id));
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-members',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async () => await answer(() => members.listMembers()),
    },
    {
      method: 'PATCH',
      path: '/v1/catalog-members/:memberId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'rename a person');
        const id = memberId(context);
        const request = await parseBody(context.request, CatalogMemberRenameRequestSchema);
        return await answer(() => members.renameMember(id, request.label));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-members/:memberId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'remove a person');
        const id = memberId(context);
        return await answer(() => members.revokeMember(id));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-members/:memberId/keys/:keyId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, "remove a person's browser");
        const member = memberId(context);
        const key = keyId(context);
        return await answer(() => members.removeKey(member, key));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-members/:memberId/catalogs/:catalogId',
      minimum: 'operator',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'take a catalog away from a person');
        const member = memberId(context);
        const catalog = catalogId(context);
        return await answer(() => members.removeCatalog(member, catalog));
      },
    },
  ];
}
