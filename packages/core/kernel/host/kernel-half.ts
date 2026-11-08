import type { InventoryEntry, InventorySurfaces } from '../contract/bound.ts';
import type { ApiRequest } from '../contract/http.ts';
import { ApiError, jsonResponse } from '../contract/http.ts';
import { parseBody } from '../contract/body.ts';
import { z } from 'zod';
import { type Health, type PluginInventory, SESSION_CREDENTIAL_FEATURE } from '../contract/kernel.ts';
import { CORE_IDS } from '../contract/ids.ts';
import { PROTOCOL } from '../contract/session.ts';
import type { DoctorReport } from '../contract/doctor.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { RouteHandler, ScopedRoute } from '../contract/route.ts';
import type { Manifest } from '../manifest/types.ts';
import type { ToolHandler, ToolResult } from '../manifest/implement.ts';
import type { SocketAccept } from '../contract/socket.ts';
import { busAccept, type BusSources } from './bus-socket.ts';
import type kernelManifest from '../plugin.ts';
import { type ConfigRouteSources, configRoutes } from './config/routes.ts';
import { type AgentConfigSources, agentConfig, agentDoorRefusal, configStatusView } from './config/agent.ts';
import {
  AGENT_CONFIG_TOOL_OF,
  AgentConfigCallSchema,
  AgentConfigCallSchemas,
  type AgentConfigCall,
  type AgentConfigToolName,
} from '../contract/agent-config.ts';
import type { AdmissionDecision } from '../contract/bound.ts';

type KernelRouteKey = NonNullable<(typeof kernelManifest)['actions']>['routes'][number]['key'];

export type { InventoryEntry, InventorySurfaces };

/**
 * One plugin's declared surfaces for the inventory projection (§9.6): every route, socket and agent tool, as the
 * descriptor admission reads (method and path dropped). Read from the manifest only, so a plugin that is off still
 * has its declarations (the entry's `on` says whether it serves).
 */
export function inventorySurfacesOf(manifest: Manifest): readonly Omit<ScopedRoute, 'method' | 'path'>[] {
  const scope = ({ method: _method, path: _path, ...rest }: ScopedRoute): Omit<ScopedRoute, 'method' | 'path'> => rest;
  return [
    ...(manifest.actions?.routes ?? []).map(scope),
    ...(manifest.actions?.sockets ?? []).map(scope),
    ...(manifest.actions?.agentTools ?? []),
  ];
}

export interface KernelHalfSources {
  readonly version: string;
  inventory(): readonly InventoryEntry[];
  /** Gate's per-standing projection (§9.6). `undefined` (no Gate, or it threw) = only the five core pieces. */
  project(request: ApiRequest, entries: readonly InventoryEntry[]): readonly InventoryEntry[] | undefined;
  snapshot(): PostBuildSnapshot;
  /** The agent tool door: which plugins declare a tool of this name, and the one call. */
  tools: {
    owners(name: string): readonly string[];
    call(plugin: string, name: string, input: unknown, request: ApiRequest): Promise<ToolResult>;
  };
  /** What `GET /v1/bus` reads. */
  bus: BusSources;
  /** A fresh diagnosis: every plugin's declared checks are run now. */
  doctor(): Promise<DoctorReport>;
  liveness(): { readonly status: 'starting' | 'ok'; readonly uptimeSeconds: number; readonly pid: number };
  /** What the configuration-file routes act through (`./config/routes.ts`). */
  readonly config: ConfigRouteSources;
  /** What the agent's config door acts through (`./config/agent.ts`). */
  readonly agentConfig: AgentConfigSources;
  /** Admits a call to one of the KERNEL's own agent tools by its declaration, as the tool door would (the standing, or Gate's refusal). */
  admitTool(name: string, request: ApiRequest): AdmissionDecision;
  /**
   * Tells Gate about one call to a kernel tool made through `POST /v1/agent/config`, as the tool door tells it
   * (`Admission.recorded`, table `tool`), with the standing `admitTool` gave: the record names the ferret. A call
   * `admitTool` REFUSED (no credential, an unknown or revoked one) is told too, with no standing, as today's audited
   * route recorded every answer of that route: the record then names nobody, only the status. Never the body. Never
   * changes the answer.
   */
  recordTool(
    name: string,
    request: ApiRequest,
    admitted: Extract<AdmissionDecision, { readonly outcome: 'admitted' }> | undefined,
    status: number,
  ): void;
}

/** The most a tool call's body may be. */
const AGENT_TOOL_BODY_MAX = 1024 * 1024;

/** `POST /v1/agent/tools`: a tool by name and its input. No session, no plugin, no credential field: strict. */
const AgentToolCallSchema = z.strictObject({ tool: z.string().min(1).max(128), input: z.unknown().optional() });

type KernelToolName = AgentConfigToolName;

/**
 * The kernel's own agent tools: the three config tools every ferret has (docs/config-files.md). Each runs the same
 * logic as `POST /v1/agent/config`; a refusal of the CALLER (switch off, not a ferret) is the tool's error text.
 */
