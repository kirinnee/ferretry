/**
 * The configuration files over HTTP (docs/config-files.md): what is in effect and what is wrong
 * (`GET /v1/config/status`), one file (`GET /v1/config/file`), an edit (`PUT /v1/config/file`), the
 * owner's confirmation of an edit that loosens (`POST /v1/config/confirm`), and the agent's `config.*`
 * tools (`POST /v1/agent/config`).
 *
 * ## Grants by file kind
 *
 * Every route reaches the boundary as `fleet.use`, and the handler then asks for the FILE's own
 * capability — `warden` for `warden.yaml`, `fleet` for everything else — on the axis the act needs:
 * reading is `use`, writing and confirming are `configure`. A remote caller is held to the passkey
 * step-up the grants ask for, exactly as the fleet's own reviewed changes are.
 *
 * ## Loosening is confirmed where it can be proved
 *
 * An edit that loosens spend or authority is put into effect at once only for a caller who could
 * confirm it in the same act: somebody at this machine, or a remote device that proved a passkey FOR
 * THIS ACT (`loosen-config`). Anyone else's loosening is written and HELD — the tighter version stays in
 * effect — until it is confirmed. An agent never confirms: not through these routes, and not through
 * its own tools.
 *
 * ## The agent's route
 *
 * `POST /v1/agent/config` is authenticated by the session credential alone, served only over a
 * privileged loopback carrier, and refused unless "What agents may control › Ferretry settings" is on —
 * off by default. Even on, an agent's write that loosens is held. The switch is a kill switch; the
 * confirmation is the guard (docs/config-files.md).
 *
 * `noStore` on all five: every answer is a statement about now.
 */
import {
  type AgentConfigToolCall,
  AgentConfigToolCallSchema,
  type AgentConfigToolResult,
  CONFIG_FILE_MAX_BYTES,
  CONFIG_IF_MATCH_HEADER,
  CONFIG_INVALID_CODE,
  ConfigConfirmRequestSchema,
  type ConfigConfirmResult,
  type ConfigFileAddress,
  ConfigFilePathSchema,
  ConfigFilePutRequestSchema,
  type ConfigFilePutResult,
  type ConfigInvalidBody,
  type ConfigIssue,
  classifyConfigPath,
  configFileCapability,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { controlRefusal } from '../../agent-tools/policy.ts';
import type { AgentIdentityResolver } from '../../agent-tools/types.ts';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { grantRefusalCode } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, headerValue, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { ConfigFileConflictError, ConfigFileInvalidError, type ConfigFilesService } from '../../config-files/index.ts';
import type { AgentControlPolicy } from '../../fleet/agent-control.ts';
import { presentedSessionCapability, TWO_SESSION_CREDENTIALS } from './agent-tools.ts';

/** The configuration files as these routes need them, and the loop the composition root arms. */
export interface ConfigFilesSubsystem {
  readonly service: Pick<ConfigFilesService, 'status' | 'file' | 'write' | 'validate' | 'confirm' | 'discard'>;
  /** "What agents may control", read fresh for every agent call. */
  readonly agentControl: AgentControlPolicy;
  readonly identities: AgentIdentityResolver;
  /** Load once, publish the editors' schemas, and start the watcher. Answers the stop. */
  arm(): Promise<() => void>;
}

/** The largest edit body: the largest file, and room for the envelope. */
const MAX_PUT_BODY_BYTES = CONFIG_FILE_MAX_BYTES * 2;

const USE = { capability: 'fleet', axis: 'use' } as const;

function addressOf(path: string): ConfigFileAddress {
  // Already checked by `ConfigFilePathSchema`; a path that does not classify never reaches here.
  return classifyConfigPath(path) as ConfigFileAddress;
}

/** The `403 grant_step_up_required` body, naming the act when it is one confirmed on its own. */
function stepUpRefusal(
  message: string,
  capability: 'fleet' | 'warden',
  act?: typeof STEP_UP_ACTS.loosenConfig,
): ApiResponse {
  return jsonResponse(
    {
      error: message,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability, axis: 'configure', ...(act === undefined ? {} : { act }) },
    } satisfies StepUpRequiredBody,
    403,
  );
}

/**
 * Whether this caller may act on the file on `axis`, as the operator's grants decide for the file's
 * own capability. Answers a refusal response, or `undefined` when allowed.
 */
