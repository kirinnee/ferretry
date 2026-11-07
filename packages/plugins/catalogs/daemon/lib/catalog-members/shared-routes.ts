import {
  type CatalogShareRefusal,
  type MemberJoinedResponse,
  PasskeyOptionsRequestSchema,
  PasskeyRegistrationOptionsSchema,
  PasskeyRegistrationSchema,
  PasskeyViewSchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
  SharedMeSchema,
  SharedRedeemRequestSchema,
  SharedRedeemResponseSchema,
  type SignedCatalogItemVersions,
  type SignedCatalogManifest,
  type SharedCatalogItem,
  StepUpAssertionSchema,
  StepUpOptionsSchema,
  UnlockGrantedSchema,
} from '../boundary.ts';
import {
  ApiError,
  errorResponse,
  jsonResponse,
  decodeParameter,
  type ApiRequest,
  type ApiResponse,
  type RouteParameters,
  type RoutePattern,
} from '@ferretry/kernel/contract';
import { parseBody } from '../../adapters/body.ts';
import { namesTag } from '../response-headers.ts';
import type { AuditEntry } from '../audit.ts';
import { CatalogRefusal, type CatalogRefusalCode } from '../shared-catalogs/refusal.ts';
import type { MemberPasskeyOutcome, MemberPasskeyRefusal, MemberPasskeyService } from './passkeys.ts';
import type { MemberAuditSink } from './ports.ts';
import type { LiveMemberSessions } from './sessions.ts';
import { CATALOG_MEMBER_STATUS, CatalogMemberRefusal } from './refusal.ts';
import type { CatalogMemberService, MemberAccess } from './service.ts';
export interface SharedCatalogReader {
  catalogs(): Promise<readonly { readonly id: string; readonly name: string; readonly revision: number }[]>;
  signedManifest(catalogId: string): Promise<SignedCatalogManifest>;
  versionsRevision(catalogId: string, itemId: string): Promise<number>;
  signedVersions(catalogId: string, itemId: string): Promise<SignedCatalogItemVersions>;
  frozenItem(catalogId: string, itemId: string, version: number): Promise<SharedCatalogItem>;
}

export type SharedPublisher = Pick<MemberJoinedResponse, 'daemonId' | 'daemonName' | 'carriers'>;

export interface SharedRouteDeps {
  readonly members: Pick<
    CatalogMemberService,
    'ready' | 'access' | 'admitRedeem' | 'commitRedeem' | 'release' | 'removeKey'
  >;
  readonly passkeys: MemberPasskeyService;
  readonly sessions: Pick<LiveMemberSessions, 'spare'>;
  readonly catalogs: SharedCatalogReader;
  readonly publisher: () => SharedPublisher;
  readonly audit: MemberAuditSink;
  readonly now: () => number;
}

export interface SharedRouteContext {
  readonly request: ApiRequest;
  readonly params: RouteParameters;
  readonly access: MemberAccess;
  readonly appSession: string;
  readonly sessionId: string;
}

export interface SharedRoute extends RoutePattern {
  readonly needs: 'key' | 'unlocked';
  handle(context: SharedRouteContext): Promise<ApiResponse>;
}

const PASSKEY_STATUS: Readonly<Record<MemberPasskeyRefusal, { readonly status: number; readonly message: string }>> = {
  'origin-not-allowed': {
    status: 403,
    message: 'this copy of the app is not one this machine serves; ask the person who shared with you',
  },
  'registration-closed': {
    status: 403,
    message: 'a passkey can only be added in the ten minutes after you joined, or once you have unlocked',
  },
  'too-many-passkeys': { status: 409, message: 'this browser already holds as many passkeys as it may' },
  'no-passkey': { status: 404, message: 'this copy of the app has no passkey for this machine' },
  'not-verified': { status: 401, message: 'that passkey confirmation did not check out; try again' },
};

const ITEM_VERSION = /^[1-9][0-9]{0,8}$/u;

const ITEM_NOT_OFFERED = 'this catalog does not offer that';

async function asNotOffered<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CatalogRefusal && (error.refusal === 'item_unknown' || error.refusal === 'item_withdrawn'))
      throw new ApiError(404, ITEM_NOT_OFFERED, 'item_unknown');
    throw error;
  }
}

const CATALOG_STATUS: Partial<Record<CatalogRefusalCode, number>> = {
  catalog_unknown: 404,
  item_unknown: 404,
  item_withdrawn: 409,
  signing_unavailable: 503,
};

/**
 * What a member route's failure says over the wire, as today's member dispatcher answered it: the domain's own
 * refusals keep their code and status; anything else is left as it was (the kernel answers 500).
 */
