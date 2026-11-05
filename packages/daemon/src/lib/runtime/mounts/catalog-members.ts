/**
 * The people a catalog is shared with, and the codes that let them in (docs/catalogs.md § Members). The domain
 * is `catalog-members/`; the wire is `@ferretry/protocol` catalog-member.
 *
 * Every route is `sharing`/`use`. A FERRET HOLDS THE ADMIN TOKEN BUT MAY ONLY LIST: minting, ending, renaming,
 * revoking and removing are the owner's (`ownerOnly`). A prompt-injected agent that could mint a share could
 * hand a stranger every skill and MCP setup on this machine.
 *
 * MINTING ADDS ACCESS, so a governed caller proves a fresh passkey for the act `share-catalog` alone, claimed
 * atomically (a replayed proof is refused) exactly as a catalog install claims its own. The mint and the "new
 * passkey" mark are the `narrowing` boundary demand (below) so the boundary cannot spend that proof first; the
 * handler then SPENDS the general step-up too, so a zero-minute window admits exactly that one act.
 * Ending a share, taking back the new-passkey mark and removing a catalog only take access away and ask for nothing:
 * they are `narrowing` too. Removing a BROWSER or a PERSON are the exceptions: each can leave `joinNeed` wider than
 * it was (see the routes), so they keep the generic demand.
 *
 * THE CODE AND THE LINK LEAVE THIS MACHINE IN ONE ANSWER: the mint's. Nothing else here can return either —
 * the list view has no field for one, and the audit decorator reads only the named response fields.
 */
import {
  CatalogMemberIdSchema,
  CatalogMemberNameSchema,
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
import {
  CATALOG_MEMBER_STATUS,
  CatalogMemberRefusal,
  type CatalogMemberRefusalCode,
} from '../../catalog-members/refusal.ts';
import type { CatalogMemberService } from '../../catalog-members/service.ts';

const SHARING_USE: CapabilityDemand = { capability: 'sharing', axis: 'use' };
/**
 * What the routes that mint, mark or take access away demand at the boundary: the grant, the device and the unlock,
 * and NOT a generic per-action proof. The boundary cannot tell a widening from a narrowing, and with a zero-minute
 * step-up window it would spend the held proof before the handler claims the fresh `share-catalog` one that a mint
 * or the mark needs, so that act could never succeed; the handler asks that itself. Removing access asks nothing more.
 * NOT used by removing a person or a person's browser: either can change `joinNeed` (docs/grants.md § Narrowing
 * never asks again).
 */
const SHARING_NARROWING: CapabilityDemand = { ...SHARING_USE, narrowing: true };

export interface CatalogMemberSubsystem {
  readonly members: Pick<
    CatalogMemberService,
    | 'mint'
    | 'markNewPasskey'
    | 'listShares'
    | 'endShare'
    | 'listMembers'
    | 'renameMember'
    | 'revokeMember'
    | 'removeKey'
    | 'removeCatalog'
  >;
}

async function answer(work: () => Promise<unknown>, success = 200): Promise<ApiResponse> {
  try {
    return jsonResponse(await work(), success);
  } catch (error) {
    if (error instanceof CatalogMemberRefusal)
      throw new ApiError(
        CATALOG_MEMBER_STATUS[error.refusal],
        error.message,
        error.refusal,
        undefined,
        error.memberId === undefined ? undefined : { memberId: error.memberId },
      );
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
  if (context.governance?.governed !== true) return undefined;
  if (context.claimFreshStepUp?.(STEP_UP_ACTS.shareCatalog) === true) {
    // The boundary did not spend the general step-up (this route is `narrowing`), and the claim above only took the
    // fresh proof; under a zero-minute window the held step-up would admit the NEXT governed act unproved. Spent
    // only after a successful claim, so a refused claim leaves the person's step-up to retry with.
    context.spendStepUp?.();
    return undefined;
  }
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

/**
 * `?name=` on the people list: which person, if any, holds that user ID, so the share sheet can say so before a
 * code is made. Any other parameter, or a name that could never be one, is refused rather than ignored.
 */
function lookupName(context: RouteContext): string | undefined {
  for (const [name] of context.request.query) {
    if (name !== 'name') throw new ApiError(400, `unknown parameter ${name}`, 'unknown_parameter');
  }
  const raw = context.request.query.get('name')?.[0];
  if (raw === undefined) return undefined;
  const parsed = CatalogMemberNameSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'not a user ID', 'invalid_name');
  return parsed.data;
}

/** This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client. */
export function catalogMemberRoutes(subsystem: CatalogMemberSubsystem): readonly ApiRoute[] {
  const { members } = subsystem;
  return [
    {
      method: 'POST',
      path: '/v1/catalog-shares',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_NARROWING,
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
      // "They need a new passkey" (D8) on a live invite. Putting it ON widens who a code can add, so it takes the
      // owner's fresh passkey like minting does; it is never set by anything but this call or the mint request.
      method: 'PUT',
      path: '/v1/catalog-shares/:shareId/new-passkey',
      minimum: 'operator',
      caller: 'person',
      capability: SHARING_NARROWING,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'approve a new passkey for an invite');
        const id = shareId(context);
        const refusal = claimPasskey(context);
        if (refusal !== undefined) return refusal;
        return await answer(() => members.markNewPasskey(id, true));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-shares/:shareId/new-passkey',
      minimum: 'operator',
      caller: 'person',
      // Narrowing: one shares write that only clears the mark, so a failed write leaves the mark set and a success
      // moves `joinNeed` from `owner-approved` to something no looser (`first-browser` needs nothing either way).
      capability: SHARING_NARROWING,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'take back the approval of a new passkey');
        const id = shareId(context);
        return await answer(() => members.markNewPasskey(id, false));
      },
    },
    {
      method: 'GET',
      path: '/v1/catalog-shares',
      minimum: 'operator',
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async () => await answer(() => members.listShares()),
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-shares/:shareId',
      minimum: 'operator',
      caller: 'person',
      // Narrowing: one shares write that ends that one invite. It touches no member and no other invite, so no other
      // code's `joinNeed` changes, and a failed write leaves the invite live exactly as it was.
      capability: SHARING_NARROWING,
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
      caller: 'any',
      capability: SHARING_USE,
      noStore: true,
      handle: async context => {
        const name = lookupName(context);
        return await answer(() => members.listMembers(name));
      },
    },
    {
      method: 'PATCH',
      path: '/v1/catalog-members/:memberId',
      minimum: 'operator',
      caller: 'person',
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
      caller: 'person',
      // Generic, NOT narrowing: `revokeMember` writes the members file BEFORE it ends the person's invites. If the
      // shares write fails and the daemon restarts before a retry, the person is gone while a spare `memberKind: new`
      // invite is still live, and `joinNeed` turns from `proof` into `first-browser`: its holder is admitted with no
      // proof of a passkey. That can widen who joins, so it takes a per-act proof like a widening.
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
      caller: 'person',
      // Generic, NOT narrowing: removing the last passkey-bearing browser while another is inside its registration
      // window turns a spare invite's `joinNeed` from `proof` to `first-browser`, which widens who can join.
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
      caller: 'person',
      // Narrowing: `removeCatalog` writes the members file (the person keeps every browser and their record) and then
      // the shares. A failure between the two, even across a restart, leaves the person and their browsers as they
      // were, so `joinNeed` is unchanged; the only residue is an invite that still names a catalog the person no
      // longer has, which a retry removes and which grants nothing the person did not have before the call.
      capability: SHARING_NARROWING,
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
