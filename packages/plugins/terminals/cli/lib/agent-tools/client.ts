import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { AGENT_TOOL_MAX_WAIT_MS } from '../../../contract/index.ts';
import { type SurfaceControlView, SurfaceControlViewSchema } from '../protocol/surface-control.ts';

/**
 * The terminal verbs' one way to the daemon (today's `agent-tools/client.ts`, terminal half).
 *
 * TWO CALLERS, TWO ROADS. Named with `--ferret`, the verb is a PERSON acting on that ferret's terminals, through the
 * declared route `POST /v1/ferrets/:ferretId/surfaces/terminals/tools`. Unnamed, it is the ferret this runs inside,
 * calling its own agent tool (`terminal_open`, …), which the shell's tool client dispatches.
 */

/** The longest a `terminal wait` may wait in all; the daemon is asked in slices it can hold open. */
export const TERMINAL_MAX_TOTAL_WAIT_MS = 120_000;

const ROUTES = {
  tools: 'POST /v1/ferrets/:ferretId/surfaces/terminals/tools',
  controlView: 'GET /v1/ferrets/:ferretId/surfaces/terminals/control',
  control: 'POST /v1/ferrets/:ferretId/surfaces/terminals/control',
} as const;

export type TerminalToolName =
  | 'terminal_list'
  | 'terminal_open'
  | 'terminal_send'
  | 'terminal_read'
  | 'terminal_wait'
  | 'terminal_close'
  | 'terminal_ask_owner';

/** What the shell's tool client offers a half (`ToolClient.call`), when it offers one. */
export interface ToolCaller {
  tool(name: string, input: unknown): Promise<unknown>;
}

const callsTools = (client: PluginClient): client is PluginClient & ToolCaller =>
  typeof (client as Partial<ToolCaller>).tool === 'function';

class TerminalToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalToolsError';
  }
}

const SurfaceLineSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  available: z.boolean().optional(),
});

/** A tool's own answer (the daemon's `AgentToolResult`): a sentence, what is open, and what it read. */
const ToolReportSchema = z.looseObject({
  summary: z.string(),
  output: z.string().optional(),
  surfaces: z.array(SurfaceLineSchema).optional(),
  matched: z.boolean().optional(),
});
export type ToolReport = z.infer<typeof ToolReportSchema>;

/** The kernel's `ToolResult` (text already masked), whose `data` is the tool's report when it gave one. */
const ToolAnswerSchema = z.looseObject({
  text: z.string(),
  isError: z.boolean().optional(),
  data: z.unknown().optional(),
});

/** One answer, as a report the verbs can render, read from either a `ToolResult` or a bare report. */
function readAnswer(answer: unknown): { readonly report: ToolReport; readonly isError: boolean } {
  const kernel = ToolAnswerSchema.safeParse(answer);
  if (kernel.success) {
    const data = ToolReportSchema.safeParse(kernel.data.data);
    return {
      report: data.success ? data.data : { summary: kernel.data.text },
      isError: kernel.data.isError === true,
    };
  }
  const bare = ToolReportSchema.safeParse(answer);
  if (bare.success) return { report: bare.data, isError: false };
  throw new TerminalToolsError('the daemon answered a terminal tool in a shape this build does not read');
}

export interface TerminalWait {
  readonly name: string;
  readonly text?: string;
  readonly exit?: true;
  readonly totalMs: number;
}

export class TerminalToolsClient {
  constructor(private readonly client: PluginClient) {}

  /** One tool call. `ferret` names the ferret a person acts on; absent, the caller is the ferret itself. */
  async call(
    tool: TerminalToolName,
    input: Readonly<Record<string, unknown>>,
    ferret?: string,
  ): Promise<{ readonly report: ToolReport; readonly isError: boolean }> {
    if (ferret !== undefined)
      return readAnswer(
        await this.client.call(ROUTES.tools, { params: { ferretId: ferret }, body: { tool, ...input } }),
      );
    if (!callsTools(this.client))
      throw new TerminalToolsError(
        'this build cannot call a ferret’s own terminal tools from the command line yet: pass --ferret <id> to act on a ferret’s terminals yourself',
      );
    return readAnswer(await this.client.tool(tool, input));
  }

  /**
   * Waits up to `totalMs` for text or for the running command to end, asking the daemon in slices of at most
   * {@link AGENT_TOOL_MAX_WAIT_MS} so no single request outlives the daemon's idle timeout.
   */
  async wait(wait: TerminalWait, ferret?: string): Promise<{ readonly report: ToolReport; readonly isError: boolean }> {
    let remaining = Math.min(Math.max(wait.totalMs, 100), TERMINAL_MAX_TOTAL_WAIT_MS);
    for (;;) {
      const slice = Math.min(remaining, AGENT_TOOL_MAX_WAIT_MS);
      remaining -= slice;
      const answer = await this.call(
        'terminal_wait',
        {
          name: wait.name,
          ...(wait.text === undefined ? { exit: true } : { text: wait.text }),
          timeoutMs: Math.max(slice, 100),
        },
        ferret,
      );
      if (answer.isError || answer.report.matched === true || remaining <= 0) return answer;
    }
  }

  /** A person takes a terminal over from the ferret, hands it back, or hands one over. */
  async control(
    action: 'takeover' | 'handback' | 'handover',
    key: string,
    ferret: string,
  ): Promise<SurfaceControlView> {
    return SurfaceControlViewSchema.parse(
      await this.client.call(ROUTES.control, { params: { ferretId: ferret }, body: { action, key } }),
    );
  }

  /** Who drives which of a ferret's terminals, and what a person holds. */
  async view(ferret: string): Promise<SurfaceControlView> {
    return SurfaceControlViewSchema.parse(await this.client.call(ROUTES.controlView, { params: { ferretId: ferret } }));
  }
}