export function memberFailure(error: unknown): unknown {
  if (error instanceof CatalogMemberRefusal)
    return new ApiError(CATALOG_MEMBER_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof CatalogRefusal)
    return new ApiError(CATALOG_STATUS[error.refusal] ?? 500, error.message, error.refusal);
  return error;
}

const REDEEM_REFUSAL: Readonly<Record<CatalogShareRefusal, string>> = {
  share_refused: 'that code is not one this machine will take',
  share_other_member: 'that code was made for somebody else, and it is now spent',
  share_new_member: 'that code starts a new member, and this browser already belongs to one here',
  members_full: 'this machine holds as many people as it may',
  member_unknown: 'this browser is not a member here any more',
  member_key_unknown: 'this browser is not registered here any more',
  member_exists: 'someone here already has that user ID',
  catalog_unknown: 'a catalog in that code is gone',
  share_unknown: 'that code is not one this machine will take',
};

const answer = <T>(outcome: MemberPasskeyOutcome<T>, status = 200): ApiResponse => {
  if (outcome.ok) return jsonResponse(outcome.value, status);
  const { status: code, message } = PASSKEY_STATUS[outcome.refusal];
  return errorResponse(code, message, `member_${outcome.refusal.replaceAll('-', '_')}`);
};

const requireCatalog = (context: SharedRouteContext, raw: string | undefined): string => {
  const decoded = raw === undefined ? undefined : decodeParameter(raw);
  const parsed = SharedCatalogIdSchema.safeParse(decoded);
  // One answer for a catalog that is unknown and one that is not this member's: neither says which.
  if (!parsed.success || !context.access.catalogIds.includes(parsed.data))
    throw new ApiError(404, 'no such catalog', 'catalog_unknown');
  return parsed.data;
};