export function kernelTools(sources: KernelHalfSources): Readonly<Record<KernelToolName, ToolHandler>> {
  const config = agentConfig(sources.agentConfig);
  const handler =
    (name: KernelToolName): ToolHandler =>
    async (call, input) => {
      const parsed = AgentConfigCallSchemas[name].parse(input ?? {});
      const wire = { tool: name.replace('_', '.'), ...parsed } as AgentConfigCall;
      const answer = await config.run(wire, call);
      return { text: JSON.stringify(answer), data: JSON.parse(JSON.stringify(answer)) };
    };
  return {
    config_read: handler('config_read'),
    config_validate: handler('config_validate'),
    config_write: handler('config_write'),
  };
}

type KernelSocketKey = NonNullable<(typeof kernelManifest)['actions']>['sockets'][number]['key'];

/** The kernel's own sockets: the event bus. */
export function kernelSockets(sources: KernelHalfSources): Readonly<Record<KernelSocketKey, SocketAccept>> {
  return { 'GET /v1/bus': busAccept(sources.bus) };
}

/** The kernel's own routes (§9.6, §1.3). Their descriptors are in `plugin.ts`. */
export function kernelRoutes(sources: KernelHalfSources): Readonly<Record<KernelRouteKey, RouteHandler>> {
  return {
    ...configRoutes(sources.config),
    'GET /v1/config/status': async () => jsonResponse(configStatusView(sources.agentConfig)),
    'POST /v1/agent/config': async call => {
      // The route is served without a credential, so the CALLER is admitted before the body is read, whatever the body: no
      // credential, and an unknown or revoked one, are both 401 here (Gate refuses them before this handler; today
      // answered 403 for a presented one). The tool is known only from the body, but the three share
      // one declaration shape (a test pins it), so `config_read`'s declaration admits for all of them.
      const decision = sources.admitTool(AGENT_CONFIG_TOOL_OF['config.read'], call.request);
      // Gate's refusal, with today's code and words for a call that carries no credential (round-2 m-c). Recorded, as
      // today's audited route recorded it (R4 m2): a revoked ferret token still trying the door is what the log is for.
      if (decision.outcome === 'refused') {
        const response = agentDoorRefusal(decision.response);
        sources.recordTool(AGENT_CONFIG_TOOL_OF['config.read'], call.request, undefined, response.status);
        return response;
      }
      // Recorded here, not by the Dispatcher (which admitted the route with no standing): as the tool the body names
      // (`config_read`'s until the body is read), with the standing that admitted the caller (round-3 review N2b).
      let tool: AgentConfigToolName = AGENT_CONFIG_TOOL_OF['config.read'];
      let status = 200;
      try {
        // Then the ferret and the owner's switch, still before the body (today's order: credential, switch, body).
        const door = agentConfig(sources.agentConfig);
        await door.authorize(decision.standing);
        const body = await parseBody(call.request, AgentConfigCallSchema, { maxBytes: 2 * 256 * 1024 });
        tool = AGENT_CONFIG_TOOL_OF[body.tool];
        return jsonResponse(await door.act(body));
      } catch (error) {
        status = error instanceof ApiError ? error.status : 500;
        throw error;
      } finally {
        sources.recordTool(tool, call.request, decision, status);
      }
    },
    // Always lists the session-credential feature: a `fy` from before 5.0 reads its absence as an older daemon and
    // falls back to the admin token after a 401 (see SESSION_CREDENTIAL_FEATURE).
    'GET /v1/health': async () =>
      jsonResponse({
        protocol: PROTOCOL,
        version: sources.version,
        features: [SESSION_CREDENTIAL_FEATURE],
      } satisfies Health),
    'GET /healthz': async () => {
      const live = sources.liveness();
      return jsonResponse(
        { ...live, version: sources.version, protocol: PROTOCOL },
        live.status === 'starting' ? 503 : 200,
      );
    },
    'GET /v1/plugins': async call => {
      const entries = sources.inventory();
      const projected =
        sources.project(call.request, entries) ??
        entries.filter(entry => (CORE_IDS as readonly string[]).includes(entry.id));
      return jsonResponse({
        protocol: PROTOCOL,
        plugins: projected.map(entry => ({ id: entry.id, on: entry.on, contract: entry.contract })),
      } satisfies PluginInventory);
    },
    'POST /v1/agent/tools': async call => {
      const text = await call.request.text();
      if (text.length > AGENT_TOOL_BODY_MAX) throw new ApiError(413, 'the tool call is too large', 'body_too_large');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'the tool call is not JSON', 'invalid_body');
      }
      const parsed = AgentToolCallSchema.safeParse(json);
      if (!parsed.success) throw new ApiError(400, 'the tool call must be { tool, input? }', 'invalid_body');
      const owners = sources.tools.owners(parsed.data.tool);
      if (owners.length === 0) throw new ApiError(404, `there is no tool ${parsed.data.tool}`, 'unknown_tool');
      const owner = owners[0];
      if (owners.length > 1 || owner === undefined)
        throw new ApiError(400, `the tool name ${parsed.data.tool} is ambiguous`, 'ambiguous_tool');
      return jsonResponse(await sources.tools.call(owner, parsed.data.tool, parsed.data.input, call.request));
    },
    'GET /v1/doctor': async () => jsonResponse(await sources.doctor()),
    'GET /v1/glossary': async () =>
      jsonResponse({
        words: sources.snapshot().words.map(word => ({
          word: word.word,
          means: word.means,
          plugin: word.plugin,
          ...(word.insteadOf === undefined ? {} : { insteadOf: [...word.insteadOf] }),
        })),
      }),
  };
}
