/**
 * The browser's half of the account model's catalogue and its reviewed changes
 * (docs/design/account-model.md §4, §7): the machine, its components, its profiles with their layer
 * stacks, its runtimes, and the stage-then-apply flow every change goes through.
 *
 * A change is never a document the browser composes. It names ONE intent — add a runtime, edit a
 * component, reorder a profile's layers, sign a login out — and the daemon derives the next setup,
 * previews exactly what applying would write, and holds it until an explicit apply. From off the
 * machine the daemon asks for a passkey step-up, which the carrier answers before it retries once.
 *
 * Every answer is parsed through the shared schema, which has no field a credential could occupy.
 */

import {
  type FleetAccountChange,
  type FleetAccountChangeOutcome,
  FleetAccountChangeOutcomeSchema,
  FleetAccountChangeRequestSchema,
  type FleetAccountChangeView,
  FleetAccountChangeViewSchema,
  type FleetComponentCatalog,
  FleetComponentCatalogSchema,
  type FleetLayeredProfileCatalog,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineView,
  FleetMachineViewSchema,
  type FleetProfileDraftRequest,
  FleetProfileDraftRequestSchema,
  type FleetProfileDraftView,
  FleetProfileDraftViewSchema,
  type FleetProposalApplyRequest,
  FleetProposalApplyRequestSchema,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_MACHINE_PATH = '/v1/fleet/machine';
export const FLEET_COMPONENTS_PATH = '/v1/fleet/components';
export const FLEET_PROFILES_PATH = '/v1/fleet/profiles';
export const FLEET_RUNTIMES_PATH = '/v1/fleet/runtimes';
export const FLEET_PROPOSALS_PATH = '/v1/fleet/proposals';
export const FLEET_PROFILE_DRAFT_PATH = '/v1/fleet/profiles/preview';

/** Agent permissions, the tools installed, whether it is set up, and what this caller may change. */
export const readFleetMachine = async (client: FleetClient): Promise<FleetMachineView> =>
  await client.request(FLEET_MACHINE_PATH, FleetMachineViewSchema);

/** The six kinds, each component with its badges and "used by". */
export const readFleetComponents = async (client: FleetClient): Promise<FleetComponentCatalog> =>
  await client.request(FLEET_COMPONENTS_PATH, FleetComponentCatalogSchema);

/** Every profile with its layers, its stack per harness and its conflicts. */
export const readFleetProfiles = async (client: FleetClient): Promise<FleetLayeredProfileCatalog> =>
  await client.request(FLEET_PROFILES_PATH, FleetLayeredProfileCatalogSchema);

/** Each runtime with its resolved stack, model set, fixed layer and whether it can launch. */
export const readFleetRuntimes = async (client: FleetClient): Promise<FleetRuntimeCatalog> =>
  await client.request(FLEET_RUNTIMES_PATH, FleetRuntimeCatalogSchema);

/** Stage one change. Nothing is written: the answer is the preview a person approves. */
export const stageFleetChange = async (
  client: FleetClient,
  change: FleetAccountChange,
): Promise<FleetAccountChangeView> =>
  await client.request(FLEET_PROPOSALS_PATH, FleetAccountChangeViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(FleetAccountChangeRequestSchema.parse({ change })),
  });

/** One staged change, read back. */
export const readFleetChange = async (client: FleetClient, changeId: string): Promise<FleetAccountChangeView> =>
  await client.request(`${FLEET_PROPOSALS_PATH}/${encodeURIComponent(changeId)}`, FleetAccountChangeViewSchema);

/** Apply exactly the change that was previewed. */
export const applyFleetChange = async (
  client: FleetClient,
  changeId: string,
  request: FleetProposalApplyRequest = {},
): Promise<FleetAccountChangeOutcome> =>
  await client.request(
    `${FLEET_PROPOSALS_PATH}/${encodeURIComponent(changeId)}/apply`,
    FleetAccountChangeOutcomeSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FleetProposalApplyRequestSchema.parse(request)),
    },
  );

/**
 * A profile's layers before it is named or saved, resolved per harness exactly as a saved one is, with
 * the conflicts they would have. Writes nothing.
 */
export const previewFleetProfileDraft = async (
  client: FleetClient,
  request: FleetProfileDraftRequest,
): Promise<FleetProfileDraftView> =>
  await client.request(FLEET_PROFILE_DRAFT_PATH, FleetProfileDraftViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(FleetProfileDraftRequestSchema.parse(request)),
  });
