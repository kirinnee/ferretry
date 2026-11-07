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
import { isFerretCall, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  AccountChangeOutcomeSchema,
  AccountChangeRequestSchema,
  AccountChangeViewSchema,
  ComponentCatalogSchema,
  LayeredProfileCatalogSchema,
  MachineViewSchema,
  ProfileDraftRequestSchema,
  ProfileDraftViewSchema,
  ProposalApplyRequestSchema,
  RuntimeCatalogSchema,
} from '../../contract/index.ts';
import {
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  type FleetCatalogService,
} from '../lib/service/catalog-service.ts';
import { parseBody, parseOptionalBody } from './body.ts';

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

function proposalId(params: ReadonlyMap<string, string>): string {
  const id = decodeParameter(params.get('proposalId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the change id in the path is not usable', 'bad_request');
  return id;
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
      demand: { capability: 'fleet', axis: 'configure', act: 'enable-agent-control' },
    } satisfies StepUpRequiredBody,
    403,
  );
}

/**
 * This subsystem's handlers, keyed by the manifest's route keys. Who may call, and what the audit log records, are
 * the manifest's descriptors now; a handler only does the work.
 */
export function fleetCatalogRoutes(subsystem: FleetCatalogSubsystem) {
  return {
    'GET /v1/runtimes/machine': async call => await answer(MachineViewSchema, () => subsystem.machine(call.governance)),
    'GET /v1/runtimes/components': async () => await answer(ComponentCatalogSchema, () => subsystem.components()),
    'GET /v1/runtimes/profiles': async () => await answer(LayeredProfileCatalogSchema, () => subsystem.profiles()),
    // A read with a body: it resolves a draft and writes nothing.
    'POST /v1/runtimes/profiles/preview': async call => {
      const request = await parseBody(call.request, ProfileDraftRequestSchema);
      return await answer(ProfileDraftViewSchema, () => subsystem.previewProfile(request));
    },
    'GET /v1/runtimes': async () => await answer(RuntimeCatalogSchema, () => subsystem.runtimes()),
    'POST /v1/runtimes/proposals': async call => {
      const request = await parseBody(call.request, AccountChangeRequestSchema, { maxBytes: MAX_CHANGE_BODY_BYTES });
      // Staging a clone describes it for THIS caller: a settings document the caller may not write is refused now.
      const caller = {
        governance: call.governance,
        freshStepUp: false,
        agent: isFerretCall(call),
        spend: () => undefined,
      };
      return await answer(AccountChangeViewSchema, () => subsystem.propose(request.change, caller));
    },
    'GET /v1/runtimes/proposals/:proposalId': async call =>
      await answer(AccountChangeViewSchema, () => subsystem.read(proposalId(call.params))),
    'POST /v1/runtimes/proposals/:proposalId/apply': async call => {
      // An empty strict body: a field an older client still sends is refused, not ignored.
      await parseOptionalBody(call.request, ProposalApplyRequestSchema);
      try {
        return await answer(AccountChangeOutcomeSchema, () =>
          subsystem.apply(proposalId(call.params), call.governance, {
            presentation: call.presentation,
            spend: () => call.spendFreshStepUp?.(),
            agent: isFerretCall(call),
          }),
        );
      } catch (error) {
        if (error instanceof FleetCatalogFreshStepUpRequired) return freshStepUpRefusal(error.message);
        throw error;
      }
    },
  } satisfies Record<string, RouteHandler>;
}