export function sharedRoutes(deps: SharedRouteDeps): readonly SharedRoute[] {
  const caller = (context: SharedRouteContext) => ({ access: context.access, appSession: context.appSession });
  const record = async (entry: AuditEntry): Promise<void> => {
    await deps.audit.record(entry).catch(() => undefined);
  };

  const redeem = async (context: SharedRouteContext): Promise<ApiResponse> => {
    const { code } = await parseBody(context.request, SharedRedeemRequestSchema);
    await deps.members.ready();
    const admission = deps.members.admitRedeem(code, context.access.memberId, deps.now());
    const held = admission.ok ? admission.reservation : undefined;
    let committed = false;
    try {
      // The burn is on disk before ANYTHING is answered: a refusal that spent the code and a redeem that adds
      // nothing included.
      await admission.persisted;
      if (!admission.ok) throw new CatalogMemberRefusal(admission.refusal, REDEEM_REFUSAL[admission.refusal]);
      await deps.members.commitRedeem(admission.reservation, {
        keyId: context.access.keyId,
        clientName: context.access.clientName,
      });
      committed = true;
    } finally {
      if (held !== undefined && !committed) await deps.members.release(held).catch(() => undefined);
    }
    const names = new Map((await deps.catalogs.catalogs()).map(catalog => [catalog.id, catalog.name]));
    const added = (held?.added ?? []).flatMap(catalogId =>
      names.has(catalogId) ? [{ catalogId, name: names.get(catalogId) ?? '' }] : [],
    );
    return jsonResponse(SharedRedeemResponseSchema.parse({ added }));
  };

  return [
    {
      method: 'POST',
      path: '/v1/shared/passkeys/options',
      needs: 'key',
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        const outcome = await deps.passkeys.registrationOptions(caller(context), body.origin);
        return answer(
          outcome.ok ? { ok: true, value: PasskeyRegistrationOptionsSchema.parse(outcome.value) } : outcome,
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/shared/passkeys',
      needs: 'key',
      handle: async context => {
        const body = await parseBody(context.request, PasskeyRegistrationSchema.omit({ confirmation: true }));
        const outcome = await deps.passkeys.register(caller(context), body);
        return answer(outcome.ok ? { ok: true, value: PasskeyViewSchema.parse(outcome.value) } : outcome, 201);
      },
    },
    {
      method: 'POST',
      path: '/v1/shared/unlock/options',
      needs: 'key',
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        const outcome = await deps.passkeys.unlockOptions(caller(context), body.origin);
        return answer(outcome.ok ? { ok: true, value: StepUpOptionsSchema.parse(outcome.value) } : outcome);
      },
    },
    {
      method: 'POST',
      path: '/v1/shared/unlock',
      needs: 'key',
      handle: async context => {
        const body = await parseBody(context.request, StepUpAssertionSchema.omit({ rotation: true }));
        const outcome = await deps.passkeys.unlock(caller(context), body);
        return answer(outcome.ok ? { ok: true, value: UnlockGrantedSchema.parse(outcome.value) } : outcome);
      },
    },
    {
      method: 'GET',
      path: '/v1/shared/me',
      needs: 'unlocked',
      handle: async ({ access }) => {
        const unlockEnds = deps.passkeys.unlockExpiresAt(access.keyId) ?? 0;
        const publisher = deps.publisher();
        const known = new Map((await deps.catalogs.catalogs()).map(catalog => [catalog.id, catalog]));
        return jsonResponse(
          SharedMeSchema.parse({
            memberId: access.memberId,
            keyId: access.keyId,
            label: access.label,
            daemonId: publisher.daemonId,
            daemonName: publisher.daemonName,
            catalogs: access.catalogIds.flatMap(id => {
              const catalog = known.get(id);
              return catalog === undefined ? [] : [{ catalogId: id, name: catalog.name, revision: catalog.revision }];
            }),
            carriers: publisher.carriers,
            unlockExpiresAt: new Date(unlockEnds).toISOString(),
            passkeys: await deps.passkeys.passkeyCount(access.keyId),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/v1/shared/catalogs/:catalogId/manifest',
      needs: 'unlocked',
      handle: async context => {
        const catalogId = requireCatalog(context, context.params.get('catalogId'));
        const current = (await deps.catalogs.catalogs()).find(catalog => catalog.id === catalogId);
        if (current === undefined) throw new ApiError(404, 'no such catalog', 'catalog_unknown');
        const tag = `"${String(current.revision)}"`;
        const asked = context.request.headers.get('if-none-match');
        if (asked !== undefined && namesTag(asked, tag))
          return { status: 304, headers: new Map([['etag', tag]]), body: '' };
        const signed = await deps.catalogs.signedManifest(catalogId);
        return jsonResponse(signed, 200, { etag: `"${String(signed.manifest.revision)}"` });
      },
    },
    {
      // Before `:version`, which would otherwise take the word "versions" and answer 404.
      method: 'GET',
      path: '/v1/shared/catalogs/:catalogId/items/:itemId/versions',
      needs: 'unlocked',
      handle: async context => {
        const catalogId = requireCatalog(context, context.params.get('catalogId'));
        const itemId = SharedCatalogItemIdSchema.safeParse(decodeParameter(context.params.get('itemId') ?? ''));
        if (!itemId.success) throw new ApiError(404, ITEM_NOT_OFFERED, 'item_unknown');
        // A plain read first, so an item this catalog does not offer answers 404 whatever tag was sent, and a poll that
        // has nothing new never waits behind a write or signs anything.
        const revision = await asNotOffered(async () => await deps.catalogs.versionsRevision(catalogId, itemId.data));
        const asked = context.request.headers.get('if-none-match');
        const known = `"${String(revision)}"`;
        if (asked !== undefined && namesTag(asked, known))
          return { status: 304, headers: new Map([['etag', known]]), body: '' };
        const signed = await asNotOffered(async () => await deps.catalogs.signedVersions(catalogId, itemId.data));
        return jsonResponse(signed, 200, { etag: `"${String(signed.versions.revision)}"` });
      },
    },
    {
      method: 'GET',
      path: '/v1/shared/catalogs/:catalogId/items/:itemId/:version',
      needs: 'unlocked',
      handle: async context => {
        const catalogId = requireCatalog(context, context.params.get('catalogId'));
        const itemId = SharedCatalogItemIdSchema.safeParse(decodeParameter(context.params.get('itemId') ?? ''));
        const version = context.params.get('version') ?? '';
        if (!itemId.success || !ITEM_VERSION.test(version)) throw new ApiError(404, ITEM_NOT_OFFERED, 'item_unknown');
        return jsonResponse(
          await asNotOffered(async () => await deps.catalogs.frozenItem(catalogId, itemId.data, Number(version))),
        );
      },
    },
    { method: 'POST', path: '/v1/shared/redeem', needs: 'unlocked', handle: redeem },
    {
      method: 'DELETE',
      path: '/v1/shared/me/keys/self',
      needs: 'unlocked',
      handle: async ({ access, sessionId }) => {
        // This session carries the request, so it is not closed from under its own answer: the link concludes it.
        const unspare = deps.sessions.spare(sessionId);
        try {
          await deps.members.removeKey(access.memberId, access.keyId);
        } finally {
          unspare();
        }
        await record({
          event: 'catalog.member.key-removed',
          actor: { kind: 'anonymous' },
          subject: access.memberId,
          outcome: 'succeeded',
          detail: { memberLabel: access.label, keyId: access.keyId, by: 'member' },
        });
        return { ...jsonResponse({ keyId: access.keyId }), endsSession: true };
      },
    },
  ];
}
