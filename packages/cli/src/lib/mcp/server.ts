import {
  AGENT_TOOL_DEFAULT_WAIT_MS,
  AGENT_TOOL_MAX_TOTAL_WAIT_MS,
  type AgentConfigToolCall,
  AgentConfigToolCallSchema,
  type AgentConfigToolResult,
  type AgentLessonToolCall,
  AgentLessonToolCallSchema,
  type AgentLessonToolResult,
  type AgentToolCall,
  AgentToolCallSchema,
  type AgentToolResult,
  type WorkSearchQueryInput,
  type WorkSearchResponse,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { BrowserWait, TerminalWait } from '../agent-tools/client.ts';
import { renderToolResult } from '../agent-tools/controller.ts';
import { instructionsReport, renderInstructionsReport } from '../instructions/report.ts';
import { hitReference, matchLine, renderNoMatch, renderOlderHidden } from '../work-search/render.ts';
import { MCP_CONFIG_TOOLS, MCP_INSTRUCTIONS_TOOL, MCP_LESSON_TOOLS, MCP_SEARCH_TOOLS, MCP_TOOLS } from './tools.ts';

/**
 * THE FERRETRY TOOLS AS AN MCP SERVER — JSON-RPC 2.0 over stdio, written out by hand.
 *
 * The protocol surface a tools-only server needs is small — `initialize`, `ping`, `tools/list`,
 * `tools/call` and the notifications a client sends — so it is implemented here rather than pulled
 * in as a dependency: every byte this server reads is from the agent, and every call it makes goes to
 * the daemon as the agent, so a small surface that is all in view is the property worth having.
 *
 * WHO IT ACTS AS. It holds no authority of its own. Each tool call goes to the daemon's agent route
 * with the session credential the daemon delivered into this agent's environment, and the daemon
 * derives the session from that credential alone (see `docs/agent-tools.md`). Nothing a model puts in
 * a tool's arguments can name another session: the call schema has no field for one.
 *
 * WHAT A FAILURE LOOKS LIKE. A refused or failed tool call is a RESULT with `isError: true` and the
 * daemon's own plain sentence — "A person has taken over %terminal:dev; wait or ask them." — because
 * the model has to read it and act on it. Only a malformed request, an unknown method or an unknown
 * tool is a JSON-RPC error.
 */

/** Newest first; the first is what a client that asks for something else is offered. */
const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** What the server needs from the daemon: one call, and a wait that may span several requests. */
export interface McpToolsPort {
  call(call: AgentToolCall): Promise<AgentToolResult>;
  wait(wait: TerminalWait): Promise<AgentToolResult>;
  /** A `browser.wait_for` that may span several requests, like {@link wait}. */
  browserWait(wait: BrowserWait): Promise<AgentToolResult>;
  /** One `config.*` call, as the agent (docs/config-files.md). */
  config(call: AgentConfigToolCall): Promise<AgentConfigToolResult>;
  /** One `lessons.suggest` call, as the agent (docs/learning.md). */
  lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult>;
  /** One `search_work` call: cards and agenda items by what they say. */
  search(query: WorkSearchQueryInput): Promise<WorkSearchResponse>;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  /**
   * What every agent is told about these tools when it connects (MCP `initialize` instructions): the
   * built-in "Set up Ferretry" skill, so any agent can set the machine up from its files.
   */
  readonly instructions?: string;
  /** The binary's name, as the `instructions` tool's answer names a command to run. */
  readonly binary?: string;
}

type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | {
      readonly jsonrpc: '2.0';
      readonly id: JsonRpcId;
      readonly error: { readonly code: number; readonly message: string };
    };

/** JSON-RPC's own error codes. */
export const JSON_RPC_ERRORS = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
} as const;

const RequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const CallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const InitializeParamsSchema = z.object({ protocolVersion: z.string() }).partial();

const WaitArgumentsSchema = z
  .object({
    name: z.string(),
    text: z.string().min(1).optional(),
    exit: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_TOTAL_WAIT_MS).optional(),
  })
  .strict()
  .refine(
    wait => (wait.text === undefined) !== (wait.exit !== true),
    'give "text" to wait for, or "exit": true — one of them',
  );

/** `browser_wait_for`'s arguments: the wire call, but with a budget that may span several requests. */
const BrowserWaitArgumentsSchema = z.looseObject({
  timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_TOTAL_WAIT_MS).optional(),
});

const failure = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** The first thing a schema refused, said with where it was. */
function refusal(error: z.ZodError): string {
  // A failed parse always carries at least one issue.
  const [issue] = error.issues as [z.core.$ZodIssue];
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;
}

