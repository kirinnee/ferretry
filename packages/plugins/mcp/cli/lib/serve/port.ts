import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { McpToolResult, McpToolsPort } from './server.ts';
import { AGENT_TOOL_DEFAULT_WAIT_MS, AGENT_TOOL_MAX_TOTAL_WAIT_MS, AGENT_TOOL_MAX_WAIT_MS } from './tools.ts';

/** The kernel's `ToolResult`, as the tool door answers it. Loose: a field the door adds later is not this port's to refuse. */
const ToolResultSchema = z.looseObject({
  text: z.string(),
  isError: z.boolean().optional(),
  data: z.unknown().optional(),
});

const matchedOf = (result: McpToolResult): boolean | undefined => {
  const data = result.data;
  if (typeof data !== 'object' || data === null || !('matched' in data)) return undefined;
  return typeof data.matched === 'boolean' ? data.matched : undefined;
};

/**
 * The tools server's one way to the daemon: `ctx.client.tool` over the kernel tool door (`POST /v1/agent/tools`).
 *
 * WAITS. The daemon holds one wait open for at most {@link AGENT_TOOL_MAX_WAIT_MS} (so no request outlives the
 * transport's timeout), while a model may ask for up to {@link AGENT_TOOL_MAX_TOTAL_WAIT_MS}. `terminal_wait` and
 * `browser_wait_for` are therefore asked in slices until the thing happened or the budget is spent (v4's
 * `agent-tools/client.ts` loops, unchanged in behaviour).
 */
export function clientToolsPort(client: PluginClient): McpToolsPort {
  const once = async (name: string, args: Readonly<Record<string, unknown>>): Promise<McpToolResult> => {
    if (client.tool === undefined) throw new Error('this build cannot reach the daemon’s tool door');
    const answer = ToolResultSchema.safeParse(await client.tool(name, args));
    if (!answer.success) throw new Error(`the daemon answered ${name} in a shape this build does not read`);
    return answer.data;
  };

  const sliced = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
    done: (result: McpToolResult) => boolean,
  ): Promise<McpToolResult> => {
    const { timeoutMs, ...rest } = args;
    let remaining = Math.min(
      Math.max(typeof timeoutMs === 'number' ? timeoutMs : AGENT_TOOL_DEFAULT_WAIT_MS, 100),
      AGENT_TOOL_MAX_TOTAL_WAIT_MS,
    );
    for (;;) {
      const slice = Math.min(remaining, AGENT_TOOL_MAX_WAIT_MS);
      remaining -= slice;
      const result = await once(name, { ...rest, timeoutMs: Math.max(slice, 100) });
      if (result.isError === true || remaining <= 0 || done(result)) return result;
    }
  };

  return {
    async call(name, args) {
      if (name === 'terminal_wait') return await sliced(name, args, result => matchedOf(result) === true);
      // A `time` wait is a plain sleep: asked once. Any other page wait is over when it did not report "not yet".
      if (name === 'browser_wait_for' && args.time === undefined)
        return await sliced(name, args, result => matchedOf(result) !== false);
      return await once(name, args);
    },
  };
}
