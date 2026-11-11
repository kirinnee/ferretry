import { z } from 'zod';
import { AGENT_TOOL_MAX_TOTAL_WAIT_MS, MCP_TOOLS } from './tools.ts';

/**
 * THE FERRETRY TOOLS AS AN MCP SERVER — JSON-RPC 2.0 over stdio, written out by hand (ported from v4).
 *
 * The protocol surface a tools-only server needs is small — `initialize`, `ping`, `tools/list`,
 * `tools/call` and the notifications a client sends — so it is implemented here rather than pulled
 * in as a dependency: every byte this server reads is from the agent, and every call it makes goes to
 * the daemon as the agent, so a small surface that is all in view is the property worth having.
 *
 * WHO IT ACTS AS. It holds no authority of its own. Each tool call goes to the daemon's tool door with the session
 * credential the daemon delivered into this agent's environment, and the daemon derives the caller from that
 * credential alone. Nothing a model puts in a tool's arguments can name another session.
 *
 * WHAT A FAILURE LOOKS LIKE. A refused or failed tool call is a RESULT with `isError: true` and the
 * daemon's own plain sentence — "A person has taken over %terminal:dev; wait or ask them." — because
 * the model has to read it and act on it. Only a malformed request, an unknown method or an unknown
 * tool is a JSON-RPC error.
 */

/** Newest first; the first is what a client that asks for something else is offered. */
const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** A tool's answer, as the kernel's tool door gives it (`ToolResult`): text already masked for a model. */
export interface McpToolResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly data?: unknown;
}

/** What the server needs from the daemon: one tool call, by name, with its arguments. */
export interface McpToolsPort {
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult>;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  /** What every agent is told about these tools when it connects (MCP `initialize` instructions): one line. */
  readonly instructions?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ConfigAnswerSchema = z.looseObject({
  summary: z.string(),
  text: z.string().optional(),
  etag: z.string().optional(),
  issues: z
    .array(
      z.looseObject({
        path: z.string(),
        line: z.number().optional(),
        column: z.number().optional(),
        severity: z.string(),
        message: z.string(),
        fix: z.string(),
      }),
    )
    .optional(),
  files: z.array(z.looseObject({ path: z.string(), state: z.string() })).optional(),
});

/** A config tool's answer as text: the sentence, the file, then each located problem (v4's `configContent`). */
function configText(result: McpToolResult): string {
  const answer = ConfigAnswerSchema.safeParse(result.data);
  if (!answer.success) return result.text;
  const config = answer.data;
  return [
    config.summary,
    ...(config.etag === undefined ? [] : [`etag: ${config.etag}`]),
    ...(config.files ?? []).map(file => `${file.path} (${file.state})`),
    ...(config.issues ?? []).map(
      issue =>
        `${issue.path}${issue.line === undefined ? '' : `:${String(issue.line)}:${String(issue.column ?? 0)}`} ${issue.severity}: ${issue.message} — fix: ${issue.fix}`,
    ),
    ...(config.text === undefined ? [] : [config.text]),
  ].join('\n');
}

const PictureSchema = z.object({ mime: z.string(), base64: z.string() });

/** A tool's answer as MCP content: the words, then the picture when there is one; `isError` carried. */
function content(name: string, result: McpToolResult) {
  const picture = isRecord(result.data) ? PictureSchema.safeParse(result.data.picture) : undefined;
  return {
    content: [
      { type: 'text', text: name.startsWith('config_') ? configText(result) : result.text },
      ...(picture?.success === true ? [{ type: 'image', data: picture.data.base64, mimeType: picture.data.mime }] : []),
    ],
    ...(result.isError === true ? { isError: true } : {}),
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
            tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
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
    const { name } = parsed.data;
    const args = parsed.data.arguments ?? {};
    if (!MCP_TOOLS.some(candidate => candidate.name === name))
      return failure(id, JSON_RPC_ERRORS.invalidParams, `there is no tool ${name}`);
    const answer = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    try {
      if (name === 'terminal_wait') {
        const wait = WaitArgumentsSchema.safeParse(args);
        if (!wait.success) return answer(toolError(refusal(wait.error)));
        return answer(content(name, await this.tools.call(name, wait.data)));
      }
      if (name === 'browser_wait_for') {
        const budget = BrowserWaitArgumentsSchema.safeParse(args);
        if (!budget.success) return answer(toolError(refusal(budget.error)));
        return answer(content(name, await this.tools.call(name, withoutUnsetFlags(args))));
      }
      return answer(content(name, await this.tools.call(name, withoutUnsetFlags(args))));
    } catch (error) {
      return answer(toolError(error instanceof Error ? error.message : String(error)));
    }
  }
}
