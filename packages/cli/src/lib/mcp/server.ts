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
} from '@ferretry/protocol';
import { z } from 'zod';
import type { TerminalWait } from '../agent-tools/client.ts';
import { renderToolResult } from '../agent-tools/controller.ts';
import { instructionsReport, renderInstructionsReport } from '../instructions/report.ts';
import { MCP_CONFIG_TOOLS, MCP_INSTRUCTIONS_TOOL, MCP_LESSON_TOOLS, MCP_TOOLS } from './tools.ts';

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
  /** One `config.*` call, as the agent (docs/config-files.md). */
  config(call: AgentConfigToolCall): Promise<AgentConfigToolResult>;
  /** One `lessons.suggest` call, as the agent (docs/learning.md). */
  lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult>;
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
const ON_ONLY_FLAGS: ReadonlySet<string> = new Set(['incognito', 'double', 'submit', 'slowly', 'boxes', 'fullPage']);

function withoutUnsetFlags(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => !(ON_ONLY_FLAGS.has(key) && value === false)),
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
            tools: [...MCP_TOOLS, ...MCP_CONFIG_TOOLS, ...MCP_LESSON_TOOLS, MCP_INSTRUCTIONS_TOOL].map(
              ({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              }),
            ),
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
