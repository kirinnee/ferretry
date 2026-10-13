/**
 * The browser's half of the account model's catalogue and its reviewed changes
 * (docs/design/account-model.md §4, §7): the machine, its components, its profiles with their layer
 * stacks, its runtimes, and the stage-then-apply flow every change goes through.
 *
 * A change is never a document the browser composes. It names ONE intent — add a runtime, edit a
 * component, reorder a profile's layers, sign a login out — and the daemon derives the next setup,
 * previews exactly what applying would write, and holds it until an explicit apply. From off the
 * machine the apply carries the operator password for that one change.
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
  type FleetProposalApplyRequest,
  FleetProposalApplyRequestSchema,
  type FleetRuntimeCatalog,
  FleetRuntimeCatalogSchema,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-api.ts';

export const FLEET_MACHINE_PATH = '/v1/fleet/machine';
export const FLEET_COMPONENTS_PATH = '/v1/fleet/components';
export const FLEET_PROFILE_STACKS_PATH = '/v1/fleet/profile-stacks';
export const FLEET_RUNTIMES_PATH = '/v1/fleet/runtimes';
export const FLEET_CHANGES_PATH = '/v1/fleet/changes';

const unlockHeaders = (unlock: string | undefined): Record<string, string> =>
  unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock };

/** Agent permissions, the tools installed, whether it is set up, and whether it accepts changes yet. */
export const readFleetMachine = async (client: FleetClient, unlock?: string): Promise<FleetMachineView> =>
  await client.request(FLEET_MACHINE_PATH, FleetMachineViewSchema, { headers: unlockHeaders(unlock) });

/** The six kinds, each component with its badges and "used by". */
export const readFleetComponents = async (client: FleetClient, unlock?: string): Promise<FleetComponentCatalog> =>
  await client.request(FLEET_COMPONENTS_PATH, FleetComponentCatalogSchema, { headers: unlockHeaders(unlock) });

/** Every profile with its layers, its stack per harness and its conflicts. */
export const readFleetProfileStacks = async (
  client: FleetClient,
  unlock?: string,
): Promise<FleetLayeredProfileCatalog> =>
  await client.request(FLEET_PROFILE_STACKS_PATH, FleetLayeredProfileCatalogSchema, {
    headers: unlockHeaders(unlock),
  });

/** Each runtime with its resolved stack, model set, fixed layer and whether it can launch. */
export const readFleetRuntimes = async (client: FleetClient, unlock?: string): Promise<FleetRuntimeCatalog> =>
  await client.request(FLEET_RUNTIMES_PATH, FleetRuntimeCatalogSchema, { headers: unlockHeaders(unlock) });

/** Stage one change. Nothing is written: the answer is the preview a person approves. */
export const stageFleetChange = async (
  client: FleetClient,
  change: FleetAccountChange,
  unlock?: string,
): Promise<FleetAccountChangeView> =>
  await client.request(FLEET_CHANGES_PATH, FleetAccountChangeViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
    body: JSON.stringify(FleetAccountChangeRequestSchema.parse({ change })),
  });

/** One staged change, read back. */
export const readFleetChange = async (
  client: FleetClient,
  changeId: string,
  unlock?: string,
): Promise<FleetAccountChangeView> =>
  await client.request(`${FLEET_CHANGES_PATH}/${encodeURIComponent(changeId)}`, FleetAccountChangeViewSchema, {
    headers: unlockHeaders(unlock),
  });

/**
 * Apply exactly the change that was previewed. From off the machine it needs the unlock in the
 * header and the operator password for this one change.
 */
export const applyFleetChange = async (
  client: FleetClient,
  changeId: string,
  request: FleetProposalApplyRequest = {},
  unlock?: string,
): Promise<FleetAccountChangeOutcome> =>
  await client.request(
    `${FLEET_CHANGES_PATH}/${encodeURIComponent(changeId)}/apply`,
    FleetAccountChangeOutcomeSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
      body: JSON.stringify(FleetProposalApplyRequestSchema.parse(request)),
    },
  );
