/**
 * The `fleetLogin` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * Every route is a person's, behind `fleet.configure`; starting, answering and ending a sign-in each have a rule in
 * the module's `contributes.audit`, so nothing here is left unrecorded.
 */
export const callers: readonly string[] = [
  'DELETE /v1/fleet/login/:flowId operator person',
  'GET /v1/fleet/login/:flowId operator person',
  'POST /v1/fleet/login operator person',
  'POST /v1/fleet/login/:flowId operator person',
];

export const notAudited: Readonly<Record<string, string>> = {};