function refusedFor(context: RouteContext, path: string, axis: 'use' | 'configure'): ApiResponse | undefined {
  const capability = configFileCapability(addressOf(path));
  const governance = context.governance;
  if (governance === undefined) {
    return jsonResponse(
      { error: 'this daemon cannot say whether this caller may change its configuration', code: 'forbidden' },
      403,
    );
  }
  const decision = governance.decide({ capability, axis });
  if (decision.allowed) return undefined;
  if (decision.refusal === 'step-up-required') {
    return stepUpRefusal(`changing ${path} from this device needs a passkey confirmation`, capability);
  }
  return jsonResponse(
    {
      error: `this device may not ${axis === 'use' ? 'read' : 'change'} ${path}`,
      code: grantRefusalCode(decision.refusal),
    },
    403,
  );
}

function invalid(issues: readonly ConfigIssue[]): ApiResponse {
  const errors = issues.filter(issue => issue.severity === 'error');
  return jsonResponse(
    {
      error: `the file does not check (${String(errors.length)} ${errors.length === 1 ? 'problem' : 'problems'}); nothing was written`,
      code: CONFIG_INVALID_CODE,
      issues: [...issues],
    } satisfies ConfigInvalidBody,
    422,
  );
}

function pathOf(context: RouteContext): string {
  const parsed = ConfigFilePathSchema.safeParse(queryValue(context.request, 'path') ?? '');
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'no file named', 'bad_request');
  return parsed.data;
}

async function put(subsystem: ConfigFilesSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, ConfigFilePutRequestSchema, { maxBytes: MAX_PUT_BODY_BYTES });
  const refused = refusedFor(context, request.path, 'configure');
  if (refused !== undefined) return refused;
  const agent = isAgentCaller(context);
  if (agent && !(await subsystem.agentControl.allows('settings'))) {
    throw new ApiError(403, controlRefusal('settings'), 'agent_control_off');
  }
  const fresh = context.presentation?.freshStepUp === true;
  // At this machine, or with a passkey proved for this act. Never for an agent.
  const mayLoosen = !agent && (context.governance?.governed === false || fresh);
  try {
    const written = await subsystem.service.write(
      request.path,
      request.text,
      headerValue(context.request, CONFIG_IF_MATCH_HEADER),
      mayLoosen,
    );
    if (written.loosened && context.governance?.governed === true) context.spendFreshStepUp?.();
    return jsonResponse({
      path: request.path,
      etag: written.etag,
      outcome: written.outcome,
      ...(written.pending === undefined ? {} : { pending: written.pending }),
    } satisfies ConfigFilePutResult);
  } catch (error) {
    if (error instanceof ConfigFileInvalidError) return invalid(error.issues);
    if (error instanceof ConfigFileConflictError) throw new ApiError(409, error.message, 'config_conflict');
    throw error;
  }
}

/**
 * Whether this caller may act on a HELD edit to `path` as the owner (docs/config-files.md): the file's
 * capability on `configure`, never an agent, and — to put the edit into effect (`act: 'confirm'`) — from a
 * governed device a passkey proved for this act (`loosen-config`). Dropping a held edit (`act: 'discard'`)
 * only tightens, so it asks no more than `configure`. Answers a refusal, or `undefined` when allowed; an
 * agent is refused by throwing. Shared by `POST /v1/config/confirm` and the agenda's Allow
 * (docs/agenda.md § Confirming a configuration change), so both doors keep one rule.
 */
export function heldEditRefusal(
  context: RouteContext,
  path: string,
  act: 'confirm' | 'discard',
): ApiResponse | undefined {
  const refused = refusedFor(context, path, 'configure');
  if (refused !== undefined) return refused;
  if (isAgentCaller(context)) {
    throw new ApiError(403, 'an agent cannot confirm a configuration change; the owner confirms it', 'forbidden');
  }
  if (act === 'confirm' && context.governance?.governed === true && context.presentation?.freshStepUp !== true) {
    return stepUpRefusal(
      `putting this change to ${path} into effect needs a passkey confirmation for it`,
      configFileCapability(addressOf(path)),
      STEP_UP_ACTS.loosenConfig,
    );
  }
  return undefined;
}

/** A confirmation went through: a passkey proved for the act is spent, so it admits exactly this one. */
export function spendHeldEditProof(context: RouteContext): void {
  if (context.governance?.governed === true) context.spendFreshStepUp?.();
}

async function confirm(subsystem: ConfigFilesSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, ConfigConfirmRequestSchema);
  const refused = heldEditRefusal(context, request.path, 'confirm');
  if (refused !== undefined) return refused;
  const confirmed = await subsystem.service.confirm(request.path, request.etag);
  if (confirmed) spendHeldEditProof(context);
  return jsonResponse({ path: request.path, confirmed } satisfies ConfigConfirmResult);
}