/** A config tool's answer as MCP content: the sentence, the file, then each located problem. */
function configContent(result: AgentConfigToolResult) {
  const parts = [
    result.summary,
    ...(result.etag === undefined ? [] : [`etag: ${result.etag}`]),
    ...(result.files ?? []).map(file => `${file.path} (${file.state})`),
    ...(result.issues ?? []).map(
      issue =>
        `${issue.path}${issue.line === undefined ? '' : `:${String(issue.line)}:${String(issue.column)}`} ${issue.severity}: ${issue.message} — fix: ${issue.fix}`,
    ),
    ...(result.text === undefined ? [] : [result.text]),
  ];
  return { content: [{ type: 'text', text: parts.join('\n') }] };
}

/** A lesson suggestion's answer as MCP content: the daemon's own sentence, verbatim. */
const SearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    kind: z.enum(['task', 'agenda']).optional(),
    open: z.boolean().optional(),
    all: z.boolean().optional(),
  })
  .strict();

/** The hits as the model reads them: one line each — id, kind, standing, title, then the matching line. */
function renderSearch(query: string, kind: 'task' | 'agenda' | undefined, answer: WorkSearchResponse): string {
  const older = renderOlderHidden(answer.olderHidden, 'search_work again with all: true');
  if (answer.hits.length === 0) return [renderNoMatch(query, kind), ...older].join('\n');
  const lines = answer.hits.map(hit => {
    const match = matchLine(hit);
    const owner = hit.kind === 'agenda' ? ` (agenda of ${hit.sessionId})` : '';
    return `${hitReference(hit)} ${hit.kind} [${hit.standing}]${owner} ${hit.title}${match === '' ? '' : ` — ${match}`}`;
  });
  const more =
    answer.total > answer.hits.length
      ? [`(${String(answer.hits.length)} of ${String(answer.total)} shown; narrow it with kind or open)`]
      : [];
  return [...lines, ...more, ...older].join('\n');
}

function lessonContent(result: AgentLessonToolResult) {
  return { content: [{ type: 'text', text: result.summary }] };
}

/** A tool's answer as MCP content: the words, then the picture when there is one. */
function content(result: AgentToolResult) {
  return {
    content: [
      { type: 'text', text: renderToolResult(result) },
      ...(result.screenshotBase64 === undefined
        ? []
        : [
            {
              type: 'image',
              data: result.screenshotBase64,
              mimeType: result.screenshotFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
            },
          ]),
    ],
  };
}

/**
 * The flags the wire takes only as `true` — present means on. A model fills a boolean the tools list
 * declares with `false` as readily as it leaves it out, and both mean "off", so `false` is dropped
 * here rather than refused there.
 */
const ON_ONLY_FLAGS: ReadonlySet<string> = new Set([
  'incognito',
  'double',
  'submit',
  'slowly',
  'boxes',
  'fullPage',
  'reset',
  'overwrite',
  'clear',
]);
/** The same flags one level down, inside an emulation's `media` and `network`. */
const ON_ONLY_NESTED: Readonly<Record<string, readonly string[]>> = { media: ['print'], network: ['offline'] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function withoutUnsetFlags(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key, value]) => !(ON_ONLY_FLAGS.has(key) && value === false))
      .map(([key, value]) => {
        const nested = ON_ONLY_NESTED[key];
        if (nested === undefined || !isRecord(value)) return [key, value];
        return [
          key,
          Object.fromEntries(Object.entries(value).filter(([k, v]) => !(nested.includes(k) && v === false))),
        ];
      }),
  );
}

const toolError = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

export class McpServer {
  constructor(
    private readonly tools: McpToolsPort,
    private readonly info: McpServerInfo,
    /** The launch environment this server inherited from the ferret, which the `instructions` tool reports. */
    private readonly environment: Readonly<Record<string, string | undefined>> = {},
  ) {}

