/**
 * The routes a browser reads the account model's catalogue through, and stages and applies every
 * change to it (docs/design/account-model.md §4, §7). The service is `fleet/catalog-service.ts`.
 *
 * ## Reads are `fleet.use`; every change is `fleet.configure`
 *
 * The four reads, and the draft-profile preview (a read with a body that writes nothing), disclose the same class of fact the account roster already gives a caller with
 * `fleet.use`: component names and files, profile layers, runtime names and whether each can launch.
 * No value a credential could occupy travels — an environment entry that looks like a secret is
 * reported as hidden.
 *
 * Staging a change is `fleet.configure` too, not `use`: a staged change holds a materialised plan for
 * this machine, and the design governs the whole proposal flow as configuration (§7). A caller off this
 * host makes either only behind the passkey step-up.
 *
 * The machine read also says what THIS caller may do (its `authority`): it reads the caller's
 * governance, so a device that has stepped up reads the authority the step-up gives it.
 *
 * ## `noStore` on all eight
 *
 * Every answer is a statement about now: a runtime that can launch, a change that is still pending.
 */
import {
  FleetAccountChangeOutcomeSchema,
  FleetAccountChangeRequestSchema,
  FleetAccountChangeViewSchema,
  FleetComponentCatalogSchema,
  FleetLayeredProfileCatalogSchema,
  FleetMachineViewSchema,
  FleetProfileDraftRequestSchema,
  FleetProfileDraftViewSchema,
  FleetProposalApplyRequestSchema,
  FleetRuntimeCatalogSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  FleetCatalogService,
  type FleetCatalogServiceDeps,
} from '../../fleet/catalog-service.ts';

/** The machine, its components, profiles and runtimes, and every change to them. */
export type FleetCatalogSubsystem = Pick<
  FleetCatalogService,
  'machine' | 'components' | 'profiles' | 'previewProfile' | 'runtimes' | 'propose' | 'read' | 'apply'
>;

/** The largest change body: a component's text and its fields, with room for the envelope. */
const MAX_CHANGE_BODY_BYTES = 512 * 1024;

/** `404` for a change that does not exist; `409` for every other refusal, as the fleet's own answer. */
function refusal(error: FleetCatalogRefusal): ApiError {
  return new ApiError(error.code === 'fleet_change_unknown' ? 404 : 409, error.message, error.code);
}

async function answer<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>): Promise<ApiResponse> {
  try {
    return jsonResponse(schema.parse(await work()));
  } catch (error) {
    if (error instanceof FleetCatalogRefusal) throw refusal(error);
    throw error;
  }
}

function proposalId(context: RouteContext): string {
  const id = decodeParameter(context.params.get('proposalId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the change id in the path is not usable', 'bad_request');
  return id;
}

const USE = { capability: 'fleet', axis: 'use' } as const;
const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/** This subsystem's route table. */
export function fleetCatalogRoutes(subsystem: FleetCatalogSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/machine',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => await answer(FleetMachineViewSchema, () => subsystem.machine(context.governance)),
    },
    {
      method: 'GET',
      path: '/v1/fleet/components',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => await answer(FleetComponentCatalogSchema, () => subsystem.components()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/profiles',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => await answer(FleetLayeredProfileCatalogSchema, () => subsystem.profiles()),
    },
    {
      // A read with a body: it resolves a draft and writes nothing, so it is `use`.
      method: 'POST',
      path: '/v1/fleet/profiles/preview',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetProfileDraftRequestSchema);
        return await answer(FleetProfileDraftViewSchema, () => subsystem.previewProfile(request));
      },
    },
    {
      method: 'GET',
      path: '/v1/fleet/runtimes',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => await answer(FleetRuntimeCatalogSchema, () => subsystem.runtimes()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/proposals',
      minimum: 'operator',
      caller: 'any',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetAccountChangeRequestSchema, {
          maxBytes: MAX_CHANGE_BODY_BYTES,
        });
        return await answer(FleetAccountChangeViewSchema, () => subsystem.propose(request.change));
      },
    },
    {
      method: 'GET',
      path: '/v1/fleet/proposals/:proposalId',
      minimum: 'operator',
      caller: 'any',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => await answer(FleetAccountChangeViewSchema, () => subsystem.read(proposalId(context))),
    },
    {
      method: 'POST',
      path: '/v1/fleet/proposals/:proposalId/apply',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        // An empty strict body: a field an older client still sends is refused, not ignored.
        await parseOptionalBody(context.request, FleetProposalApplyRequestSchema);
        try {
          return await answer(FleetAccountChangeOutcomeSchema, () =>
            subsystem.apply(proposalId(context), context.governance, {
              presentation: context.presentation,
              spend: () => context.spendFreshStepUp?.(),
              agent: isAgentCaller(context),
            }),
          );
        } catch (error) {
          if (error instanceof FleetCatalogFreshStepUpRequired) return freshStepUpRefusal(error.message);
          throw error;
        }
      },
    },
  ];
}

/**
 * "What agents may control" turned back on from a device that has not JUST proved a passkey for it —
 * the same `403 grant_step_up_required` shape minting a pairing code and widening a device answer
 * with, naming this act instead so the prompt says what it is confirming.
 */
function freshStepUpRefusal(message: string): ApiResponse {
  return jsonResponse(
    {
      error: message,
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...CONFIGURE, act: STEP_UP_ACTS.enableAgentControl },
    } satisfies StepUpRequiredBody,
    403,
  );
}

/** Builds the catalog subsystem the composition root mounts. */
export function createFleetCatalogSubsystem(deps: FleetCatalogServiceDeps): FleetCatalogSubsystem {
  return new FleetCatalogService(deps);
}