/** One `config.*` call, answered as a sentence an agent can act on. Refusals are answers, not errors. */
async function agentTool(subsystem: ConfigFilesSubsystem, call: AgentConfigToolCall): Promise<AgentConfigToolResult> {
  const { service } = subsystem;
  if (call.tool === 'config.read' && call.path === undefined) {
    const status = await service.status();
    const errors = status.issues.filter(issue => issue.severity === 'error').length;
    return {
      summary: `${String(status.files.length)} configuration files in ${status.directory}; ${String(errors)} with errors; ${String(status.pending.length)} waiting for the owner's confirmation.`,
      files: status.files,
      issues: status.issues,
    };
  }
  if (call.tool === 'config.read') {
    const file = await service.file(call.path as string);
    return {
      summary: file.exists
        ? `${file.path} (${file.state}).`
        : `${file.path} does not exist yet; this is the starter a new one begins with.`,
      text: file.text,
      etag: file.etag,
      issues: file.issues,
    };
  }
  if (call.tool === 'config.validate') {
    const issues = await service.validate(call.path, call.text);
    const errors = issues.filter(issue => issue.severity === 'error');
    return {
      summary:
        errors.length === 0
          ? `${call.path} checks.`
          : `${call.path} does not check: ${String(errors.length)} ${errors.length === 1 ? 'problem' : 'problems'}. Fix each and validate again.`,
      issues: [...issues],
    };
  }
  try {
    const written = await service.write(call.path, call.text, call.etag, false);
    return {
      summary:
        written.outcome === 'applied'
          ? `Wrote ${call.path}; it is in effect.`
          : `Wrote ${call.path}, but it loosens what this machine allows (${(written.pending?.changes ?? []).join('; ')}), so it waits for the owner to confirm it; the earlier version stays in effect until then. Tell the owner with a card whose Allow confirms it: fy agenda add "<the ask>" --title "<title>" --context "<the facts around it>" --confirms ${call.path}.`,
      etag: written.etag,
    };
  } catch (error) {
    if (error instanceof ConfigFileInvalidError) {
      return {
        summary: `Nothing was written: ${call.path} does not check. Fix each issue and try again.`,
        issues: [...error.issues],
      };
    }
    if (error instanceof ConfigFileConflictError) {
      return { summary: `Nothing was written: ${error.message}.` };
    }
    throw error;
  }
}

async function agentCall(subsystem: ConfigFilesSubsystem, context: RouteContext): Promise<ApiResponse> {
  // A `fys_` bearer or the older header, exactly as the agent tools take it.
  const presented = presentedSessionCapability(context.request);
  if (presented.kind === 'two-different') throw new ApiError(401, TWO_SESSION_CREDENTIALS, 'unauthorized');
  const capability = presented.kind === 'one' ? presented.capability : '';
  const identity = capability === '' ? undefined : await subsystem.identities.resolve(capability);
  if (identity === undefined) {
    const missing = capability === '';
    const message =
      'the config tools need the session credential Ferretry gives each agent session; run this from inside an agent session';
    throw new ApiError(missing ? 401 : 403, message, missing ? 'missing_capability' : 'forbidden');
  }
  if (!(await subsystem.agentControl.allows('settings'))) {
    throw new ApiError(403, controlRefusal('settings'), 'agent_control_off');
  }
  const call = await parseBody(context.request, AgentConfigToolCallSchema, { maxBytes: MAX_PUT_BODY_BYTES });
  return jsonResponse(await agentTool(subsystem, call));
}

/** This subsystem's route table. */
export function configFilesRoutes(subsystem: ConfigFilesSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/config/status',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => jsonResponse(await subsystem.service.status()),
    },
    {
      method: 'GET',
      path: '/v1/config/file',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => {
        const path = pathOf(context);
        return refusedFor(context, path, 'use') ?? jsonResponse(await subsystem.service.file(path));
      },
    },
    {
      method: 'PUT',
      path: '/v1/config/file',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => await put(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/config/confirm',
      minimum: 'operator',
      caller: 'person',
      capability: USE,
      noStore: true,
      handle: async context => await confirm(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/agent/config',
      minimum: 'none',
      caller: 'any',
      privilegedOnly: true,
      noStore: true,
      handle: async context => await agentCall(subsystem, context),
    },
  ];
}