  /**
   * Answers one JSON-RPC message, or nothing for a notification. Never throws: whatever goes wrong is
   * an answer the client can read.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    const parsed = RequestSchema.safeParse(message);
    if (!parsed.success) {
      const id = typeof message === 'object' && message !== null && 'id' in message ? (message.id as JsonRpcId) : null;
      return failure(
        typeof id === 'string' || typeof id === 'number' ? id : null,
        JSON_RPC_ERRORS.invalidRequest,
        'not a JSON-RPC 2.0 request',
      );
    }
    const { id, method, params } = parsed.data;
    // A message with no id is a notification, and a notification is never answered — `initialized`
    // and `cancelled` included. A long call is bounded by its own timeout rather than cancelled.
    if (id === undefined) return undefined;
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: this.initialize(params) };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              ...MCP_TOOLS,
              ...MCP_CONFIG_TOOLS,
              ...MCP_LESSON_TOOLS,
              ...MCP_SEARCH_TOOLS,
              MCP_INSTRUCTIONS_TOOL,
            ].map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        };
      case 'tools/call':
        return await this.call(id, params);
      default:
        return failure(id, JSON_RPC_ERRORS.methodNotFound, `this server has no method ${method}`);
    }
  }

  private initialize(params: unknown) {
    const asked = InitializeParamsSchema.safeParse(params ?? {});
    const requested = asked.success ? asked.data.protocolVersion : undefined;
    const protocolVersion = MCP_PROTOCOL_VERSIONS.find(version => version === requested) ?? MCP_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.info.name, version: this.info.version },
      ...(this.info.instructions === undefined ? {} : { instructions: this.info.instructions }),
    };
  }

  private async call(id: string | number, params: unknown): Promise<JsonRpcResponse> {
    const parsed = CallParamsSchema.safeParse(params);
    if (!parsed.success)
      return failure(id, JSON_RPC_ERRORS.invalidParams, 'tools/call needs a tool name and its arguments');
    const args = parsed.data.arguments ?? {};
    if (parsed.data.name === MCP_INSTRUCTIONS_TOOL.name)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: renderInstructionsReport(instructionsReport(this.environment), this.info.binary ?? this.info.name),
            },
          ],
        },
      };
    const configTool = MCP_CONFIG_TOOLS.find(candidate => candidate.name === parsed.data.name);
    if (configTool !== undefined) return await this.config(id, configTool.configTool, args);
    const lessonTool = MCP_LESSON_TOOLS.find(candidate => candidate.name === parsed.data.name);
    if (lessonTool !== undefined) return await this.lessons(id, lessonTool.lessonTool, args);
    if (MCP_SEARCH_TOOLS.some(candidate => candidate.name === parsed.data.name)) return await this.search(id, args);
    const tool = MCP_TOOLS.find(candidate => candidate.name === parsed.data.name);
    if (tool === undefined) return failure(id, JSON_RPC_ERRORS.invalidParams, `there is no tool ${parsed.data.name}`);
    try {
      if (tool.tool === 'terminal.wait') {
        const wait = WaitArgumentsSchema.safeParse(args);
        if (!wait.success) return { jsonrpc: '2.0', id, result: toolError(refusal(wait.error)) };
        const { name, text, timeoutMs } = wait.data;
        const result = await this.tools.wait({
          name,
          ...(text === undefined ? { exit: true } : { text }),
          totalMs: timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS,
        });
        return { jsonrpc: '2.0', id, result: content(result) };
      }
      if (tool.tool === 'browser.wait_for') {
        const budget = BrowserWaitArgumentsSchema.safeParse(args);
        if (!budget.success) return { jsonrpc: '2.0', id, result: toolError(refusal(budget.error)) };
        const rest = Object.entries(withoutUnsetFlags(args)).filter(([key]) => key !== 'timeoutMs');
        const probe = AgentToolCallSchema.safeParse({ ...Object.fromEntries(rest), tool: tool.tool });
        if (!probe.success) return { jsonrpc: '2.0', id, result: toolError(refusal(probe.error)) };
        if (probe.data.tool !== 'browser.wait_for') throw new Error('browser_wait_for is browser.wait_for');
        const result = await this.tools.browserWait({
          call: probe.data,
          totalMs: budget.data.timeoutMs ?? AGENT_TOOL_DEFAULT_WAIT_MS,
        });
        return { jsonrpc: '2.0', id, result: content(result) };
      }
      const call = AgentToolCallSchema.safeParse({ ...withoutUnsetFlags(args), tool: tool.tool });
      if (!call.success) return { jsonrpc: '2.0', id, result: toolError(refusal(call.error)) };
      return { jsonrpc: '2.0', id, result: content(await this.tools.call(call.data)) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: toolError(error instanceof Error ? error.message : String(error)) };
    }
  }

  private async config(
    id: string | number,
    tool: AgentConfigToolCall['tool'],
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const call = AgentConfigToolCallSchema.safeParse({ ...args, tool });
    if (!call.success) return { jsonrpc: '2.0', id, result: toolError(refusal(call.error)) };
    try {
      return { jsonrpc: '2.0', id, result: configContent(await this.tools.config(call.data)) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: toolError(error instanceof Error ? error.message : String(error)) };
    }
  }

  private async search(id: string | number, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const call = SearchArgumentsSchema.safeParse(args);
    if (!call.success) return { jsonrpc: '2.0', id, result: toolError(refusal(call.error)) };
    const { query, kind, open, all } = call.data;
    try {
      const answer = await this.tools.search({
        q: query,
        ...(kind === undefined ? {} : { kind }),
        open: open === true,
        all: all === true,
      });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: renderSearch(query, kind, answer) }] } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: toolError(error instanceof Error ? error.message : String(error)) };
    }
  }

  private async lessons(
    id: string | number,
    tool: AgentLessonToolCall['tool'],
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const call = AgentLessonToolCallSchema.safeParse({ ...args, tool });
    if (!call.success) return { jsonrpc: '2.0', id, result: toolError(refusal(call.error)) };
    try {
      return { jsonrpc: '2.0', id, result: lessonContent(await this.tools.lessons(call.data)) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: toolError(error instanceof Error ? error.message : String(error)) };
    }
  }
}
