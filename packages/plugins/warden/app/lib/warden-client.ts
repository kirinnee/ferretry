/**
 * The Warden's routes as the UI calls them, over the one generated plugin client (`client.call`). One method per
 * route of the manifest; every answer is typed with the wire shapes of `../wire.ts`. The report is the one text
 * answer. Nothing here reads a secret value: the routes' bodies are masked by the host.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import type {
  WardenAgendaView,
  WardenConfigPatch,
  WardenConfigView,
  WardenInvestigateRequest,
  WardenInvestigateView,
  WardenLeaveRequest,
  WardenLeaveView,
  WardenRunView,
  WardenStatusView,
  WardenVerdict,
} from '../wire.ts';

/** The answer to `PATCH /v1/warden/config`: the effective settings, and the sentences of any edit held for the owner. */
export interface WardenConfigSaved extends WardenConfigView {
  readonly held?: readonly string[];
}

export interface WardenClient {
  status(): Promise<WardenStatusView>;
  verdicts(): Promise<readonly WardenVerdict[]>;
  /** The markdown of one investigation's report. */
  report(reportPath: string): Promise<string>;
  agenda(): Promise<WardenAgendaView>;
  /** One sweep; `spawn` also starts a warden for what it finds. */
  run(spawn?: boolean): Promise<WardenRunView>;
  investigate(request: WardenInvestigateRequest): Promise<WardenInvestigateView>;
  leave(request: WardenLeaveRequest): Promise<WardenLeaveView>;
  config(): Promise<WardenConfigView>;
  updateConfig(patch: WardenConfigPatch): Promise<WardenConfigSaved>;
}

/** The Warden client of one daemon, over that daemon's plugin client. */
export const wardenClientOf = (client: PluginClient): WardenClient => ({
  status: () => client.call<WardenStatusView>('GET /v1/warden/status'),
  verdicts: () => client.call<readonly WardenVerdict[]>('GET /v1/warden/verdicts'),
  report: reportPath => client.call<string>('GET /v1/warden/report', { query: { path: reportPath } }),
  agenda: () => client.call<WardenAgendaView>('GET /v1/warden/agenda'),
  run: (spawn = false) => client.call<WardenRunView>('POST /v1/warden/run', { body: { spawn } }),
  investigate: request => client.call<WardenInvestigateView>('POST /v1/warden/investigate', { body: request }),
  leave: request => client.call<WardenLeaveView>('POST /v1/warden/leave', { body: request }),
  config: () => client.call<WardenConfigView>('GET /v1/warden/config'),
  updateConfig: patch => client.call<WardenConfigSaved>('PATCH /v1/warden/config', { body: patch }),
});
