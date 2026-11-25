/**
 * What the OPERATOR must have agreed for each tool to run — the one table.
 *
 * A connector grant is the owner's authority (docs/mcp-connector.md), but the operator's daemon-wide
 * capability grants (docs/grants.md) only ever NARROW: if remote fleet access is switched off for this
 * machine, a phone with a passkey cannot do it, and neither can Claude on the owner's behalf. So before
 * EVERY tool call the daemon-wide grants are read afresh (never cached across calls) and the tool's demand is
 * checked. `tools/list` still lists every tool the token's SCOPES allow; the refusal is per call, in words.
 *
 * HOW THE TABLE WAS BUILT. Every tool demands `fleet.use` (they all act on the fleet). On top of that, each
 * tool demands what the routes it calls DECLARE (`capability` on the route in `runtime/mounts/*`):
 *
 * | route                                         | declared capability                      |
 * | --------------------------------------------- | ---------------------------------------- |
 * | GET  /v1/sessions, /v1/sessions/:id           | none                                     |
 * | GET  /v1/sessions/:id/logs                    | none (not terminal.use: it reads the     |
 * |                                               | scrubbed transcript, not the live pane)  |
 * | POST /v1/sessions/:id/send, /stop             | none                                     |
 * | POST /v1/restarts                             | none                                     |
 * | GET/POST /v1/sessions/:id/agenda, /agenda/open| none (gated by who acts; get_attention  |
 * |                                               | only reads /agenda/open and /sessions)   |
 * | GET  /v1/projects                             | none                                     |
 * | POST /v1/sessions (start)                     | none for a registered project and no     |
 * |                                               | harness flags — the only start this      |
 * |                                               | connector makes. (A start with flags or  |
 * |                                               | outside a project is `terminal.use`, and |
 * |                                               | the tool cannot express one.)            |
 *
 * So today the table is `fleet.use` throughout. It is a table, not a constant, so that a route gaining a
 * declaration is a one-line change here with a test that says what it now demands.
 */

import type { CapabilityAxis, CapabilityGrants, DaemonCapability } from '@ferretry/protocol';

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
  readonly capability: DaemonCapability;
  readonly axis: CapabilityAxis;
}

const FLEET_USE: ToolDemand = { capability: 'fleet', axis: 'use' };

export const TOOL_DEMANDS: Readonly<Record<ConnectorToolName, readonly ToolDemand[]>> = {
  list_ferrets: [FLEET_USE],
  get_ferret: [FLEET_USE],
  get_ferret_output: [FLEET_USE],
  list_attention: [FLEET_USE],
  get_attention: [FLEET_USE],
  send_to_ferret: [FLEET_USE],
  answer_attention: [FLEET_USE],
  snooze_attention: [FLEET_USE],
  restart_ferret: [FLEET_USE],
  stop_ferret: [FLEET_USE],
  spawn_ferret: [FLEET_USE],
};

export const UNDETERMINED_SENTENCE =
  'This machine cannot say what remote callers may do right now, so the connector is refusing.';

const WORDS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'fleet',
  terminal: 'terminal',
  browser: 'browser',
  filesystem: 'file',
  warden: 'warden',
  pairing: 'pairing',
  secrets: 'secrets',
  sharing: 'sharing',
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
