import type { InventoryEntry } from '../contract/bound.ts';
import type { ApiRequest } from '../contract/http.ts';
import { ApiError, jsonResponse } from '../contract/http.ts';
import { z } from 'zod';
import type { Health, PluginInventory } from '../contract/kernel.ts';
import { CORE_IDS } from '../contract/ids.ts';
import { PROTOCOL } from '../contract/session.ts';
import type { DoctorReport } from '../contract/doctor.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { RouteHandler } from '../contract/route.ts';
import type { ToolResult } from '../manifest/implement.ts';
import type { SocketAccept } from '../contract/socket.ts';
import { busAccept, type BusSources } from './bus-socket.ts';
import type kernelManifest from '../plugin.ts';

type KernelRouteKey = NonNullable<(typeof kernelManifest)['actions']>['routes'][number]['key'];

export type { InventoryEntry };

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
}

/** The most a tool call's body may be. */
const AGENT_TOOL_BODY_MAX = 1024 * 1024;

/** `POST /v1/agent/tools`: a tool by name and its input. No session, no plugin, no credential field: strict. */
const AgentToolCallSchema = z.strictObject({ tool: z.string().min(1).max(128), input: z.unknown().optional() });

type KernelSocketKey = NonNullable<(typeof kernelManifest)['actions']>['sockets'][number]['key'];

/** The kernel's own sockets: the event bus. */
export function kernelSockets(sources: KernelHalfSources): Readonly<Record<KernelSocketKey, SocketAccept>> {
  return { 'GET /v1/bus': busAccept(sources.bus) };
}

/** The kernel's own routes (§9.6, §1.3). Their descriptors are in `plugin.ts`. */
export function kernelRoutes(sources: KernelHalfSources): Readonly<Record<KernelRouteKey, RouteHandler>> {
  return {
    'GET /v1/health': async () => jsonResponse({ protocol: PROTOCOL, version: sources.version } satisfies Health),
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
