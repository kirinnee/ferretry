/**
 * The routes a browser reads this machine's credentials through, and presses **Check now** on
 * (docs/design/account-model.md §7).
 *
 * ## The list is `fleet.use`; Check now is `fleet.configure`
 *
 * The list is a read: the local store and the last-known heads, nothing launched and no provider
 * called. What it discloses — whether each login works, how spent it is, which runtimes use it — is the
 * class of fact the account roster already gives any caller with `fleet.use`.
 *
 * Check now is governed like a sign-in, not like a read, and that is the design's §8.2.2 taken at its
 * word: for Codex it is a REFRESH, which rotates a single-use token, and a refresh the provider refuses
 * leaves the login needing a person. So a caller off this machine needs `fleet.configure` and so a live
 * passkey step-up, exactly as `POST /v1/fleet/login` and `POST /v1/fleet/renew` do — one
 * rule for every act that can rewrite a credential on the host. Claude's Check now is only a free read,
 * and it sits on the same gate anyway so the button means one thing.
 *
 * ## `noStore` on both
 *
 * A status is a statement about now. A cached one shows a person a word that has since changed.
 *
 * Sign-out and labels are not here: they change the machine's setup, so they are reviewed changes
 * (`POST /v1/fleet/proposals`), and the list carries the consequence sentence a confirm card shows.
 */
import {
  FleetCredentialCheckRequestSchema,
  FleetCredentialListSchema,
  FleetCredentialTestRequestSchema,
  FleetCredentialTestResultSchema,
  FleetCredentialViewSchema,
  FleetProviderPresetCatalogSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { FleetCredentialRefusal, type FleetCredentialsService } from '../../fleet/credentials-service.ts';

/** Credentials: status, usage, Check now, Test. Narrowed to the calls the routes make. */
export type FleetCredentialsSubsystem = Pick<FleetCredentialsService, 'list' | 'check' | 'test' | 'presets'>;

/** `404` for a login that does not exist, `409` for every other refusal, as the fleet's own answer. */
function refusal(error: FleetCredentialRefusal): ApiError {
  return new ApiError(error.code === 'fleet_credential_unknown' ? 404 : 409, error.message, error.code);
}

async function answer(work: () => Promise<unknown>, parse: (value: unknown) => unknown): Promise<ApiResponse> {
  try {
    return jsonResponse(parse(await work()));
  } catch (error) {
    if (error instanceof FleetCredentialRefusal) throw refusal(error);
    throw error;
  }
}

function credentialId(context: RouteContext): string {
  const id = decodeParameter(context.params.get('credentialId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the login id in the path is not usable', 'bad_request');
  return id;
}

/** This subsystem's route table. */
export function fleetCredentialRoutes(subsystem: FleetCredentialsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/credentials',
      neverCompress: true,
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () =>
        await answer(
          () => subsystem.list(),
          value => FleetCredentialListSchema.parse(value),
        ),
    },
    {
      method: 'POST',
      path: '/v1/fleet/credentials/:credentialId/check',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        await answer(
          async () => {
            // An empty strict body: a field an older client still sends is refused, not ignored.
            await parseBody(context.request, FleetCredentialCheckRequestSchema);
            return await subsystem.check(credentialId(context), context.governance);
          },
          value => FleetCredentialViewSchema.parse(value),
        ),
    },
    {
      // Test is Check now's twin for an environment login: it spends the operator's key once, so it is
      // governed the same way — `fleet.configure`, and a passkey step-up off this machine.
      method: 'POST',
      path: '/v1/fleet/credentials/:credentialId/test',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        await answer(
          async () => {
            const body = await parseBody(context.request, FleetCredentialTestRequestSchema);
            return await subsystem.test(
              credentialId(context),
              { allowInference: body.allowInference === true },
              context.governance,
            );
          },
          value => FleetCredentialTestResultSchema.parse(value),
        ),
    },
    {
      // The provider presets an environment login is made from (docs/provider-presets.md). A preset
      // names secrets only by the name they are suggested to be kept under, so it is a `fleet.use` read.
      method: 'GET',
      path: '/v1/fleet/presets',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      handle: async () => jsonResponse(FleetProviderPresetCatalogSchema.parse(await subsystem.presets())),
    },
  ];
}
