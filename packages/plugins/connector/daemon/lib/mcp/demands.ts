/**
 * What the OPERATOR must have agreed for each tool to run — the one table.
 *
 * A connector grant is the owner's authority (docs/mcp-connector.md), but the operator's daemon-wide capability grants
 * (docs/grants.md) only ever NARROW: if remote fleet access is switched off for this machine, a phone with a passkey
 * cannot do it, and neither can Claude on the owner's behalf. So before EVERY tool call the daemon-wide grants are read
 * afresh (never cached across calls) and the tool's demand is checked. `tools/list` still lists every tool the token's
 * SCOPES allow; the refusal is per call, in words. Gate refuses the same things at the route (the delegated principal is
 * governed by the same grants); this table is only there so the refusal is a spoken sentence, and comes first.
 *
 * HOW THE TABLE WAS BUILT (re-derived from the 5.0 route descriptors, not copied from v4's):
 *
 * | route                                                    | declared capability                          |
 * | -------------------------------------------------------- | -------------------------------------------- |
 * | GET  /v1/ferrets, /v1/ferrets/:ferretId, …/logs          | fleet.use                                    |
 * | POST /v1/ferrets/:ferretId/send, …/stop                  | fleet.use                                    |
 * | POST /v1/restarts                                        | fleet.configure                              |
 * | POST /v1/ferrets (start)                                 | fleet.configure (`promptsAsUse`)             |
 * | GET  /v1/projects                                        | none                                         |
 * | GET  /v1/agenda/open, GET|POST /v1/machine/agenda        | none (`caller: person`: the owner's own)     |
 * | POST /v1/ferrets/:ferretId/agenda                        | none (gated by who acts)                     |
 *
 * v4 had every tool at `fleet.use`. The connector principal passes the new `configure` demands as the owner's authority,
 * because no step-up or fresh proof is demanded of it (U2): parity, not a widening — and it is narrowed by the
 * daemon-wide grants exactly as in v4.
 */
import type { CapabilityGrants, CapabilityName } from '@ferretry/core-gate/contract';
import type { CapabilityAxis } from '@ferretry/kernel/contract';

export const CONNECTOR_TOOL_NAMES = [
  'list_ferrets',
  'get_ferret',
  'get_ferret_output',
  'list_attention',
  'get_attention',
  'send_to_ferret',
  'answer_attention',
  'snooze_attention',
  'restart_ferret',
  'stop_ferret',
  'spawn_ferret',
] as const;
export type ConnectorToolName = (typeof CONNECTOR_TOOL_NAMES)[number];

export interface ToolDemand {
  readonly capability: CapabilityName;
  readonly axis: CapabilityAxis;
}

const FLEET_USE: ToolDemand = { capability: 'fleet', axis: 'use' };
const FLEET_CONFIGURE: ToolDemand = { capability: 'fleet', axis: 'configure' };

export const TOOL_DEMANDS: Readonly<Record<ConnectorToolName, readonly ToolDemand[]>> = {
  list_ferrets: [FLEET_USE],
  get_ferret: [FLEET_USE],
  get_ferret_output: [FLEET_USE],
  list_attention: [FLEET_USE],
  get_attention: [FLEET_USE],
  send_to_ferret: [FLEET_USE],
  answer_attention: [FLEET_USE],
  snooze_attention: [FLEET_USE],
  restart_ferret: [FLEET_USE, FLEET_CONFIGURE],
  stop_ferret: [FLEET_USE],
  spawn_ferret: [FLEET_USE, FLEET_CONFIGURE],
};

export const UNDETERMINED_SENTENCE =
  'This machine cannot say what remote callers may do right now, so the connector is refusing.';

const WORDS: Readonly<Record<CapabilityName, string>> = {
  fleet: 'fleet',
  terminal: 'terminal',
  browser: 'browser',
  filesystem: 'file',
  warden: 'warden',
  pairing: 'pairing',
  secrets: 'secrets',
  sharing: 'sharing',
  voice: 'voice',
};

/** The sentence that refuses, or undefined when the operator's grants allow every demand. `fleet.use` is checked first. */
export function daemonGrantRefusal(tool: ConnectorToolName, grants: CapabilityGrants | undefined): string | undefined {
  if (grants === undefined) return UNDETERMINED_SENTENCE;
  for (const demand of [FLEET_USE, ...TOOL_DEMANDS[tool]]) {
    if (grants[demand.capability][demand.axis] === true) continue;
    const label = `${demand.capability}.${demand.axis}`;
    return demand.capability === 'fleet' && demand.axis === 'use'
      ? `The machine owner has turned off remote fleet access (${label}).`
      : `The machine owner has turned off remote ${WORDS[demand.capability]} access (${label}), which this needs.`;
  }
  return undefined;
}
